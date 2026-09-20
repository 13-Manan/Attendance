import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasPermission, requirePermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import type { InstitutionType } from "@prisma/client";

/**
 * The platform tier: the administration that sits *above* a tenant.
 *
 * Everything else in this application is institution-scoped by construction —
 * `requireSameInstitution` is the spine of the whole authorization model. This
 * module is the one place that deliberately reads across institutions, which
 * makes it the one place where that spine could be broken by accident.
 *
 * So the rule here is inverted and explicit: every function begins with
 * `requirePlatformAccess`, which demands a permission (`platform.institution.*`)
 * that only PLATFORM_SUPER_ADMIN holds. An institution admin calling into this
 * module is refused before a query runs — not narrowed, refused. There is no
 * "your institution's slice of the platform view", because a platform view of
 * one institution is just that institution's own dashboard, which already
 * exists.
 *
 * `platform.institution.create` and `platform.institution.suspend` were
 * declared when the role model was written and had no consumer until now.
 *
 * ## Aggregation
 *
 * Counts are `groupBy` and `count` in PostgreSQL. The overview touches every
 * institution on the platform, so loading rows to count them in JavaScript
 * would get slower exactly as the product succeeds — the same mistake Phase 8
 * measured at 5.5 s on a single institution.
 */

/** The floor for anything in this module. */
function requirePlatformAccess(actor: SessionUser): void {
  requirePermission(actor, "platform.institution.create");
}

function requireSuspendAccess(actor: SessionUser): void {
  requirePermission(actor, "platform.institution.suspend");
}

export interface PlatformOverview {
  institutions: { total: number; active: number; suspended: number; schools: number; colleges: number };
  people: { users: number; activeUsers: number; students: number; activeStudents: number };
  academic: { cohorts: number; subjects: number };
  attendance: { sessionsToday: number; finalizedToday: number; awaitingReview: number };
  integrations: { apiKeys: number; activeApiKeys: number; webhookEndpoints: number };
  security: { auditEventsLast24h: number };
}

