import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requirePermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { rateFromCounts, utcDayRange } from "@/modules/attendance-analytics/service";
import { getInstitutionById as getInstitutionByIdDefault } from "@/modules/institutions/repository";
import {
  resolveAttendanceMode,
  resolveLowAttendanceThreshold,
} from "@/modules/institutions/service";
import type { Institution } from "@/modules/institutions/types";
import * as repo from "./repository";
import { UNIT_KIND_BY_DIMENSION, type RollupOrder } from "./repository";
import { buildExport, type ExportColumn } from "./export";
import {
  buildUnitTree,
  bucketCohortsByKind,
  cohortsUnderUnits,
  intersectCohortFilters,
  type CohortScope,
} from "./unit-tree";
import type {
  ExportFile,
  ExportFormat,
  InstitutionOverview,
  LowAttendanceRow,
  ReportDimension,
  ReportFilters,
  ReportPage,
  ReportPageRequest,
  ReportRecordRow,
  ReportRollupRow,
} from "./types";

/**
 * Phase 8 reporting service.
 *
 * Holds the three things the repository deliberately does not: who is allowed
 * to ask, what the numbers mean, and what a caller's raw query string is
 * allowed to turn into. Every function here is authorization-first — the
 * permission check and the institution scope are resolved before any query
 * runs, so a denial is provable without a database.
 */

/** A repository function, as an injectable dependency. See the same type in
 * `attendance-analytics/service.ts` for why the awaited form is used. */
type AsDep<F> = F extends (...args: infer A) => PromiseLike<infer R>
  ? (...args: A) => Promise<R>
  : never;

