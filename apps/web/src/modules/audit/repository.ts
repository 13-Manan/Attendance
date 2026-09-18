import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuditWhere } from "./query";

/**
 * Reads over the audit table.
 *
 * Every function here takes a `where` that already carries an institution id —
 * built by `query.ts#buildAuditWhere` from the session, never from user input.
 * None of them accepts an institution id of its own, so there is no call site
 * in this module through which one tenant's search could read another's rows.
 *
 * Writes live in `service.ts#recordAuditLog` and stay there. This file never
 * creates, updates or deletes an audit row, and nothing in this codebase does
 * the latter two at all: an audit log that can be edited is a record of what
 * somebody was willing to leave behind.
 */

export interface AuditLogRow {
  id: string;
  institutionId: string | null;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface AuditActor {
  id: string;
  name: string;
  email: string;
}

export async function countAuditLogs(where: AuditWhere): Promise<number> {
  return prisma.auditLog.count({ where: where as Prisma.AuditLogWhereInput });
}

/**
 * One page, newest first.
 *
 * `createdAt desc` with `id desc` as the tie-break: two rows written inside the
 * same millisecond — a mutation and its audit row in one transaction, a bulk
 * import — would otherwise be free to swap places between page 1 and page 2,
 * which loses a row from the paginated view entirely.
 */
export async function listAuditLogs(
  where: AuditWhere,
  skip: number,
  take: number,
): Promise<AuditLogRow[]> {
  const rows = await prisma.auditLog.findMany({
    where: where as Prisma.AuditLogWhereInput,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip,
    take,
  });
  return rows as AuditLogRow[];
}

/**
 * The people who could appear in the actor column.
 *
 * `AuditLog.actorUserId` has no relation to `User` in the schema and the schema
 * is frozen, so the name shown beside a row is resolved here rather than by a
 * join. Scoped to the institution: a name is never displayed for an actor from
 * another tenant, even if an id from one somehow appeared in a row.
 */
export async function listInstitutionActors(institutionId: string): Promise<AuditActor[]> {
  const users = await prisma.user.findMany({
    where: { institutionId },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }],
    take: 500,
  });
  return users;
}

/** The entity types that actually occur in this institution's log, with counts. */
export async function listAuditEntityTypes(
  institutionId: string,
): Promise<Array<{ entityType: string; count: number }>> {
  const groups = await prisma.auditLog.groupBy({
    by: ["entityType"],
    where: { institutionId },
    _count: { _all: true },
    orderBy: [{ entityType: "asc" }],
  });
  return groups.map((group) => ({ entityType: group.entityType, count: group._count._all }));
}
