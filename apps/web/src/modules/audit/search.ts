import { requirePermission } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { redact } from "@/modules/integrations/redaction";
import {
  auditModuleForAction,
  auditPagination,
  buildAuditWhere,
  parseAuditFilters,
  type AuditFilters,
  type AuditWhere,
} from "./query";
import * as repo from "./repository";
import type { AuditActor, AuditLogRow } from "./repository";

/**
 * The searchable audit trail.
 *
 * ## Why reading the log is itself a permission
 *
 * An audit row says who did what to whom. Taken together the rows say who was
 * signed in at 6pm, which student's face data was deleted, which registers
 * were reopened after finalization. That is a sensitive read, so it is gated
 * on `auditLog.read` — a permission that already exists and is already granted
 * only to administrator roles — and scoped to the caller's institution.
 *
 * ## Why the payloads are redacted on the way out
 *
 * `beforeJson` and `afterJson` are written by thirty different call sites and
 * one of them is an arbitrary integration payload from a system nobody here
 * has seen. The redactor from the integration hub runs over both on the way to
 * the screen, so a value that should never have been written into an audit row
 * is not then published to a browser because of it. Redacting at read time
 * costs nothing and does not depend on every past and future writer having got
 * it right.
 *
 * The log is never modified. This module has no update or delete, and neither
 * does the repository.
 */

export class AuditSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditSearchError";
  }
}

export interface AuditEntryActor {
  kind: "USER" | "API_KEY" | "SYSTEM";
  id: string | null;
  /** A name if one is known, otherwise something honest about who it was. */
  label: string;
}

export interface AuditEntry {
  id: string;
  createdAt: Date;
  action: string;
  moduleKey: string | null;
  moduleLabel: string;
  actor: AuditEntryActor;
  entityType: string;
  entityId: string;
  ipAddress: string | null;
  before: unknown;
  after: unknown;
}

export interface AuditSearchResult {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: AuditFilters;
  /** Everyone who could be picked in the actor filter. */
  actors: AuditActor[];
  /** Entity types that actually occur in this institution's log. */
  entityTypes: Array<{ entityType: string; count: number }>;
}

export interface AuditSearchDeps {
  count?: (where: AuditWhere) => Promise<number>;
  list?: (where: AuditWhere, skip: number, take: number) => Promise<AuditLogRow[]>;
  listActors?: (institutionId: string) => Promise<AuditActor[]>;
  listEntityTypes?: (
    institutionId: string,
  ) => Promise<Array<{ entityType: string; count: number }>>;
}

function deps(overrides: AuditSearchDeps) {
  return {
    count: overrides.count ?? repo.countAuditLogs,
    list: overrides.list ?? repo.listAuditLogs,
    listActors: overrides.listActors ?? repo.listInstitutionActors,
    listEntityTypes: overrides.listEntityTypes ?? repo.listAuditEntityTypes,
  };
}

/**
 * Names the actor without ever inventing one.
 *
 * Three cases, and the third is the one that matters. A row with no
 * `actorUserId` and no `actorApiKeyId` was written by the system itself — a
 * retention sweep, a scheduled finalization — and saying so is the truth. What
 * this must never do is attribute such a row to whoever happens to be reading
 * it, or leave the column blank so the reader supplies their own guess.
 *
 * An unknown user id is shown as the id. It means the account was deleted or
 * belongs to another tenant; either way the id is the evidence, and replacing
 * it with "Unknown" would discard the only handle anyone has on the question.
 */
function describeActor(row: AuditLogRow, names: Map<string, AuditActor>): AuditEntryActor {
  if (row.actorUserId) {
    const known = names.get(row.actorUserId);
    return {
      kind: "USER",
      id: row.actorUserId,
      label: known ? `${known.name} (${known.email})` : row.actorUserId,
    };
  }
  if (row.actorApiKeyId) {
    return { kind: "API_KEY", id: row.actorApiKeyId, label: `API key ${row.actorApiKeyId}` };
  }
  return { kind: "SYSTEM", id: null, label: "System" };
}

export async function searchAuditLogs(
  actor: SessionUser,
  rawFilters: Record<string, unknown>,
  overrides: AuditSearchDeps = {},
): Promise<AuditSearchResult> {
  const d = deps(overrides);
  requirePermission(actor, "auditLog.read");
  if (!actor.institutionId) {
    throw new AuditSearchError(
      "This account is not scoped to a single institution, so it has no institution audit log to search.",
    );
  }
  const institutionId = actor.institutionId;

  const filters = parseAuditFilters(rawFilters);
  const where = buildAuditWhere(institutionId, filters);

  // Counted first so a page number past the end lands on the last page rather
  // than on an empty screen that reads like "there is nothing here".
  const total = await d.count(where);
  const { page, pageSize, totalPages, skip, take } = auditPagination(filters, total);

  const [rows, actors, entityTypes] = await Promise.all([
    d.list(where, skip, take),
    d.listActors(institutionId),
    d.listEntityTypes(institutionId),
  ]);

  const names = new Map(actors.map((entry) => [entry.id, entry]));

  const entries: AuditEntry[] = rows.map((row) => {
    // Not `module`: that name shadows the CommonJS binding after bundling.
    const group = auditModuleForAction(row.action);
    return {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      moduleKey: group?.key ?? null,
      // An action this build does not know still appears, labelled as such.
      // Hiding it would be the one bug an audit search cannot have.
      moduleLabel: group?.label ?? "Other",
      actor: describeActor(row, names),
      entityType: row.entityType,
      entityId: row.entityId,
      ipAddress: row.ipAddress,
      before: redact(row.beforeJson),
      after: redact(row.afterJson),
    };
  });

  return {
    entries,
    total,
    page,
    pageSize,
    totalPages,
    filters: { ...filters, page },
    actors,
    entityTypes,
  };
}
