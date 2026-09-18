import { isIntegrationKind } from "./providers/registry";
import { targetField } from "./field-mapping";
import { REDACTED, isSensitiveKey } from "./redaction";
import {
  INTEGRATION_SETTINGS_KEY,
  type FieldMapping,
  type FieldTransform,
  type IntegrationConfig,
  type IntegrationConnection,
  type IntegrationError,
  type IntegrationResource,
  type IntegrationSettings,
  type IntegrationStatus,
  type SyncMode,
  type SyncSchedule,
} from "./types";

/**
 * Reading and writing the integrations bucket inside `Institution.settings`.
 *
 * ## Every function here is a total function over `unknown`
 *
 * The input is a JSON column. It was written by some version of this code,
 * possibly an older one, possibly a newer one after a rollback, possibly by
 * hand during an incident. Nothing here may throw on unexpected shape, and
 * nothing may assume a field exists because the TypeScript type says so — the
 * type describes what we write, not what we find.
 *
 * The rule applied throughout: a malformed *connection* is dropped, a
 * malformed *field within* a connection falls back to a safe default. Dropping
 * the whole bucket because one connection is corrupt would take an
 * institution's working integrations offline to punish a broken one.
 *
 * This is the same discipline `modules/offline-sync/idempotency.ts` applies to
 * `AttendanceSession.metadata`, for the same reason.
 *
 * Pure module. See connections.test.ts.
 */

const MAX_RECENT_ERRORS = 10;

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const STATUSES: ReadonlySet<string> = new Set(["DRAFT", "ACTIVE", "PAUSED", "ERROR"]);
const MODES: ReadonlySet<string> = new Set(["MANUAL", "SCHEDULED", "INCREMENTAL"]);
const RESOURCES: ReadonlySet<string> = new Set([
  "students",
  "classes",
  "sections",
  "programs",
  "subjects",
  "faculty",
  "enrollments",
  "attendance",
]);
const TRANSFORMS: ReadonlySet<string> = new Set([
  "trim",
  "uppercase",
  "lowercase",
  "digits_only",
  "date_dmy",
  "date_mdy",
  "date_iso",
]);

function decodeConfig(value: unknown): IntegrationConfig {
  const record = asRecord(value);
  if (!record) return {};
  const config: IntegrationConfig = {};

  if (typeof record.baseUrl === "string") config.baseUrl = record.baseUrl;
  if (typeof record.testPath === "string") config.testPath = record.testPath;
  if (typeof record.deliveryUrl === "string") config.deliveryUrl = record.deliveryUrl;
  if (typeof record.delimiter === "string") config.delimiter = record.delimiter;

  const headers = asRecord(record.headers);
  if (headers) {
    config.headers = Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  const paths = asRecord(record.resourcePaths);
  if (paths) {
    config.resourcePaths = Object.fromEntries(
      Object.entries(paths).filter(
        (entry): entry is [IntegrationResource, string] =>
          RESOURCES.has(entry[0]) && typeof entry[1] === "string",
      ),
    );
  }
  const extra = asRecord(record.extra);
  if (extra) config.extra = extra;

  return config;
}

function decodeMapping(value: unknown): FieldMapping | null {
  const record = asRecord(value);
  if (!record) return null;
  const source = asString(record.source).trim();
  const target = asString(record.target).trim();
  // A mapping naming a target this build no longer defines is dropped rather
  // than kept: keeping it would write values into a field nothing reads, and
  // the administrator would see a mapping row that does nothing.
  if (!source || !targetField(target)) return null;

  const mapping: FieldMapping = { source, target };
  if (typeof record.fallback === "string") mapping.fallback = record.fallback;
  if (typeof record.transform === "string" && TRANSFORMS.has(record.transform)) {
    mapping.transform = record.transform as FieldTransform;
  }
  return mapping;
}

function decodeSchedule(value: unknown): SyncSchedule {
  const record = asRecord(value);
  const mode = record && MODES.has(asString(record.mode)) ? (record.mode as SyncMode) : "MANUAL";
  const schedule: SyncSchedule = { mode };
  if (!record) return schedule;

  if (typeof record.intervalMinutes === "number" && Number.isFinite(record.intervalMinutes)) {
    // Floored at 5 minutes. A one-minute schedule against an external system
    // is a denial-of-service against that system wearing a cron hat, and no
    // roster changes that fast.
    schedule.intervalMinutes = Math.max(5, Math.floor(record.intervalMinutes));
  }
  if (typeof record.lastSyncAt === "string") schedule.lastSyncAt = record.lastSyncAt;
  if (typeof record.lastSuccessAt === "string") schedule.lastSuccessAt = record.lastSuccessAt;
  if (typeof record.cursor === "string") schedule.cursor = record.cursor;
  return schedule;
}

function decodeErrors(value: unknown): IntegrationError[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record || typeof record.at !== "string" || typeof record.message !== "string") return null;
      const error: IntegrationError = { at: record.at, message: record.message };
      if (typeof record.resource === "string" && RESOURCES.has(record.resource)) {
        error.resource = record.resource as IntegrationResource;
      }
      return error;
    })
    .filter((entry): entry is IntegrationError => entry !== null)
    .slice(0, MAX_RECENT_ERRORS);
}

