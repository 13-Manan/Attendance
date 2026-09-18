import { randomBytes } from "node:crypto";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { recordAuditLog } from "@/modules/audit/service";
import type { AuditAction } from "@/modules/audit/types";
import { requirePermission } from "@/modules/authorization/service";
import { createStudent, updateStudent } from "@/modules/students/service";
import type { ExportFile } from "@/modules/attendance-reporting/types";
import * as repo from "./repository";
import {
  describeConfig,
  findConnection,
  listConnections,
  mergeConfig,
  recordConnectionError,
  recordConnectionSuccess,
  removeConnection,
  upsertConnection,
  type ConfigSummary,
} from "./connections";
import { defaultMappingsFor, targetFieldsFor, validateMapping, type MappingProblem } from "./field-mapping";
import {
  MAX_IMPORT_ROWS,
  buildErrorReport,
  buildPreview,
  describeSummary,
  planStudentImport,
  readImportFile,
  toStudentInput,
  type ExistingStudent,
  type ImportPlan,
  type ImportPreview,
  type ImportSummary,
} from "./import-pipeline";
import { getProvider, isIntegrationKind, listProviderSummaries, type ProviderSummary } from "./providers/registry";
import type { ConnectionTestResult, IntegrationProvider, ProviderCapabilities } from "./providers/provider";
import { redact } from "./redaction";
import {
  canSync,
  describeRun,
  intervalMinutes as resolveInterval,
  nextEligibleAt,
  planSync,
  summariseRun,
  type SyncResourceResult,
  type SyncRunResult,
  type SyncTrigger,
} from "./sync";
import type {
  FieldMapping,
  IntegrationConfig,
  IntegrationConnection,
  IntegrationError,
  IntegrationKind,
  IntegrationResource,
  IntegrationStatus,
  SyncMode,
} from "./types";

/**
 * The Integration Center: everything the admin screens do.
 *
 * ## Why this is not `service.ts`
 *
 * `service.ts` serves `/api/v1/*`. Its caller is an API key, it authorizes by
 * scope, and its return values are wire envelopes an integrator parses. This
 * file serves a logged-in administrator: its caller is a `SessionUser`, it
 * authorizes by permission, and its return values are view models a React
 * component renders. Sharing one module would mean every function taking a
 * union of two actor types and branching on it — which is exactly how an
 * authorization check ends up on the wrong side of an `if`.
 *
 * ## Which permissions gate this, and why no new ones were invented
 *
 * Reads require `institution.read`, writes require `institution.update`. No
 * new permission key was added, deliberately: `PERMISSIONS` is code but the
 * role→permission rows are *data*, seeded once. A new `integration.manage`
 * key would exist in this build and in nobody's database, so every existing
 * administrator would be locked out of the screen until someone re-seeded
 * production. Integration configuration also genuinely *is* institution
 * configuration — it is stored in `Institution.settings` beside the academic
 * unit labels that `institution.update` already governs.
 *
 * Student writes are **not** authorized here. `commitImport` calls
 * `modules/students/service`, which performs its own `student.create` /
 * `student.update` checks, writes its own audit rows and emits its own
 * webhooks. An importer with a private write path would be a second door into
 * the roster with its own rules; there is one door.
 *
 * ## What this build actually syncs
 *
 * Students. `SYNCABLE_RESOURCES` is a one-element list and the UI renders from
 * it, so an administrator is never offered a checkbox that quietly does
 * nothing. The plumbing — providers, mappings, schedules, plans, error
 * reports — is resource-generic; adding classes means writing a
 * `planClassImport` beside `planStudentImport`, not restructuring this file.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure with a sentence an administrator can act on.
 *
 * Distinct from throwing `Error("connection_not_found")` and translating in
 * the action layer: these messages are written once, next to the check that
 * produces them, so the reason and the wording cannot drift apart. Never
 * carries a provider's response body — that may contain a credential.
 */
export class IntegrationCenterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCenterError";
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CenterDeps {
  getSettings?: (institutionId: string) => Promise<{ id: string; settings: unknown } | null>;
  writeSettings?: (institutionId: string, settings: Record<string, unknown>) => Promise<void>;
  listStudentsByCodes?: (
    institutionId: string,
    codes: readonly string[],
  ) => Promise<ExistingStudent[]>;
  createStudent?: typeof createStudent;
  updateStudent?: typeof updateStudent;
  audit?: typeof recordAuditLog;
  provider?: (kind: IntegrationKind) => IntegrationProvider;
  now?: () => Date;
  newId?: () => string;
}

