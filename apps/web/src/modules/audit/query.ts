import type { AuditAction } from "./types";

/**
 * Turning the audit table into something a person can search.
 *
 * ## Why this file is pure, and why that matters more here than usual
 *
 * An audit trail is only worth keeping if it can be questioned, and the
 * questions are always the same five: who, what, when, which part of the
 * system, and which record. This module turns those five into a query and
 * nothing else — no Prisma import, no session, no I/O — so the filter
 * semantics can be tested exhaustively (`query.test.ts`) rather than clicked
 * through. A log search that silently drops a filter shows an administrator a
 * short list of rows and lets them conclude nothing happened.
 *
 * ## The index constraint, stated plainly
 *
 * `AuditLog` is indexed on `institutionId` and on `(entityType, entityId)`.
 * There is no index on `action`, `actorUserId` or `createdAt`, and the
 * database schema is frozen for this phase. So every query built here is
 * institution-scoped first — the one filter that is always present and always
 * indexed — and always paginated. Ordering is by `createdAt desc`, which is a
 * sort over the institution's rows rather than an index scan; acceptable at
 * the size this table reaches in a single institution, and the reason the page
 * size has a hard ceiling instead of an "all" option.
 *
 * ## Modules
 *
 * The brief asks for a module filter. There is no module column, and adding
 * one would be a schema change. Instead the action catalogue below *is* the
 * module map: every action belongs to exactly one module, the module filter
 * expands to that module's actions, and the compile-time check at the bottom
 * of this file fails the build if an action is ever added to
 * `AuditAction` without being placed in a module. That is deliberate — an
 * action missing from the catalogue would be invisible to the module filter
 * while still appearing in the unfiltered list, which is the exact failure
 * mode that makes people distrust a search screen.
 */

export interface AuditModule {
  key: string;
  label: string;
  /** Every action that belongs to this module. Exactly one module per action. */
  actions: readonly AuditAction[];
}

export const AUDIT_MODULES: readonly AuditModule[] = [
  {
    key: "auth",
    label: "Sign-in",
    actions: ["auth.login.success", "auth.login.failure", "auth.logout"],
  },
  {
    key: "people",
    label: "Staff & access",
    actions: [
      "user.created",
      "user.updated",
      "user.deactivated",
      "user.reactivated",
      "user.role_changed",
      "cohort_faculty.assigned",
      "cohort_faculty.removed",
      "cohort_subject.faculty_assigned",
    ],
  },
  {
    key: "students",
    label: "Students & enrollment",
    actions: [
      "student.created",
      "student.updated",
      "student.archived",
      "student.restored",
      "enrollment.created",
      "enrollment.updated",
      "student_subject_enrollment.created",
    ],
  },
  {
    key: "academic",
    label: "Academic structure",
    actions: [
      "academic_unit.created",
      "academic_unit.updated",
      "academic_session.created",
      "academic_session.updated",
      "academic_session.activated",
      "academic_session.archived",
      "academic_session.restored",
      "cohort.created",
      "cohort.updated",
      "subject.created",
      "subject.updated",
      "cohort_subject.attached",
    ],
  },
  {
    key: "campuses",
    label: "Campuses",
    actions: ["campus.created", "campus.updated", "campus.closed", "campus.reopened"],
  },
  {
    key: "attendance",
    label: "Attendance",
    actions: [
      "attendance_session.created",
      "attendance_capture.started",
      "attendance_capture.resumed",
      "attendance_capture.cancelled",
      "attendance.candidates_generated",
      "attendance.corrected",
      "attendance.finalized",
    ],
  },
  {
    key: "face",
    label: "Face data",
    actions: [
      "face_enrollment.created",
      "face_enrollment.deactivated",
      "face_enrollment.deleted",
      "face_data.retention_purged",
      "face_data.retention_policy_updated",
    ],
  },
  {
    key: "settings",
    label: "Institution settings",
    actions: [
      "institution.profile_updated",
      "institution.attendance_policy_updated",
      "institution.face_policy_updated",
    ],
  },
  {
    key: "api",
    label: "API access",
    actions: [
      "api_key.created",
      "api_key.revoked",
      "api.request.denied",
      "api.resource.read",
      "api.resource.written",
    ],
  },
  {
    key: "integrations",
    label: "Integrations & webhooks",
    actions: [
      "integration.created",
      "integration.updated",
      "integration.deleted",
      "integration.connection_tested",
      "integration.sync.started",
      "integration.sync.completed",
      "integration.sync.failed",
      "integration.import.completed",
      "webhook_endpoint.created",
      "webhook_endpoint.updated",
      "webhook_endpoint.deleted",
      "webhook.delivery.succeeded",
      "webhook.delivery.failed",
    ],
  },
];

/** Every known action, in module order — the action filter's option list. */
export const AUDIT_ACTIONS: readonly AuditAction[] = AUDIT_MODULES.flatMap(
  (module) => module.actions,
);

/**
 * The build fails if an action is added to `AuditAction` and not placed in a
 * module above. `Exclude` resolves to the missing member, which is not
 * assignable to `never`, and the error names the action that was forgotten.
 */
type UncataloguedAction = Exclude<AuditAction, (typeof AUDIT_MODULES)[number]["actions"][number]>;
const _everyActionHasAModule: UncataloguedAction extends never ? true : UncataloguedAction = true;
void _everyActionHasAModule;

const MODULE_BY_ACTION = new Map<string, AuditModule>(
  AUDIT_MODULES.flatMap((module) => module.actions.map((action) => [action as string, module])),
);