export interface ReportingDeps {
  now?: () => Date;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  aggregateByDimension?: AsDep<typeof repo.aggregateByDimension>;
  countSessionsByDimension?: AsDep<typeof repo.countSessionsByDimension>;
  listLowAttendanceStudents?: AsDep<typeof repo.listLowAttendanceStudents>;
  countLowAttendanceStudents?: AsDep<typeof repo.countLowAttendanceStudents>;
  listRecords?: AsDep<typeof repo.listRecords>;
  countRecords?: AsDep<typeof repo.countRecords>;
  aggregateOverall?: AsDep<typeof repo.aggregateOverall>;
  countInstitutionEntities?: AsDep<typeof repo.countInstitutionEntities>;
  countFinalizedSessions?: AsDep<typeof repo.countFinalizedSessions>;
  countSessionsAwaitingConfirmation?: AsDep<typeof repo.countSessionsAwaitingConfirmation>;
  listFilterOptions?: AsDep<typeof repo.listFilterOptions>;
  loadUnitTreeRows?: AsDep<typeof repo.loadUnitTreeRows>;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 400;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/**
 * The hard ceiling on a single export.
 *
 * An export is the one path that legitimately wants many rows, so it is also
 * the one path that can be turned into a denial of service by a bookmark. The
 * exporter walks pages up to this many rows and then says so in the file
 * rather than silently truncating — a spreadsheet that is quietly missing its
 * last 10,000 rows is worse than one that refuses.
 */
export const MAX_EXPORT_ROWS = 50_000;
export const EXPORT_PAGE_SIZE = 5_000;

/**
 * Every report is institution-scoped; a platform user has no institution of
 * their own to report on. Mirrors `attendance-analytics`.
 */
function requireInstitutionScope(actor: SessionUser): string {
  if (!actor.institutionId) throw new ForbiddenError("institution_scope_required");
  return actor.institutionId;
}

/**
 * Institution-level reporting needs both permissions: `institution.read`
 * because the figures are institution-wide, and `attendanceRecord.read`
 * because they are attendance. A role holding one but not the other has not
 * been granted this.
 */
function requireReportAccess(actor: SessionUser): string {
  requirePermission(actor, "institution.read");
  requirePermission(actor, "attendanceRecord.read");
  return requireInstitutionScope(actor);
}

// ---------------------------------------------------------------------------
// Filter normalization
// ---------------------------------------------------------------------------

export interface RawReportQuery {
  from?: string;
  to?: string;
  cohortIds?: string[];
  academicUnitIds?: string[];
  subjectIds?: string[];
  facultyIds?: string[];
  studentIds?: string[];
  results?: string[];
}

/** Exported so the filter UI offers exactly what `normalizeFilters` accepts. */
export const VALID_RESULTS = ["PRESENT", "ABSENT", "NEEDS_REVIEW", "NOT_EVALUATED"] as const;

function parseUtcDate(value: string | undefined): Date | null {
  if (!value) return null;
  // Date-only strings are parsed as UTC midnight by the spec, which is the
  // boundary the attendance engine uses. A full timestamp is floored to its
  // UTC day for the same reason.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed;
}

function cleanIds(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const cleaned = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
  return cleaned.length ? cleaned : undefined;
}

/**
 * Turns a URL query into filters that are safe to run.
 *
 * Every failure mode here resolves to a *narrower* report, never a wider one:
 * an unparseable date falls back to the default window, a reversed range is
 * swapped rather than returning nothing, and an over-long range is clamped to
 * `MAX_WINDOW_DAYS` counting back from `to`. The alternative — rejecting —
 * turns a stale bookmark into an error page for an administrator who only
 * wanted this month's figures.
 */
export function normalizeFilters(raw: RawReportQuery, now: Date): ReportFilters {
  const { end: todayEnd } = utcDayRange(now);

  let to = parseUtcDate(raw.to);
  // `to` is exclusive, so a caller naming a closing date means "include it".
  if (to) to.setUTCDate(to.getUTCDate() + 1);
  else to = todayEnd;

  let from = parseUtcDate(raw.from);
  if (!from) {
    from = new Date(to);
    from.setUTCDate(from.getUTCDate() - DEFAULT_WINDOW_DAYS);
  }
  if (from >= to) {
    const swapped = new Date(from);
    from = new Date(to);
    from.setUTCDate(from.getUTCDate() - DEFAULT_WINDOW_DAYS);
    to = swapped;
    to.setUTCDate(to.getUTCDate() + 1);
  }
  const maxFrom = new Date(to);
  maxFrom.setUTCDate(maxFrom.getUTCDate() - MAX_WINDOW_DAYS);
  if (from < maxFrom) from = maxFrom;

  const results = raw.results
    ?.filter((r): r is (typeof VALID_RESULTS)[number] =>
      (VALID_RESULTS as readonly string[]).includes(r),
    )
    .filter((r, i, a) => a.indexOf(r) === i);

  return {
    from,
    to,
    cohortIds: cleanIds(raw.cohortIds),
    academicUnitIds: cleanIds(raw.academicUnitIds),
    subjectIds: cleanIds(raw.subjectIds),
    facultyIds: cleanIds(raw.facultyIds),
    studentIds: cleanIds(raw.studentIds),
    results: results?.length ? results : undefined,
  };
}

export function normalizePage(raw: { page?: number; pageSize?: number }): ReportPageRequest {
  const page = Number.isFinite(raw.page) ? Math.max(Math.trunc(raw.page as number), 1) : 1;
  const pageSize = Number.isFinite(raw.pageSize)
    ? Math.min(Math.max(Math.trunc(raw.pageSize as number), 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// Shared assembly
// ---------------------------------------------------------------------------

function pageOf<T>(rows: T[], request: ReportPageRequest, totalRows: number): ReportPage<T> {
  return {
    rows,
    page: request.page,
    pageSize: request.pageSize,
    totalRows,
    hasMore: request.page * request.pageSize < totalRows,
  };
}

async function loadInstitution(
  institutionId: string,
  deps: ReportingDeps,
): Promise<Institution | null> {
  const getInstitution = deps.getInstitutionById ?? getInstitutionByIdDefault;
  return getInstitution(institutionId);
}

/**
 * Turns the academic-unit filter and the requested dimension into plain cohort
 * ids, before any attendance query runs.
 *
 * This is the boundary that keeps recursion out of the hot SQL. The tree is
 * read and walked here — see `unit-tree.ts` for why that is worth 3x — and
 * everything downstream deals in lists of ids it can bind as parameters.
 *
 * Skipped entirely when there is no unit filter and no unit-wise dimension,
 * which is the common case: a cohort-wise or day-wise report never needs to
 * know the structure exists.
 */
export async function resolveScope(
  institutionId: string,
  dimension: ReportDimension | null,
  filters: ReportFilters,
  deps: ReportingDeps = {},
): Promise<CohortScope> {
  const kind = dimension ? UNIT_KIND_BY_DIMENSION[dimension] : undefined;
  const hasUnitFilter = (filters.academicUnitIds?.length ?? 0) > 0;
  if (!kind && !hasUnitFilter) {
    return { cohortIds: filters.cohortIds ?? null, buckets: null };
  }

  const load = deps.loadUnitTreeRows ?? repo.loadUnitTreeRows;
  const { units, cohorts } = await load(institutionId);
  const tree = buildUnitTree(units, cohorts);

  const underUnits = hasUnitFilter ? cohortsUnderUnits(tree, filters.academicUnitIds ?? []) : null;
  return {
    cohortIds: intersectCohortFilters(filters.cohortIds, underUnits),
    buckets: kind ? bucketCohortsByKind(tree, kind) : null,
  };
}

/**
 * The threshold, resolved once per request.
 *
 * An explicit override is honoured (an administrator comparing "what would
 * 80% look like" is a real thing to want) but clamped, and the institution's
 * configured value is the default. No caller and no component is permitted to
 * supply its own idea of what "low" means.
 */
export async function resolveThreshold(
  institutionId: string,
  override: number | undefined,
  deps: ReportingDeps = {},
): Promise<number> {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.min(Math.max(override, 0), 100);
  }
  const institution = await loadInstitution(institutionId, deps);
  if (!institution) return resolveLowAttendanceThreshold({ settings: {} } as Institution);
  return resolveLowAttendanceThreshold(institution);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * A rollup along one dimension, paginated.
 *
 * The `results` status filter is intentionally *not* applied: a rollup
 * filtered to "absent only" reports 0% for every row, which reads as a
 * catastrophic attendance collapse rather than as a filtered view. Status
 * filtering belongs to the record listing, and `getRecords` honours it.
 */
export async function getRollup(
  actor: SessionUser,
  dimension: ReportDimension,
  filters: ReportFilters,
  request: ReportPageRequest,
  order: RollupOrder = "label",
  deps: ReportingDeps = {},
): Promise<ReportPage<ReportRollupRow>> {
  const institutionId = requireReportAccess(actor);

  const aggregate = deps.aggregateByDimension ?? repo.aggregateByDimension;
  const countSessions = deps.countSessionsByDimension ?? repo.countSessionsByDimension;
  const offset = (request.page - 1) * request.pageSize;
  const scope = await resolveScope(institutionId, dimension, filters, deps);

  const [rollupRows, sessionRows] = await Promise.all([
    aggregate(institutionId, dimension, filters, scope, order, request.pageSize, offset),
    countSessions(institutionId, dimension, filters, scope),
  ]);

  const sessionsByKey = new Map(sessionRows.map((r) => [r.key, r.sessions]));
  const rows: ReportRollupRow[] = rollupRows.map((row) => ({
    key: row.key ?? "",
    label: row.label ?? "—",
    sublabel: row.sublabel,
    rate: rateFromCounts(row.present, row.absent),
    sessionCount: sessionRows.length === 0 ? null : (sessionsByKey.get(row.key) ?? 0),
    unresolved: row.unresolved,
  }));

  return pageOf(rows, request, rollupRows[0]?.totalRows ?? 0);
}

export async function getLowAttendance(
  actor: SessionUser,
  filters: ReportFilters,
  request: ReportPageRequest,
  thresholdOverride?: number,
  deps: ReportingDeps = {},
): Promise<ReportPage<LowAttendanceRow> & { threshold: number }> {
  const institutionId = requireReportAccess(actor);
  const threshold = await resolveThreshold(institutionId, thresholdOverride, deps);

  const list = deps.listLowAttendanceStudents ?? repo.listLowAttendanceStudents;
  const offset = (request.page - 1) * request.pageSize;
  const scope = await resolveScope(institutionId, null, filters, deps);
  const sqlRows = await list(institutionId, filters, scope, threshold, request.pageSize, offset);

  const rows: LowAttendanceRow[] = sqlRows.map((row) => ({
    studentId: row.studentId,
    studentCode: row.studentCode,
    studentName: row.studentName,
    cohortName: row.cohortName ?? "",
    rate: rateFromCounts(row.present, row.absent),
  }));

  return { ...pageOf(rows, request, sqlRows[0]?.totalRows ?? 0), threshold };
}

export async function getRecords(
  actor: SessionUser,
  filters: ReportFilters,
  request: ReportPageRequest,
  deps: ReportingDeps = {},
): Promise<ReportPage<ReportRecordRow>> {
  const institutionId = requireReportAccess(actor);
  const list = deps.listRecords ?? repo.listRecords;
  const count = deps.countRecords ?? repo.countRecords;
  const offset = (request.page - 1) * request.pageSize;
  const scope = await resolveScope(institutionId, null, filters, deps);

  // Two queries rather than a windowed one. Running them together costs one
  // round trip, and keeps the page query eligible for a top-N sort; see
  // `listRecords` in the repository for the measurement.
  const [sqlRows, countRows] = await Promise.all([
    list(institutionId, filters, scope, request.pageSize, offset),
    count(institutionId, filters, scope),
  ]);

  const rows: ReportRecordRow[] = sqlRows.map((row) => ({
    attendanceRecordId: row.attendanceRecordId,
    sessionId: row.sessionId,
    sessionDate: row.sessionDate.toISOString(),
    studentId: row.studentId,
    studentCode: row.studentCode,
    studentName: row.studentName,
    cohortName: row.cohortName,
    subjectName: row.subjectName,
    subjectCode: row.subjectCode,
    facultyName: row.facultyName,
    result: row.result as ReportRecordRow["result"],
    isManuallyCorrected: row.isManuallyCorrected,
  }));

  return pageOf(rows, request, countRows[0]?.count ?? 0);
}

/**
 * The headline block.
 *
 * "Present today" and "absent today" count **confirmed** registers only, and
 * `todayAwaitingConfirmation` carries the rest. Counting an unconfirmed
 * register's provisional results into a headline would publish a number the
 * faculty member has not stood behind yet — the same rule the student portal
 * follows.
 */
export async function getOverview(
  actor: SessionUser,
  filters: ReportFilters,
  thresholdOverride?: number,
  deps: ReportingDeps = {},
): Promise<InstitutionOverview> {
  const institutionId = requireReportAccess(actor);
  const now = (deps.now ?? (() => new Date()))();
  const today = utcDayRange(now);

  const aggregateOverall = deps.aggregateOverall ?? repo.aggregateOverall;
  const countEntities = deps.countInstitutionEntities ?? repo.countInstitutionEntities;
  const countFinalized = deps.countFinalizedSessions ?? repo.countFinalizedSessions;
  const countAwaiting =
    deps.countSessionsAwaitingConfirmation ?? repo.countSessionsAwaitingConfirmation;
  const countLow = deps.countLowAttendanceStudents ?? repo.countLowAttendanceStudents;

  const threshold = await resolveThreshold(institutionId, thresholdOverride, deps);
  const institution = await loadInstitution(institutionId, deps);
  const scope = await resolveScope(institutionId, null, filters, deps);
  const todayFilters: ReportFilters = { ...filters, from: today.start, to: today.end };

  const [overallRows, todayRows, entities, finalizedSessions, awaitingToday, lowRows] =
    await Promise.all([
      aggregateOverall(institutionId, filters, scope),
      aggregateOverall(institutionId, todayFilters, scope),
      countEntities(institutionId),
      countFinalized(institutionId, filters.from, filters.to),
      countAwaiting(institutionId, today.start, today.end),
      countLow(institutionId, filters, scope, threshold),
    ]);

  return {
    institutionId,
    institutionName: institution?.name ?? "",
    attendanceMode: institution
      ? resolveAttendanceMode(institution)
      : resolveAttendanceMode({ type: "SCHOOL", settings: {} } as Institution),
    windowStart: filters.from.toISOString(),
    windowEnd: filters.to.toISOString(),
    totalStudents: entities.students,
    totalCohorts: entities.cohorts,
    finalizedSessions,
    sessionsAwaitingReview: entities.sessionsAwaitingReview,
    overall: rateFromCounts(overallRows[0]?.present ?? 0, overallRows[0]?.absent ?? 0),
    today: rateFromCounts(todayRows[0]?.present ?? 0, todayRows[0]?.absent ?? 0),
    todayAwaitingConfirmation: awaitingToday,
    lowAttendanceThreshold: threshold,
    lowAttendanceCount: lowRows[0]?.count ?? 0,
  };
}

export async function getFilterOptions(actor: SessionUser, deps: ReportingDeps = {}) {
  const institutionId = requireReportAccess(actor);
  const list = deps.listFilterOptions ?? repo.listFilterOptions;
  return list(institutionId);
}

// ---------------------------------------------------------------------------
// Export feeds
// ---------------------------------------------------------------------------

/**
 * Walks pages until the result set is exhausted or `MAX_EXPORT_ROWS` is hit.
 *
 * Returns `truncated` rather than hiding it, so the exporter can put the fact
 * in the file. A report that silently stops short is a report that will be
 * quoted in a meeting as if it were complete.
 */
export async function collectForExport<T>(
  fetchPage: (request: ReportPageRequest) => Promise<ReportPage<T>>,
  maxRows = MAX_EXPORT_ROWS,
): Promise<{ rows: T[]; truncated: boolean; totalRows: number }> {
  const rows: T[] = [];
  let page = 1;
  let totalRows = 0;
  for (;;) {
    const result = await fetchPage({ page, pageSize: EXPORT_PAGE_SIZE });
    totalRows = result.totalRows;
    rows.push(...result.rows);
    if (rows.length >= maxRows) {
      return { rows: rows.slice(0, maxRows), truncated: totalRows > maxRows, totalRows };
    }
    if (!result.hasMore || result.rows.length === 0) {
      return { rows, truncated: false, totalRows };
    }
    page += 1;
  }
}

// ---------------------------------------------------------------------------
// Export assembly
// ---------------------------------------------------------------------------

/**
 * Which of the three reports is being exported.
 *
 * The export is not a fourth report. Each kind reads the same service function
 * the screen reads, with the same filters, so a spreadsheet and the page it
 * came from cannot disagree — the only difference is that the export walks
 * every page instead of showing one.
 */
export type ReportKind = "rollup" | "low-attendance" | "records";

export function isReportKind(value: string): value is ReportKind {
  return value === "rollup" || value === "low-attendance" || value === "records";
}

/**
 * A percentage for a spreadsheet cell.
 *
 * Written as a number so the column sorts and averages, and rounded to one
 * decimal to match what the screen shows — an export that disagrees with the
 * page in the third decimal place starts an argument about which is right.
 * `null` stays blank, never 0: see `RatePercent`.
 */
function rateValue(rate: { percentage: number | null }): number | null {
  return rate.percentage === null ? null : Number(rate.percentage.toFixed(1));
}

const ROLLUP_COLUMNS: Array<ExportColumn<ReportRollupRow>> = [
  { header: "Group", value: (r) => r.label },
  { header: "Code", value: (r) => r.sublabel },
  { header: "Attendance %", value: (r) => rateValue(r.rate) },
  { header: "Present", value: (r) => r.rate.present },
  { header: "Absent", value: (r) => r.rate.absent },
  { header: "Marks", value: (r) => r.rate.total },
  { header: "Sessions", value: (r) => r.sessionCount },
  { header: "Awaiting review", value: (r) => r.unresolved },
];

const LOW_ATTENDANCE_COLUMNS: Array<ExportColumn<LowAttendanceRow>> = [
  { header: "Student code", value: (r) => r.studentCode },
  { header: "Student", value: (r) => r.studentName },
  { header: "Class", value: (r) => r.cohortName },
  { header: "Attendance %", value: (r) => rateValue(r.rate) },
  { header: "Present", value: (r) => r.rate.present },
  { header: "Absent", value: (r) => r.rate.absent },
  { header: "Marks", value: (r) => r.rate.total },
];

/**
 * `Corrected` is exported alongside the result on purpose. A record that a
 * human changed after the fact is a different kind of fact from one the engine
 * produced, and dropping that column would flatten the two into one.
 */
const RECORD_COLUMNS: Array<ExportColumn<ReportRecordRow>> = [
  { header: "Date", value: (r) => r.sessionDate.slice(0, 10) },
  { header: "Student code", value: (r) => r.studentCode },
  { header: "Student", value: (r) => r.studentName },
  { header: "Class", value: (r) => r.cohortName },
  { header: "Subject", value: (r) => r.subjectName },
  { header: "Subject code", value: (r) => r.subjectCode },
  { header: "Faculty", value: (r) => r.facultyName },
  { header: "Result", value: (r) => r.result },
  { header: "Corrected", value: (r) => (r.isManuallyCorrected ? "Yes" : "No") },
];

/** Used in the filename and as the worksheet name. */
export function exportTitle(kind: ReportKind, dimension: ReportDimension): string {
  if (kind === "records") return "attendance-records";
  if (kind === "low-attendance") return "low-attendance";
  return `attendance-by-${dimension}`;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Builds one report as a downloadable file.
 *
 * Authorization is not re-implemented here: every branch calls the same
 * `getRollup`/`getLowAttendance`/`getRecords` the screen calls, each of which
 * begins with `requireReportAccess`. There is no way to reach data through
 * this function that the caller could not already see on the page, which is
 * the property that makes a bulk-download endpoint safe to expose.
 *
 * The window is in the filename because a spreadsheet outlives the URL that
 * produced it. `attendance-by-course-2026-06-18-to-2026-09-16.xlsx` can still
 * be identified a year later; `report.xlsx` cannot.
 */
export async function buildReportExport(
  actor: SessionUser,
  kind: ReportKind,
  dimension: ReportDimension,
  filters: ReportFilters,
  format: ExportFormat,
  options: { order?: RollupOrder; thresholdOverride?: number } = {},
  deps: ReportingDeps = {},
): Promise<ExportFile & { truncated: boolean; totalRows: number }> {
  const title = exportTitle(kind, dimension);
  const filename = `${title}-${isoDay(filters.from)}-to-${isoDay(
    new Date(filters.to.getTime() - 1),
  )}`;

  const notice = (truncated: boolean, totalRows: number) =>
    truncated
      ? `Truncated: showing the first ${MAX_EXPORT_ROWS.toLocaleString("en-US")} of ` +
        `${totalRows.toLocaleString("en-US")} matching rows. Narrow the filters to export the rest.`
      : undefined;

  // Each branch is its own `collectForExport` call because the row type and
  // the column set differ; sharing them behind a generic would need a cast
  // that defeats the point of the columns being typed.
  if (kind === "records") {
    const { rows, truncated, totalRows } = await collectForExport((request) =>
      getRecords(actor, filters, request, deps),
    );
    return {
      ...buildExport(format, filename, title, RECORD_COLUMNS, rows, notice(truncated, totalRows)),
      truncated,
      totalRows,
    };
  }

  if (kind === "low-attendance") {
    const { rows, truncated, totalRows } = await collectForExport((request) =>
      getLowAttendance(actor, filters, request, options.thresholdOverride, deps),
    );
    return {
      ...buildExport(
        format,
        filename,
        title,
        LOW_ATTENDANCE_COLUMNS,
        rows,
        notice(truncated, totalRows),
      ),
      truncated,
      totalRows,
    };
  }

  const { rows, truncated, totalRows } = await collectForExport((request) =>
    getRollup(actor, dimension, filters, request, options.order ?? "label", deps),
  );
  return {
    ...buildExport(format, filename, title, ROLLUP_COLUMNS, rows, notice(truncated, totalRows)),
    truncated,
    totalRows,
  };
}