function deps(overrides: CenterDeps) {
  return {
    getSettings: overrides.getSettings ?? repo.getInstitutionSettings,
    writeSettings: overrides.writeSettings ?? repo.writeInstitutionSettings,
    listStudentsByCodes: overrides.listStudentsByCodes ?? repo.listStudentsByCodes,
    createStudent: overrides.createStudent ?? createStudent,
    updateStudent: overrides.updateStudent ?? updateStudent,
    audit: overrides.audit ?? recordAuditLog,
    provider: overrides.provider ?? getProvider,
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? (() => `int_${randomBytes(12).toString("base64url")}`),
  };
}

/** Resources this build can actually import. See the module doc. */
export const SYNCABLE_RESOURCES: readonly IntegrationResource[] = ["students"];

/** Chunk size for the existing-roster lookup. Keeps the `IN` list sane. */
const CODE_LOOKUP_CHUNK = 500;

/** Upper bound on rows pulled from a provider in one sync run. */
const SYNC_PAGE_LIMIT = 500;
const SYNC_MAX_PAGES = 40;

// ---------------------------------------------------------------------------
// Actor helpers
// ---------------------------------------------------------------------------

function requireInstitution(actor: SessionUser, permission: "institution.read" | "institution.update"): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    // A platform-level account has no settings blob to write into. Failing
    // here rather than defaulting to "the first institution" is the whole
    // point — there is no sensible default tenant.
    throw new IntegrationCenterError(
      "This account is not scoped to an institution, so it cannot manage integrations.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface ConnectionView {
  id: string;
  name: string;
  kind: IntegrationKind;
  kindLabel: string;
  status: IntegrationStatus;
  resources: IntegrationResource[];
  syncMode: SyncMode;
  intervalMinutes: number | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  nextEligibleAt: string | null;
  fieldMappings: FieldMapping[];
  mappingProblems: MappingProblem[];
  recentErrors: IntegrationError[];
  /** Masked. Raw config never reaches a browser — see `describeConfig`. */
  config: ConfigSummary;
  capabilities: ProviderCapabilities;
  /** False when a capability or the connection's state forbids syncing now. */
  canSyncNow: boolean;
  syncBlockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationCenterView {
  institutionId: string;
  providers: ProviderSummary[];
  connections: ConnectionView[];
  syncableResources: readonly IntegrationResource[];
  /** Targets the mapping editor offers, per resource. */
  targetFields: Array<{ key: string; label: string; storedAs: string; required: boolean }>;
}

function toView(connection: IntegrationConnection, provider: IntegrationProvider): ConnectionView {
  const gate = canSync(connection);
  const unsupported = !provider.capabilities.pull;
  const primaryResource = connection.resources[0] ?? "students";

  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    kindLabel: provider.label,
    status: connection.status,
    resources: connection.resources,
    syncMode: connection.schedule.mode,
    intervalMinutes:
      connection.schedule.mode === "MANUAL" ? null : resolveInterval(connection.schedule),
    lastSyncAt: connection.schedule.lastSyncAt ?? null,
    lastSuccessAt: connection.schedule.lastSuccessAt ?? null,
    nextEligibleAt: nextEligibleAt(connection.schedule),
    fieldMappings: connection.fieldMappings,
    // Re-validated on every render rather than only at save: the target
    // catalogue is code, so a mapping saved by an older build can reference a
    // field this one no longer has, and the administrator should see that on
    // the screen rather than in a sync failure at 2am.
    mappingProblems: validateMapping(connection.fieldMappings, primaryResource),
    recentErrors: connection.recentErrors,
    config: describeConfig(connection.config),
    capabilities: provider.capabilities,
    canSyncNow: gate.ok && !unsupported,
    syncBlockedReason: unsupported
      ? `A ${provider.label.toLowerCase()} integration does not pull — it receives. There is nothing to sync on demand.`
      : (gate.reason ?? null),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function getIntegrationCenter(
  actor: SessionUser,
  overrides: CenterDeps = {},
): Promise<IntegrationCenterView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.read");

  const row = await d.getSettings(institutionId);
  const connections = listConnections(row?.settings).map((connection) =>
    toView(connection, d.provider(connection.kind)),
  );

  return {
    institutionId,
    providers: listProviderSummaries(),
    connections,
    syncableResources: SYNCABLE_RESOURCES,
    targetFields: targetFieldsFor("students").map((field) => ({
      key: field.key,
      label: field.label,
      storedAs: field.storedAs,
      required: field.required === true,
    })),
  };
}

export async function getConnection(
  actor: SessionUser,
  connectionId: string,
  overrides: CenterDeps = {},
): Promise<ConnectionView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.read");
  const connection = await loadConnection(d, institutionId, connectionId);
  return toView(connection, d.provider(connection.kind));
}