export function decodeConnection(value: unknown): IntegrationConnection | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asString(record.id).trim();
  const kind = record.kind;
  // Identity and kind are the two fields nothing can be defaulted from: with
  // no id there is no way to address the connection, and with an unknown kind
  // there is no provider to run it.
  if (!id || !isIntegrationKind(kind)) return null;

  const now = new Date(0).toISOString();
  return {
    id,
    kind,
    name: asString(record.name, id),
    status: STATUSES.has(asString(record.status)) ? (record.status as IntegrationStatus) : "DRAFT",
    resources: asStringArray(record.resources).filter((entry): entry is IntegrationResource =>
      RESOURCES.has(entry),
    ),
    config: decodeConfig(record.config),
    fieldMappings: Array.isArray(record.fieldMappings)
      ? record.fieldMappings.map(decodeMapping).filter((entry): entry is FieldMapping => entry !== null)
      : [],
    schedule: decodeSchedule(record.schedule),
    recentErrors: decodeErrors(record.recentErrors),
    createdAt: asString(record.createdAt, now),
    updatedAt: asString(record.updatedAt, now),
  };
}

/** Reads the integrations bucket out of whatever `Institution.settings` holds. */
export function readIntegrationSettings(settings: unknown): IntegrationSettings {
  const root = asRecord(settings);
  const bucket = asRecord(root?.[INTEGRATION_SETTINGS_KEY]);
  if (!bucket) return { connections: [] };

  const rateLimits: Record<string, { burst: number; refillPerMinute: number }> = {};
  const rawLimits = asRecord(bucket.rateLimits);
  if (rawLimits) {
    for (const [apiKeyId, raw] of Object.entries(rawLimits)) {
      const limit = asRecord(raw);
      if (!limit) continue;
      const burst = Number(limit.burst);
      const refillPerMinute = Number(limit.refillPerMinute);
      if (!Number.isFinite(burst) || !Number.isFinite(refillPerMinute)) continue;
      rateLimits[apiKeyId] = {
        burst: Math.max(1, Math.floor(burst)),
        refillPerMinute: Math.max(1, Math.floor(refillPerMinute)),
      };
    }
  }

  return {
    connections: Array.isArray(bucket.connections)
      ? bucket.connections
          .map(decodeConnection)
          .filter((entry): entry is IntegrationConnection => entry !== null)
      : [],
    rateLimits,
  };
}

export function listConnections(settings: unknown): IntegrationConnection[] {
  return readIntegrationSettings(settings).connections ?? [];
}