/** UTC day bounds, matching the attendance engine's own day boundary. */
function utcDayRange(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export async function getPlatformOverview(
  actor: SessionUser,
  now: Date = new Date(),
): Promise<PlatformOverview> {
  requirePlatformAccess(actor);
  const { start, end } = utcDayRange(now);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // One round of independent aggregates, issued together. Every one is a
  // COUNT in the database; none returns rows.
  const [
    institutionsByType,
    suspended,
    users,
    activeUsers,
    students,
    activeStudents,
    cohorts,
    subjects,
    sessionsToday,
    finalizedToday,
    awaitingReview,
    apiKeys,
    activeApiKeys,
    webhookEndpoints,
    auditEvents,
  ] = await Promise.all([
    prisma.institution.groupBy({ by: ["type"], _count: { _all: true } }),
    prisma.institution.count({ where: { suspendedAt: { not: null } } }),
    prisma.user.count(),
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.student.count(),
    prisma.student.count({ where: { status: "ACTIVE" } }),
    prisma.cohort.count(),
    prisma.subject.count(),
    prisma.attendanceSession.count({ where: { sessionDate: { gte: start, lt: end } } }),
    prisma.attendanceSession.count({
      where: { sessionDate: { gte: start, lt: end }, status: "FINALIZED" },
    }),
    prisma.attendanceSession.count({ where: { status: { in: ["REVIEW", "PROCESSING"] } } }),
    prisma.apiKey.count(),
    prisma.apiKey.count({ where: { revokedAt: null } }),
    prisma.webhookEndpoint.count({ where: { isActive: true } }),
    prisma.auditLog.count({ where: { createdAt: { gte: dayAgo } } }),
  ]);

  const byType = new Map(institutionsByType.map((row) => [row.type, row._count._all]));
  const total = institutionsByType.reduce((sum, row) => sum + row._count._all, 0);

  return {
    institutions: {
      total,
      active: total - suspended,
      suspended,
      schools: byType.get("SCHOOL") ?? 0,
      colleges: byType.get("COLLEGE") ?? 0,
    },
    people: { users, activeUsers, students, activeStudents },
    academic: { cohorts, subjects },
    attendance: { sessionsToday, finalizedToday, awaitingReview },
    integrations: { apiKeys, activeApiKeys, webhookEndpoints },
    security: { auditEventsLast24h: auditEvents },
  };
}

export interface InstitutionListRow {
  id: string;
  name: string;
  type: InstitutionType;
  suspendedAt: string | null;
  createdAt: string;
  contactEmail: string | null;
  counts: { users: number; students: number; cohorts: number };
}

export interface InstitutionListFilters {
  search?: string;
  type?: InstitutionType;
  status?: "active" | "suspended";
}

/** Bounded, so a platform with many tenants cannot be listed in one request. */
const MAX_PAGE_SIZE = 100;

export interface InstitutionListPage {
  rows: InstitutionListRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export async function listInstitutions(
  actor: SessionUser,
  filters: InstitutionListFilters = {},
  page: { limit?: number; offset?: number } = {},
): Promise<InstitutionListPage> {
  requirePlatformAccess(actor);

  const limit = Math.min(Math.max(page.limit ?? 25, 1), MAX_PAGE_SIZE);
  const offset = Math.max(page.offset ?? 0, 0);

  const where: Prisma.InstitutionWhereInput = {};
  if (filters.search?.trim()) {
    // Case-insensitive contains. Bounded by `limit` below, and the column is
    // small; a trigram index is a Phase 15 question, not a Phase 13 one.
    where.name = { contains: filters.search.trim(), mode: "insensitive" };
  }
  if (filters.type) where.type = filters.type;
  if (filters.status === "suspended") where.suspendedAt = { not: null };
  if (filters.status === "active") where.suspendedAt = null;

  const [rows, total] = await Promise.all([
    prisma.institution.findMany({
      where,
      select: {
        id: true,
        name: true,
        type: true,
        suspendedAt: true,
        createdAt: true,
        contactEmail: true,
        // Counted by the database, one query for the page rather than one
        // per row — the N+1 this listing would otherwise be.
        _count: { select: { users: true, students: true, cohorts: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit,
      skip: offset,
    }),
    prisma.institution.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      contactEmail: row.contactEmail,
      counts: { users: row._count.users, students: row._count.students, cohorts: row._count.cohorts },
    })),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}

export interface InstitutionDetail extends InstitutionListRow {
  timezone: string;
  contactPhone: string | null;
  addressLine: string | null;
  attendanceMode: string;
  counts: {
    users: number;
    students: number;
    activeStudents: number;
    cohorts: number;
    subjects: number;
    campuses: number;
    apiKeys: number;
    activeApiKeys: number;
    webhookEndpoints: number;
    facesEnrolled: number;
    sessionsAwaitingReview: number;
  };
  recentAudit: Array<{
    id: string;
    action: string;
    entityType: string;
    createdAt: string;
    actorName: string | null;
  }>;
}

export async function getInstitutionDetail(
  actor: SessionUser,
  institutionId: string,
): Promise<InstitutionDetail | null> {
  requirePlatformAccess(actor);

  const institution = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: {
      id: true,
      name: true,
      type: true,
      timezone: true,
      settings: true,
      suspendedAt: true,
      createdAt: true,
      contactEmail: true,
      contactPhone: true,
      addressLine: true,
    },
  });
  if (!institution) return null;

  const [
    users,
    students,
    activeStudents,
    cohorts,
    subjects,
    campuses,
    apiKeys,
    activeApiKeys,
    webhookEndpoints,
    facesEnrolled,
    sessionsAwaitingReview,
    audit,
  ] = await Promise.all([
    prisma.user.count({ where: { institutionId } }),
    prisma.student.count({ where: { institutionId } }),
    prisma.student.count({ where: { institutionId, status: "ACTIVE" } }),
    prisma.cohort.count({ where: { institutionId } }),
    prisma.subject.count({ where: { institutionId } }),
    prisma.campus.count({ where: { institutionId } }),
    prisma.apiKey.count({ where: { institutionId } }),
    prisma.apiKey.count({ where: { institutionId, revokedAt: null } }),
    prisma.webhookEndpoint.count({ where: { institutionId, isActive: true } }),
    // Students with at least one active template. Not a biometric read: a
    // count of rows, never a vector — the column is not even selectable
    // through Prisma.
    prisma.faceEmbedding.count({ where: { student: { institutionId }, isActive: true } }),
    prisma.attendanceSession.count({
      where: { institutionId, status: { in: ["REVIEW", "PROCESSING"] } },
    }),
    prisma.auditLog.findMany({
      where: { institutionId },
      select: {
        id: true,
        action: true,
        entityType: true,
        createdAt: true,
        actorUserId: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
    }),
  ]);

  // One lookup for the whole page's actors rather than one per row — the
  // N+1 a naive `include` would produce on a ten-row list.
  const actorIds = [...new Set(audit.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorNames = new Map(actors.map((row) => [row.id, row.name]));

  const settings = (institution.settings ?? {}) as { attendanceMode?: string };

  return {
    id: institution.id,
    name: institution.name,
    type: institution.type,
    timezone: institution.timezone,
    suspendedAt: institution.suspendedAt?.toISOString() ?? null,
    createdAt: institution.createdAt.toISOString(),
    contactEmail: institution.contactEmail,
    contactPhone: institution.contactPhone,
    addressLine: institution.addressLine,
    attendanceMode:
      settings.attendanceMode ?? (institution.type === "COLLEGE" ? "SUBJECT_WISE" : "DAILY"),
    counts: {
      users,
      students,
      activeStudents,
      cohorts,
      subjects,
      campuses,
      apiKeys,
      activeApiKeys,
      webhookEndpoints,
      facesEnrolled,
      sessionsAwaitingReview,
    },
    recentAudit: audit.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      createdAt: row.createdAt.toISOString(),
      actorName: row.actorUserId ? (actorNames.get(row.actorUserId) ?? null) : null,
    })),
  };
}

export interface CreateInstitutionInput {
  name: string;
  type: InstitutionType;
  timezone?: string;
  contactEmail?: string | null;
}

/**
 * Creates a tenant. Deliberately creates *only* the tenant.
 *
 * No roles, no admin user, no academic scaffolding. Those belong to the
 * bootstrap path (`modules/authorization/bootstrap.ts`), which already knows
 * how to do them idempotently and under a lock; duplicating that here would
 * be a second way to half-create an institution.
 */
export async function createInstitution(
  actor: SessionUser,
  input: CreateInstitutionInput,
): Promise<{ id: string; name: string }> {
  requirePlatformAccess(actor);

  const name = input.name.trim();
  if (!name) throw new ForbiddenError("institution_name_required");
  if (name.length > 200) throw new ForbiddenError("institution_name_too_long");
  if (input.type !== "SCHOOL" && input.type !== "COLLEGE") {
    throw new ForbiddenError("institution_type_invalid");
  }

  const institution = await prisma.institution.create({
    data: {
      name,
      type: input.type,
      timezone: input.timezone?.trim() || "UTC",
      contactEmail: input.contactEmail?.trim() || null,
    },
    select: { id: true, name: true },
  });

  await recordAuditLog({
    action: "platform.institution.created",
    entityType: "Institution",
    entityId: institution.id,
    institutionId: institution.id,
    actorUserId: actor.userId,
    afterJson: { name: institution.name, type: input.type },
  });

  return institution;
}

/**
 * Suspends or restores a tenant.
 *
 * Reversible, and cascades to nothing. Attendance, audit history and
 * enrolments are untouched — what this records is that the institution should
 * stop being served, which is an operational decision somebody may reverse.
 * Making it a delete would make it one they cannot.
 */
export async function setInstitutionSuspended(
  actor: SessionUser,
  institutionId: string,
  suspended: boolean,
): Promise<{ id: string; suspendedAt: string | null }> {
  requirePlatformAccess(actor);
  requireSuspendAccess(actor);

  const before = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: { id: true, name: true, suspendedAt: true },
  });
  if (!before) throw new ForbiddenError("institution_not_found");

  const suspendedAt = suspended ? new Date() : null;
  const updated = await prisma.institution.update({
    where: { id: institutionId },
    data: { suspendedAt },
    select: { id: true, suspendedAt: true },
  });

  await recordAuditLog({
    action: suspended ? "platform.institution.suspended" : "platform.institution.restored",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { suspendedAt: before.suspendedAt?.toISOString() ?? null },
    afterJson: { suspendedAt: updated.suspendedAt?.toISOString() ?? null },
  });

  return { id: updated.id, suspendedAt: updated.suspendedAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// Platform readiness
// ---------------------------------------------------------------------------

export type BlockerKind =
  | "licensing"
  | "technical"
  | "security-hardening"
  | "configuration"
  | "policy";

export interface ReadinessItem {
  id: string;
  title: string;
  kind: BlockerKind;
  /** True when this prevents a production release. */
  blocking: boolean;
  detail: string;
  evidence: string | null;
}

/**
 * What stands between this build and a production release.
 *
 * Hard-coded, and that is the point: these are findings from Phases 5, 11 and
 * 12 that no runtime probe can discover. A dashboard that inferred readiness
 * from a health check would report green the moment the face service answered,
 * which is exactly the false reassurance this list exists to prevent.
 *
 * Each item is dated by the phase that established it and carries the
 * evidence. When one is genuinely resolved, it is removed here as part of
 * resolving it — not toggled by configuration.
 */
export function getReadiness(actor: SessionUser): ReadinessItem[] {
  requirePermission(actor, "institution.read");
  return [
    {
      id: "face-model-provenance",
      title: "Face model is not cleared for production use",
      kind: "licensing",
      blocking: true,
      detail:
        "YuNet and SFace weights carry permissive licensing signals, but their " +
        "training-data provenance is unresolved. This is a legal question and " +
        "benchmarking does not answer it. `productionEligible` is false and " +
        "FACE_AI_REQUIRE_PRODUCTION_MODEL refuses to start a deployment on an " +
        "uncleared model.",
      evidence: "services/face-ai/app/models/LICENSING.md",
    },
    {
      id: "recognition-accuracy-unmeasured",
      title: "Recognition accuracy has never been measured",
      kind: "technical",
      blocking: true,
      detail:
        "Phase 12 measured the model's compute — cold start, per-face cost, " +
        "concurrency, memory — but not whether it identifies the right people. " +
        "That needs a consented, labelled, multi-condition dataset with a " +
        "disjoint enrolment/test split. The harness is ready; the dataset does " +
        "not exist.",
      evidence: "docs/BENCHMARKS.md §10",
    },
    {
      id: "rate-limiter-single-instance",
      title: "Rate limiting is per-process",
      kind: "security-hardening",
      blocking: false,
      detail:
        "The limiter counts in memory, so behind more than one replica the " +
        "effective limit multiplies by the replica count. Redis behind the " +
        "same interface is the fix.",
      evidence: "docs/adr/0007-in-process-webhooks-and-in-memory-rate-limiting.md",
    },
    {
      id: "realtime-single-instance",
      title: "Realtime delivery is per-process",
      kind: "security-hardening",
      blocking: false,
      detail:
        "The publisher is an in-memory emitter. An event published on one " +
        "replica never reaches a client connected to another, so live updates " +
        "silently stop working when the deployment scales past one.",
      evidence: "apps/web/src/modules/realtime/publisher.ts",
    },
    {
      id: "webhook-kek",
      title: "Webhook encryption key should be explicit in production",
      kind: "configuration",
      blocking: false,
      detail:
        "Webhook signing secrets are encrypted at rest. With WEBHOOK_SECRET_KEK " +
        "unset the key is derived from AUTH_SECRET, which works but cannot be " +
        "rotated independently. Set an explicit key before storing real endpoints.",
      evidence: "docs/SECURITY.md §9",
    },
    {
      id: "retention-policy",
      title: "Biometric retention periods are an institution decision",
      kind: "policy",
      blocking: false,
      detail:
        "Deletion and retention controls exist and are configurable. What the " +
        "periods should be, and what consent language applies, is a policy " +
        "question this software cannot answer and does not claim to.",
      evidence: "docs/SECURITY.md §2",
    },
  ];
}

/** True when the caller may see the platform tier at all. */
export function canAccessPlatformAdmin(actor: SessionUser): boolean {
  return hasPermission(actor, "platform.institution.create");
}