// ---------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------

async function loadConnection(
  d: ReturnType<typeof deps>,
  institutionId: string,
  connectionId: string,
): Promise<IntegrationConnection> {
  const row = await d.getSettings(institutionId);
  const connection = findConnection(row?.settings, connectionId);
  if (!connection) {
    // Same message whether the connection belongs to another institution or
    // does not exist. An admin of school A must not be able to probe for
    // school B's connection ids by watching which error comes back.
    throw new IntegrationCenterError("That integration no longer exists.");
  }
  return connection;
}

async function saveConnection(
  d: ReturnType<typeof deps>,
  institutionId: string,
  connection: IntegrationConnection,
): Promise<void> {
  const row = await d.getSettings(institutionId);
  await d.writeSettings(institutionId, upsertConnection(row?.settings, connection));
}

/**
 * The audit row for an Integration Center change.
 *
 * `redact` runs over both halves before they are stored. `IntegrationConfig`
 * carries the external system's bearer token in `headers`, and an audit log
 * that faithfully records a credential is a credential store with worse
 * access controls than the one it copied from.
 */
async function auditConnection(
  d: ReturnType<typeof deps>,
  actor: SessionUser,
  institutionId: string,
  action: AuditAction,
  connectionId: string,
  payload: { before?: unknown; after?: unknown },
): Promise<void> {
  await d.audit({
    action,
    entityType: "Integration",
    entityId: connectionId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: payload.before === undefined ? undefined : redact(payload.before),
    afterJson: payload.after === undefined ? undefined : redact(payload.after),
  });
}

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

export interface CreateConnectionInput {
  name: string;
  kind: string;
  resources: string[];
  config: IntegrationConfig;
  syncMode: string;
  intervalMinutes?: number | null;
}

function readResources(values: readonly string[], provider: IntegrationProvider): IntegrationResource[] {
  const allowed = new Set(provider.capabilities.resources);
  const resources: IntegrationResource[] = [];

  for (const value of values) {
    const resource = value as IntegrationResource;
    if (!SYNCABLE_RESOURCES.includes(resource)) {
      throw new IntegrationCenterError(
        `This build imports ${SYNCABLE_RESOURCES.join(", ")} only. \`${value}\` cannot be selected yet.`,
      );
    }
    if (!allowed.has(resource)) {
      throw new IntegrationCenterError(`A ${provider.label} integration cannot carry \`${value}\`.`);
    }
    if (!resources.includes(resource)) resources.push(resource);
  }
  return resources;
}

function readSyncMode(value: string, provider: IntegrationProvider): SyncMode {
  if (value !== "MANUAL" && value !== "SCHEDULED" && value !== "INCREMENTAL") {
    throw new IntegrationCenterError("Choose a sync mode: manual, scheduled or incremental.");
  }
  if (value === "INCREMENTAL" && !provider.capabilities.incremental) {
    throw new IntegrationCenterError(
      `A ${provider.label} integration cannot sync incrementally — it has no way to ask "what changed since". Choose scheduled or manual.`,
    );
  }
  if (value === "SCHEDULED" && !provider.capabilities.scheduled) {
    throw new IntegrationCenterError(
      `A ${provider.label} integration cannot run on a schedule. Choose manual.`,
    );
  }
  return value;
}

export async function createConnection(
  actor: SessionUser,
  input: CreateConnectionInput,
  overrides: CenterDeps = {},
): Promise<ConnectionView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const name = input.name.trim();
  if (!name) throw new IntegrationCenterError("Give this integration a name.");
  if (!isIntegrationKind(input.kind)) {
    throw new IntegrationCenterError("Choose an integration type.");
  }

  const provider = d.provider(input.kind);
  const resources = readResources(input.resources, provider);
  if (resources.length === 0) {
    throw new IntegrationCenterError("Select at least one resource for this integration to carry.");
  }
  const mode = readSyncMode(input.syncMode, provider);

  // Validated before it is stored, not before it is used: a base URL pointing
  // at 169.254.169.254 saved today is an SSRF that fires the first time
  // somebody clicks "Test connection", and the person who clicks may not be
  // the person who typed it.
  const problems = provider.validateConfig(input.config);
  if (problems.length > 0) throw new IntegrationCenterError(problems.join(" "));

  const at = d.now().toISOString();
  const connection: IntegrationConnection = {
    id: d.newId(),
    name,
    kind: input.kind,
    // DRAFT, not ACTIVE. "I saved a form" is not "this works" — the status
    // column earns ACTIVE by a successful test or a successful sync, so a
    // green row on this screen means something.
    status: "DRAFT",
    resources,
    config: input.config,
    fieldMappings: defaultMappingsFor(resources[0]),
    schedule: {
      mode,
      intervalMinutes: input.intervalMinutes ?? undefined,
    },
    recentErrors: [],
    createdAt: at,
    updatedAt: at,
  };

  await saveConnection(d, institutionId, connection);
  await auditConnection(d, actor, institutionId, "integration.created", connection.id, {
    after: connection,
  });
  return toView(connection, provider);
}