export function findConnection(settings: unknown, id: string): IntegrationConnection | null {
  return listConnections(settings).find((connection) => connection.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Describing configuration safely
// ---------------------------------------------------------------------------

export interface ConfigSummary {
  baseUrl: string | null;
  testPath: string | null;
  deliveryUrl: string | null;
  delimiter: string | null;
  /**
   * Header *names* with their values masked. An administrator needs to see
   * that `Authorization` is set and spelled correctly; they never need the
   * token read back to them, and a page that renders it turns every screen
   * share and browser cache into a credential leak.
   */
  headers: Array<{ name: string; value: string }>;
  resourcePaths: Array<{ resource: string; path: string }>;
  /** True when at least one header is configured — drives "credentials set". */
  hasCredentials: boolean;
}

/**
 * Renders a connection's configuration for a human without rendering its
 * secrets.
 *
 * Masking is length-preserving only in shape, never in content: a four-star
 * mask for a four-character token would leak the length, and a mask that
 * showed the last four characters of a bearer token would leak the part an
 * attacker can use to confirm a guess. Every value is the same fixed string.
 *
 * Non-sensitive headers (`Accept`, `X-Tenant`) are shown in full, because
 * "why is this integration returning XML" is answered by seeing them and
 * masking them helps nobody.
 */
export function describeConfig(config: IntegrationConfig): ConfigSummary {
  const headers = Object.entries(config.headers ?? {}).map(([name, value]) => ({
    name,
    value: isSensitiveKey(name) || looksLikeCredential(value) ? REDACTED : value,
  }));

  return {
    baseUrl: config.baseUrl ?? null,
    testPath: config.testPath ?? null,
    deliveryUrl: config.deliveryUrl ?? null,
    delimiter: config.delimiter ?? null,
    headers,
    resourcePaths: Object.entries(config.resourcePaths ?? {}).map(([resource, path]) => ({
      resource,
      path,
    })),
    hasCredentials: headers.length > 0,
  };
}

/**
 * Catches the case the key name misses: `X-Custom-Token: Bearer ey…` is a
 * credential whatever the header is called, and an ERP vendor's header naming
 * is not something this codebase gets to choose.
 */
function looksLikeCredential(value: string): boolean {
  return /^(bearer|basic|token)\s/i.test(value) || value.length > 40;
}

/**
 * Merges an edit over stored configuration, treating a blank secret as "leave
 * it alone".
 *
 * This is the other half of masking. The form cannot render the stored token,
 * so submitting the form unchanged posts an empty `Authorization` field — and
 * a naive merge would wipe the credential every time an administrator renamed
 * the connection. Clearing a header is still possible, explicitly, via
 * `removeHeaders`.
 */
export function mergeConfig(
  existing: IntegrationConfig,
  incoming: IntegrationConfig,
  removeHeaders: readonly string[] = [],
): IntegrationConfig {
  const headers = { ...(existing.headers ?? {}) };
  for (const [name, value] of Object.entries(incoming.headers ?? {})) {
    if (value.trim() === "") continue;
    headers[name] = value;
  }
  for (const name of removeHeaders) delete headers[name];

  const merged: IntegrationConfig = { ...existing, ...incoming };
  if (Object.keys(headers).length > 0) merged.headers = headers;
  else delete merged.headers;
  return merged;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Writes the integrations bucket back, preserving every other bucket.
 *
 * `Institution.settings` is shared: `academicUnitLabels`,
 * `confidenceThresholds`, `attendanceMode` and `lowAttendanceThreshold` all
 * live beside us. Replacing the column wholesale would erase an institution's
 * attendance thresholds the first time someone saved an integration —
 * silently, and with no obvious connection between cause and effect.
 */
export function writeIntegrationSettings(
  settings: unknown,
  integrations: IntegrationSettings,
): Record<string, unknown> {
  const root = asRecord(settings) ?? {};
  return { ...root, [INTEGRATION_SETTINGS_KEY]: integrations };
}

export function upsertConnection(
  settings: unknown,
  connection: IntegrationConnection,
): Record<string, unknown> {
  const current = readIntegrationSettings(settings);
  const connections = current.connections ?? [];
  const index = connections.findIndex((entry) => entry.id === connection.id);
  const next = index === -1 ? [...connections, connection] : connections.with(index, connection);
  return writeIntegrationSettings(settings, { ...current, connections: next });
}

export function removeConnection(settings: unknown, id: string): Record<string, unknown> {
  const current = readIntegrationSettings(settings);
  return writeIntegrationSettings(settings, {
    ...current,
    connections: (current.connections ?? []).filter((entry) => entry.id !== id),
  });
}

/**
 * Records a failure against a connection and flips it to ERROR.
 *
 * Newest first and capped, because this rides in a settings blob that is read
 * on every Integration Center page load — an unbounded error list would grow
 * until the column was slow to read and the page slow to render. The
 * *complete* history is in `AuditLog`; this is the last-ten summary the
 * status column needs.
 */
export function recordConnectionError(
  connection: IntegrationConnection,
  error: IntegrationError,
): IntegrationConnection {
  return {
    ...connection,
    status: "ERROR",
    recentErrors: [error, ...connection.recentErrors].slice(0, MAX_RECENT_ERRORS),
    updatedAt: error.at,
  };
}

/**
 * Records a successful run.
 *
 * Clears `recentErrors`, which is the point: a connection that failed for two
 * days and then succeeded is *working*, and leaving a wall of red beside it
 * trains an administrator to ignore the error column. `lastSuccessAt` is what
 * moves the incremental watermark — `lastSyncAt` moves on every attempt,
 * including failures, and using it as the watermark would skip every record
 * that changed during an outage.
 */
export function recordConnectionSuccess(
  connection: IntegrationConnection,
  at: string,
  cursor?: string,
): IntegrationConnection {
  return {
    ...connection,
    status: "ACTIVE",
    recentErrors: [],
    schedule: { ...connection.schedule, lastSyncAt: at, lastSuccessAt: at, cursor },
    updatedAt: at,
  };
}