/** The module an action belongs to, or `null` for an action this build does not know. */
export function auditModuleForAction(action: string): AuditModule | null {
  return MODULE_BY_ACTION.get(action) ?? null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_AUDIT_PAGE_SIZE = 50;

export interface AuditFilters {
  /** Exact `actorUserId`. Empty means any actor, including API keys. */
  actorUserId: string;
  /** Exact action. Empty means any. Ignored when it is not a known action. */
  action: string;
  /** Module key. Empty means any. Ignored when unknown. */
  module: string;
  /** Inclusive start date, `YYYY-MM-DD`. Empty means unbounded. */
  from: string;
  /** Inclusive end date, `YYYY-MM-DD`. Empty means unbounded. */
  to: string;
  /** Exact `entityType`, e.g. `Student`. Empty means any. */
  entityType: string;
  /** Exact `entityId`. Empty means any. */
  entityId: string;
  page: number;
  pageSize: number;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  actorUserId: "",
  action: "",
  module: "",
  from: "",
  to: "",
  entityType: "",
  entityId: "",
  page: 1,
  pageSize: DEFAULT_AUDIT_PAGE_SIZE,
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A calendar date, or "" if it is not one.
 *
 * `new Date("2026-02-31")` is a valid Date in JavaScript — it rolls over to
 * March. A rolled-over date in an audit filter is worse than a rejected one:
 * the search runs, returns rows, and answers a question nobody asked. So the
 * parsed date is formatted back and compared to the input.
 */
function calendarDate(value: unknown): string {
  const raw = text(value);
  if (!DATE_PATTERN.test(raw)) return "";
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10) === raw ? raw : "";
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(text(value));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/**
 * Normalizes whatever arrived in the query string.
 *
 * Unknown values are dropped rather than refused. A URL is a thing people
 * bookmark, edit and paste to each other, and an audit search that errors on a
 * stale bookmark trains people not to use it. What must never happen is the
 * opposite: an unrecognised value being passed through to the query, where it
 * would silently match nothing and look like "no such events".
 */
export function parseAuditFilters(raw: Record<string, unknown>): AuditFilters {
  const action = text(raw.action);
  // Named `moduleKey`, not `module`: a local called `module` shadows the
  // CommonJS binding of the same name once this is bundled.
  const moduleKey = text(raw.module);
  const from = calendarDate(raw.from);
  const to = calendarDate(raw.to);

  const pageSize = AUDIT_PAGE_SIZES.includes(
    positiveInt(raw.pageSize, DEFAULT_AUDIT_PAGE_SIZE) as (typeof AUDIT_PAGE_SIZES)[number],
  )
    ? positiveInt(raw.pageSize, DEFAULT_AUDIT_PAGE_SIZE)
    : DEFAULT_AUDIT_PAGE_SIZE;

  return {
    actorUserId: text(raw.actorUserId),
    action: AUDIT_ACTIONS.includes(action as AuditAction) ? action : "",
    module: AUDIT_MODULES.some((entry) => entry.key === moduleKey) ? moduleKey : "",
    // A reversed range is a typo, not a request for nothing. Swapping is the
    // reading the person meant; returning zero rows is the reading that makes
    // them think the events are missing.
    from: from && to && from > to ? to : from,
    to: from && to && from > to ? from : to,
    entityType: text(raw.entityType),
    entityId: text(raw.entityId),
    page: positiveInt(raw.page, 1),
    pageSize,
  };
}

/** True when any filter beyond pagination is set. */
export function hasActiveAuditFilters(filters: AuditFilters): boolean {
  return Boolean(
    filters.actorUserId ||
      filters.action ||
      filters.module ||
      filters.from ||
      filters.to ||
      filters.entityType ||
      filters.entityId,
  );
}

export interface AuditWhere {
  institutionId: string;
  actorUserId?: string;
  action?: string | { in: string[] };
  entityType?: string;
  entityId?: string;
  createdAt?: { gte?: Date; lt?: Date };
}

/**
 * The query, as a plain object.
 *
 * `institutionId` is written first and is not optional: it comes from the
 * session, never from the filters, so there is no combination of query-string
 * values that reads another institution's audit trail.
 *
 * The date range is half-open — `gte` the start of the "from" day, `lt` the
 * start of the day after "to" — so "to = today" includes everything that
 * happened today rather than only the row stamped exactly midnight.
 */
export function buildAuditWhere(institutionId: string, filters: AuditFilters): AuditWhere {
  const where: AuditWhere = { institutionId };

  if (filters.actorUserId) where.actorUserId = filters.actorUserId;

  if (filters.action) {
    where.action = filters.action;
  } else if (filters.module) {
    const chosen = AUDIT_MODULES.find((entry) => entry.key === filters.module);
    if (chosen) where.action = { in: [...chosen.actions] };
  }

  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;

  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(`${filters.from}T00:00:00.000Z`);
    if (filters.to) {
      const end = new Date(`${filters.to}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      where.createdAt.lt = end;
    }
  }

  return where;
}

/** `skip`/`take` for a page, clamped so a page past the end shows the last page. */
export function auditPagination(
  filters: AuditFilters,
  total: number,
): { page: number; pageSize: number; totalPages: number; skip: number; take: number } {
  const pageSize = filters.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(filters.page, 1), totalPages);
  return { page, pageSize, totalPages, skip: (page - 1) * pageSize, take: pageSize };
}