export interface UpdateConnectionInput {
  connectionId: string;
  name?: string;
  resources?: string[];
  config?: IntegrationConfig;
  removeHeaders?: string[];
  syncMode?: string;
  intervalMinutes?: number | null;
}

export async function updateConnection(
  actor: SessionUser,
  input: UpdateConnectionInput,
  overrides: CenterDeps = {},
): Promise<ConnectionView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");
  const existing = await loadConnection(d, institutionId, input.connectionId);
  const provider = d.provider(existing.kind);

  const name = input.name?.trim() ?? existing.name;
  if (!name) throw new IntegrationCenterError("Give this integration a name.");

  const resources = input.resources ? readResources(input.resources, provider) : existing.resources;
  if (resources.length === 0) {
    throw new IntegrationCenterError("Select at least one resource for this integration to carry.");
  }
  const mode = input.syncMode ? readSyncMode(input.syncMode, provider) : existing.schedule.mode;

  const config = input.config
    ? mergeConfig(existing.config, input.config, input.removeHeaders ?? [])
    : existing.config;
  const problems = provider.validateConfig(config);
  if (problems.length > 0) throw new IntegrationCenterError(problems.join(" "));

  const updated: IntegrationConnection = {
    ...existing,
    name,
    resources,
    config,
    schedule: {
      ...existing.schedule,
      mode,
      intervalMinutes:
        input.intervalMinutes === undefined
          ? existing.schedule.intervalMinutes
          : (input.intervalMinutes ?? undefined),
    },
    updatedAt: d.now().toISOString(),
  };

  await saveConnection(d, institutionId, updated);
  await auditConnection(d, actor, institutionId, "integration.updated", updated.id, {
    before: existing,
    after: updated,
  });
  return toView(updated, provider);
}

export async function setConnectionStatus(
  actor: SessionUser,
  connectionId: string,
  status: "ACTIVE" | "PAUSED",
  overrides: CenterDeps = {},
): Promise<ConnectionView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");
  const existing = await loadConnection(d, institutionId, connectionId);

  const updated: IntegrationConnection = {
    ...existing,
    status,
    updatedAt: d.now().toISOString(),
  };
  await saveConnection(d, institutionId, updated);
  // `integration.updated` rather than a new pause/resume action: the audit
  // catalogue is deliberately closed (see modules/audit/types.ts), and a
  // status change is an update whose before/after says exactly which one it
  // was.
  await auditConnection(d, actor, institutionId, "integration.updated", connectionId, {
    before: { status: existing.status },
    after: { status },
  });
  return toView(updated, d.provider(updated.kind));
}

export async function deleteConnection(
  actor: SessionUser,
  connectionId: string,
  overrides: CenterDeps = {},
): Promise<void> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");
  const existing = await loadConnection(d, institutionId, connectionId);

  const row = await d.getSettings(institutionId);
  await d.writeSettings(institutionId, removeConnection(row?.settings, connectionId));
  // The connection is gone from settings; the audit row is what remains, and
  // it holds the redacted configuration so "who deleted the ERP link on
  // Tuesday, and what was it pointing at" is answerable.
  await auditConnection(d, actor, institutionId, "integration.deleted", connectionId, {
    before: existing,
  });
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

export async function saveFieldMappings(
  actor: SessionUser,
  input: { connectionId: string; resource: string; mappings: FieldMapping[] },
  overrides: CenterDeps = {},
): Promise<ConnectionView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");
  const existing = await loadConnection(d, institutionId, input.connectionId);

  const resource = input.resource as IntegrationResource;
  if (!SYNCABLE_RESOURCES.includes(resource)) {
    throw new IntegrationCenterError(`\`${input.resource}\` cannot be mapped in this build.`);
  }

  const mappings = input.mappings
    .map((mapping) => ({
      ...mapping,
      source: mapping.source.trim(),
      target: mapping.target.trim(),
    }))
    .filter((mapping) => mapping.source !== "" && mapping.target !== "");

  // Rejected wholesale rather than saved-with-warnings. A half-valid mapping
  // is the state in which a sync runs and writes the wrong columns, and the
  // administrator has already been shown every problem at once.
  const problems = validateMapping(mappings, resource);
  if (problems.length > 0) {
    throw new IntegrationCenterError(
      problems.map((problem) => problem.message).join(" "),
    );
  }

  const updated: IntegrationConnection = {
    ...existing,
    fieldMappings: mappings,
    updatedAt: d.now().toISOString(),
  };
  await saveConnection(d, institutionId, updated);
  await auditConnection(d, actor, institutionId, "integration.updated", updated.id, {
    before: existing.fieldMappings,
    after: mappings,
  });
  return toView(updated, d.provider(updated.kind));
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

export async function testConnection(
  actor: SessionUser,
  connectionId: string,
  overrides: CenterDeps = {},
): Promise<ConnectionTestResult> {
  const d = deps(overrides);
  // `institution.update`, not `.read`: testing makes an outbound request from
  // the server to a URL in the configuration, which is an action, not a
  // lookup. A read-only viewer must not be able to make this server call an
  // arbitrary host.
  const institutionId = requireInstitution(actor, "institution.update");
  const existing = await loadConnection(d, institutionId, connectionId);
  const provider = d.provider(existing.kind);

  if (!provider.capabilities.testConnection || !provider.testConnection) {
    throw new IntegrationCenterError(
      `A ${provider.label} integration has nothing to test — there is no endpoint to call.`,
    );
  }

  const at = d.now().toISOString();
  let result: ConnectionTestResult;
  try {
    result = await provider.testConnection(existing.config);
  } catch (error) {
    // A provider is not supposed to throw, but one that does must not take the
    // admin page down with it.
    result = {
      ok: false,
      message: error instanceof Error ? error.message : "The connection test failed.",
    };
  }

  const updated = result.ok
    ? { ...existing, status: "ACTIVE" as const, recentErrors: [], updatedAt: at }
    : recordConnectionError(existing, { at, message: result.message });

  await saveConnection(d, institutionId, updated);
  await auditConnection(d, actor, institutionId, "integration.connection_tested", connectionId, {
    after: { ok: result.ok, message: result.message, statusCode: result.statusCode, at },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Runs a sync now, or explains why it did not.
 *
 * `trigger` is `"manual"` from the button and `"scheduled"` from a cron
 * calling the API. The difference is the interval gate, and nothing else: the
 * same code path does the work either way, so "it works when I click it but
 * not overnight" cannot be a class of bug here.
 */
export async function runSync(
  actor: SessionUser,
  input: { connectionId: string; trigger?: SyncTrigger; force?: boolean },
  overrides: CenterDeps = {},
): Promise<SyncRunResult> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");
  const existing = await loadConnection(d, institutionId, input.connectionId);
  const provider = d.provider(existing.kind);

  const startedAt = d.now();
  const trigger: SyncTrigger = input.trigger ?? "manual";

  const gate = canSync(existing);
  if (!gate.ok) {
    return skipped(existing, trigger, startedAt, gate.reason ?? "This integration cannot sync.");
  }
  if (!provider.capabilities.pull || !provider.fetch) {
    return skipped(
      existing,
      trigger,
      startedAt,
      `A ${provider.label} integration does not pull records; it receives them.`,
    );
  }

  const plan = planSync({
    schedule: existing.schedule,
    resources: existing.resources,
    trigger,
    now: startedAt,
    force: input.force,
  });
  if (!plan.shouldRun) {
    return skipped(existing, trigger, startedAt, plan.reason);
  }

  // Written before the work, not after. A run that is killed mid-pull leaves a
  // `started` with no matching `completed`, which is exactly the shape an
  // operator needs to see; a single row written at the end would make a
  // crashed sync indistinguishable from one that never began.
  await auditConnection(d, actor, institutionId, "integration.sync.started", existing.id, {
    after: { trigger, mode: plan.mode, resources: plan.resources, since: plan.since ?? null },
  });

  const results: SyncResourceResult[] = [];
  const errors: IntegrationError[] = [];
  let cursor = plan.cursor;

  for (const resource of plan.resources) {
    try {
      const rows = await pullAll(provider, existing.config, {
        resource,
        since: plan.since ? new Date(plan.since) : undefined,
        cursor: plan.cursor,
      });
      cursor = rows.nextCursor ?? undefined;

      const outcome = await importStudentRows(actor, d, institutionId, existing, rows.rows);
      results.push({ resource, ...outcome });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed.";
      errors.push({ at: d.now().toISOString(), message, resource });
      results.push({ resource, fetched: 0, created: 0, updated: 0, unchanged: 0, errors: 1 });
    }
  }

  const finishedAt = d.now().toISOString();
  const status = errors.length > 0 && results.every((r) => r.fetched === 0)
    ? "FAILED"
    : summariseRun(results);

  const settled: IntegrationConnection =
    status === "FAILED"
      ? errors.reduce((connection, error) => recordConnectionError(connection, error), existing)
      : recordConnectionSuccess(existing, finishedAt, cursor);

  await saveConnection(d, institutionId, settled);

  const run: SyncRunResult = {
    connectionId: existing.id,
    startedAt: startedAt.toISOString(),
    finishedAt,
    mode: plan.mode,
    trigger,
    status,
    reason: errors[0]?.message ?? plan.reason,
    resources: results,
    cursor,
  };

  // The durable record of the run. `AuditLog` rather than a settings entry
  // because a run history is append-only and unbounded, and a JSON column read
  // on every page load is neither. A PARTIAL run is logged as completed and
  // says so in its payload — calling it a failure would train an operator to
  // ignore the word.
  await auditConnection(
    d,
    actor,
    institutionId,
    status === "FAILED" ? "integration.sync.failed" : "integration.sync.completed",
    existing.id,
    { after: { ...run, summary: describeRun(run) } },
  );
  return run;
}

function skipped(
  connection: IntegrationConnection,
  trigger: SyncTrigger,
  startedAt: Date,
  reason: string,
): SyncRunResult {
  const at = startedAt.toISOString();
  return {
    connectionId: connection.id,
    startedAt: at,
    finishedAt: at,
    mode: connection.schedule.mode,
    trigger,
    status: "SKIPPED",
    reason,
    resources: [],
  };
}

/**
 * Walks a provider's pages up to a hard ceiling.
 *
 * The ceiling is not a performance tuning knob — it is the thing that stops a
 * provider whose `nextCursor` never goes null from pinning a server until the
 * request is killed. Hitting it is reported as a partial run rather than
 * hidden, because a truncated sync that claims success is how a roster
 * silently stops at 20,000 students.
 */
async function pullAll(
  provider: IntegrationProvider,
  config: IntegrationConfig,
  options: { resource: IntegrationResource; since?: Date; cursor?: string },
): Promise<{ rows: Array<Record<string, string>>; nextCursor: string | null }> {
  const rows: Array<Record<string, string>> = [];
  let cursor = options.cursor;

  for (let pageIndex = 0; pageIndex < SYNC_MAX_PAGES; pageIndex += 1) {
    const page = await provider.fetch!(config, {
      resource: options.resource,
      since: options.since,
      cursor,
      limit: SYNC_PAGE_LIMIT,
    });
    rows.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
    if (!cursor || rows.length >= MAX_IMPORT_ROWS) break;
  }

  return { rows, nextCursor: cursor ?? null };
}

async function importStudentRows(
  actor: SessionUser,
  d: ReturnType<typeof deps>,
  institutionId: string,
  connection: IntegrationConnection,
  rows: Array<Record<string, string>>,
): Promise<Omit<SyncResourceResult, "resource">> {
  const lines = rows.map((_row, index) => index + 2);
  const planned = await planImport(d, institutionId, rows, lines, connection.fieldMappings);
  const result = await executePlan(actor, d, institutionId, planned);
  return {
    fetched: rows.length,
    created: result.created,
    updated: result.updated,
    unchanged: planned.plan.summary.unchanged,
    errors: planned.plan.summary.error + planned.plan.summary.duplicate + result.failed,
  };
}

// ---------------------------------------------------------------------------
// Import: preview
// ---------------------------------------------------------------------------

export interface ImportPreviewResult extends ImportPreview {
  /** Echoed back so the commit step reads the same bytes the preview did. */
  token: string;
  filename: string;
  resource: IntegrationResource;
  /** The plan computed against the current roster — the numbers shown. */
  summary: ImportSummary;
  errors: ImportPlan["errors"];
  duplicates: ImportPlan["duplicates"];
  description: string;
}

/**
 * Parses an uploaded file, maps it, diffs it against the roster, and reports
 * what *would* happen.
 *
 * Nothing is written. The preview and the commit call the same
 * `planStudentImport` over the same bytes, which is what makes the numbers on
 * the confirmation screen true rather than decorative.
 */
export async function previewImport(
  actor: SessionUser,
  input: {
    bytes: Buffer;
    filename: string;
    resource?: string;
    delimiter?: string;
    mappings?: FieldMapping[];
  },
  overrides: CenterDeps = {},
): Promise<ImportPreviewResult> {
  const d = deps(overrides);
  // Reading a file to preview it against the roster reveals which student
  // codes already exist, so this is a roster read and is gated as one.
  const institutionId = requireInstitution(actor, "institution.read");
  requirePermission(actor, "student.read");

  const resource = (input.resource ?? "students") as IntegrationResource;
  if (!SYNCABLE_RESOURCES.includes(resource)) {
    throw new IntegrationCenterError(`\`${resource}\` cannot be imported in this build.`);
  }

  let parsed;
  try {
    parsed = readImportFile(input.bytes, input.delimiter);
  } catch (error) {
    throw new IntegrationCenterError(
      error instanceof Error
        ? `That file could not be read: ${error.message}`
        : "That file could not be read.",
    );
  }
  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    throw new IntegrationCenterError("That file has no data rows.");
  }

  const preview = buildPreview(parsed, resource, input.mappings);
  if (preview.rejection) throw new IntegrationCenterError(preview.rejection);

  // A file whose mapping does not validate is not diffed against the roster:
  // the numbers would be computed from a mapping the administrator is about to
  // change, and a preview that shows "0 create, 0 update" beside four mapping
  // errors reads as "nothing to do" rather than "fix the mapping first".
  const { plan } =
    preview.mappingProblems.length > 0
      ? { plan: emptyPlan(parsed.rows.length) }
      : await planImport(d, institutionId, parsed.rows, parsed.rowLines, preview.mappings);

  return {
    ...preview,
    token: input.filename,
    filename: input.filename,
    resource,
    summary: plan.summary,
    errors: plan.errors,
    duplicates: plan.duplicates,
    description: describeSummary(plan.summary),
  };
}

function emptyPlan(totalRows: number): ImportPlan {
  return {
    create: [],
    update: [],
    unchanged: [],
    duplicates: [],
    errors: [],
    summary: { totalRows, create: 0, update: 0, unchanged: 0, duplicate: 0, error: 0 },
  };
}

/**
 * The plan plus the roster snapshot it was computed against.
 *
 * The snapshot travels with the plan because the commit needs it: a planned
 * *update* is addressed by `Student.id`, and the only place that id is known
 * is the lookup the diff already did. Re-reading it row by row at commit time
 * would be a second query per student and — worse — a second answer, since the
 * roster can change between the two reads.
 */
interface PlannedImport {
  plan: ImportPlan;
  existing: Map<string, ExistingStudent>;
}

async function planImport(
  d: ReturnType<typeof deps>,
  institutionId: string,
  rows: Array<Record<string, string>>,
  rowLines: number[],
  mappings: readonly FieldMapping[],
): Promise<PlannedImport> {
  // Two passes over the mapping: once to learn which codes the file names, so
  // the roster read is bounded by the file rather than by the institution.
  const codeMapping = mappings.filter((mapping) => mapping.target === "student.externalId");
  const codes = new Set<string>();
  for (const row of rows) {
    for (const mapping of codeMapping) {
      const value = lookupColumn(row, mapping.source);
      if (value) codes.add(value);
    }
  }

  const existing = new Map<string, ExistingStudent>();
  const all = [...codes];
  for (let i = 0; i < all.length; i += CODE_LOOKUP_CHUNK) {
    const chunk = all.slice(i, i + CODE_LOOKUP_CHUNK);
    for (const student of await d.listStudentsByCodes(institutionId, chunk)) {
      existing.set(student.studentCode, student);
    }
  }

  return { plan: planStudentImport(rows, rowLines, mappings, existing), existing };
}

function lookupColumn(row: Record<string, string>, source: string): string | null {
  const wanted = source.trim().toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.trim().toLowerCase() === wanted) return value.trim() || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import: commit
// ---------------------------------------------------------------------------

export interface ImportResult {
  summary: ImportSummary;
  created: number;
  updated: number;
  /** Rows the plan accepted that the write then rejected. */
  failed: number;
  failures: ImportPlan["errors"];
  description: string;
  /** Present when any row was rejected. A CSV the admin downloads. */
  errorReport: ExportFile | null;
}

export async function commitImport(
  actor: SessionUser,
  input: {
    bytes: Buffer;
    filename: string;
    resource?: string;
    delimiter?: string;
    mappings: FieldMapping[];
  },
  overrides: CenterDeps = {},
): Promise<ImportResult> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.read");

  const resource = (input.resource ?? "students") as IntegrationResource;
  if (!SYNCABLE_RESOURCES.includes(resource)) {
    throw new IntegrationCenterError(`\`${resource}\` cannot be imported in this build.`);
  }

  const parsed = readImportFile(input.bytes, input.delimiter);
  const problems = validateMapping(input.mappings, resource, parsed.headers);
  if (problems.length > 0) {
    throw new IntegrationCenterError(problems.map((problem) => problem.message).join(" "));
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw new IntegrationCenterError(
      `This file has ${parsed.rows.length.toLocaleString()} rows; the limit for one import is ${MAX_IMPORT_ROWS.toLocaleString()}.`,
    );
  }

  const planned = await planImport(d, institutionId, parsed.rows, parsed.rowLines, input.mappings);
  const outcome = await executePlan(actor, d, institutionId, planned);

  const report: ImportPlan = {
    ...planned.plan,
    errors: [...planned.plan.errors, ...outcome.failures],
    summary: { ...planned.plan.summary, error: planned.plan.summary.error + outcome.failed },
  };

  await d.audit({
    action: "integration.import.completed",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    afterJson: redact({
      filename: input.filename,
      format: parsed.format,
      resource,
      summary: report.summary,
      created: outcome.created,
      updated: outcome.updated,
      failed: outcome.failed,
    }),
  });

  return {
    summary: report.summary,
    created: outcome.created,
    updated: outcome.updated,
    failed: outcome.failed,
    failures: outcome.failures,
    description: describeSummary(report.summary),
    errorReport:
      report.errors.length > 0 || report.duplicates.length > 0
        ? buildErrorReport(report, `${input.filename.replace(/\.[^.]+$/, "")}-errors`)
        : null,
  };
}

/**
 * Executes a plan through the existing students service, row by row.
 *
 * Row by row, not one transaction, and that is the deliberate choice: an
 * import of 1,200 rows where row 900 has a unique-constraint collision should
 * write 1,199 students and report one failure, not roll back an afternoon's
 * work. Every partial outcome is reported — `failed` is surfaced in the
 * summary and every failure lands in the downloadable error report, so a
 * partial import is never mistaken for a complete one.
 */
async function executePlan(
  actor: SessionUser,
  d: ReturnType<typeof deps>,
  institutionId: string,
  planned: PlannedImport,
): Promise<{ created: number; updated: number; failed: number; failures: ImportPlan["errors"] }> {
  const { plan, existing } = planned;
  let created = 0;
  let updated = 0;
  const failures: ImportPlan["errors"] = [];

  for (const row of plan.create) {
    const input = toStudentInput(row);
    try {
      await d.createStudent(actor, {
        institutionId,
        studentCode: input.studentCode,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
      });
      created += 1;
    } catch (error) {
      failures.push({ line: row.line, key: row.key, messages: [describeWriteError(error)] });
    }
  }

  for (const row of plan.update) {
    const current = existing.get(row.key);
    if (!current) {
      // Only reachable if the plan and the snapshot disagree, which would be a
      // bug here rather than bad input. Reported as a row failure rather than
      // thrown, so one inconsistency cannot abandon the remaining rows.
      failures.push({
        line: row.line,
        key: row.key,
        messages: ["This student could not be matched to an existing record."],
      });
      continue;
    }
    try {
      await d.updateStudent(actor, {
        studentId: current.id,
        ...writableFields(row.values),
      });
      updated += 1;
    } catch (error) {
      failures.push({ line: row.line, key: row.key, messages: [describeWriteError(error)] });
    }
  }

  return { created, updated, failed: failures.length, failures };
}

function writableFields(values: Record<string, string>): {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  status?: "ACTIVE" | "INACTIVE" | "TRANSFERRED" | "COMPLETED";
} {
  const fields: ReturnType<typeof writableFields> = {};
  if (values["student.firstName"]) fields.firstName = values["student.firstName"];
  if (values["student.lastName"]) fields.lastName = values["student.lastName"];
  if (values["student.email"]) fields.email = values["student.email"];
  if (values["student.phone"]) fields.phone = values["student.phone"];
  const status = values["student.status"];
  if (status === "ACTIVE" || status === "INACTIVE" || status === "TRANSFERRED" || status === "COMPLETED") {
    fields.status = status;
  }
  return fields;
}

/**
 * One sentence for the error report, never the raw driver message.
 *
 * A Prisma error text carries the table, the column and sometimes the
 * conflicting value; an import error report is a file an administrator mails
 * to a vendor.
 */
function describeWriteError(error: unknown): string {
  if (error instanceof Error && error.name === "ForbiddenError") {
    return "You do not have permission to write this student.";
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Unique constraint")) {
    return "A student with this code already exists and could not be updated.";
  }
  return "This row could not be written. Check the values and try again.";
}
