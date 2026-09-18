import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  hasPermission,
  requirePermission,
  requireSameInstitution,
} from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getInstitutionById as getInstitutionByIdDefault } from "@/modules/institutions/repository";
import {
  DEFAULT_LOW_ATTENDANCE_THRESHOLD,
  resolveAttendanceMode,
  resolveLowAttendanceThreshold,
} from "@/modules/institutions/service";
import type { Institution } from "@/modules/institutions/types";
import * as repo from "./repository";
import type {
  CohortSubjectRow,
  CorrectionRow,
  RecordDetailRow,
  ReportRecordRow,
  SessionScope,
  SessionSummaryRow,
  SessionWithStudentsRow,
  StudentRecordRow,
} from "./repository";
import type {
  AbsentStudentEntry,
  AttendanceCorrectionEntry,
  AttendanceRate,
  CohortAttendanceHistory,
  CohortAttendanceHistoryEntry,
  CohortCorrectionEntry,
  CohortReportRow,
  DailyAttendanceSummary,
  FacultyCohortSummary,
  FacultyDashboard,
  FacultySessionSummary,
  FacultySubjectSummary,
  InstitutionAttendanceReport,
  LowAttendanceStudent,
  SessionCounts,
  StudentAttendanceDetail,
  StudentAttendanceItem,
  StudentDashboard,
  SubjectAttendanceSummary,
} from "./types";

/**
 * Phase 7 portal read models.
 *
 * Three audiences, one rule each:
 *
 *  - **Students** see their own finalized attendance and nothing else. There
 *    is no mutation in this module, and no function takes a `studentId` from
 *    the caller — the student is always resolved from the server session.
 *  - **Faculty** see the classes they teach, the subjects assigned to them,
 *    and the sessions those imply. Scope is computed once, in
 *    `resolveFacultyScope`, and every query is filtered through it.
 *  - **Institution admins** see institution-level totals, always over a
 *    stated date window.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Attendance percentage, or `null` when there is nothing to compute it from.
 *
 * Only PRESENT and ABSENT are counted. Anything unresolved is excluded from
 * *both* numerator and denominator rather than treated as an absence —
 * finalization already guarantees there is nothing unresolved in a visible
 * register, and if that ever fails, a review row must not read as "missed".
 */
export function rateOf(results: Array<{ finalResult: string }>): AttendanceRate {
  let present = 0;
  let absent = 0;
  for (const r of results) {
    if (r.finalResult === "PRESENT") present++;
    else if (r.finalResult === "ABSENT") absent++;
  }
  return rateFromCounts(present, absent);
}

/**
 * The same rate, from counts that were already aggregated elsewhere — by
 * Postgres, in the reporting module's `GROUP BY`.
 *
 * Shared rather than reimplemented so a percentage cannot mean one thing on a
 * portal and a slightly different thing on a report. The rounding in
 * particular is load-bearing: 18/22 must read as 81.8% wherever it appears.
 */
export function rateFromCounts(present: number, absent: number): AttendanceRate {
  const total = present + absent;
  return {
    present,
    absent,
    total,
    // One decimal place: 18/22 → 81.8%, matching how institutions quote it.
    percentage: total === 0 ? null : Math.round((present / total) * 1000) / 10,
  };
}

export function sessionCountsOf(records: Array<{ finalResult: string }>): SessionCounts {
  let present = 0;
  let absent = 0;
  let needsReview = 0;
  for (const r of records) {
    if (r.finalResult === "PRESENT") present++;
    else if (r.finalResult === "ABSENT") absent++;
    // NEEDS_REVIEW and NOT_EVALUATED are the same thing to a reader: a human
    // still owes this row a decision.
    else needsReview++;
  }
  return { total: records.length, present, absent, needsReview };
}

/**
 * Half-open UTC day containing `at`. Matches
 * `sessions/repository.ts#findExistingDailySession` exactly — "today" has to
 * mean the same thing to the portal as it does to the uniqueness check that
 * decides whether today's session already exists.
 */
export function utcDayRange(at: Date): { start: Date; end: Date } {
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function fullName(s: { firstName: string; lastName: string }): string {
  return `${s.firstName} ${s.lastName}`.trim();
}

/**
 * Every portal here is institution-scoped. A platform-level user has no
 * institution of their own, so "my classes" and "my institution's report"
 * have no referent for them — they reach an institution through the platform
 * tooling instead. Refusing is better than rendering an empty dashboard that
 * looks like an institution with no data.
 */
function requireInstitutionScope(actor: SessionUser): string {
  if (!actor.institutionId) throw new ForbiddenError("institution_scope_required");
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * A repository function, as an injectable dependency.
 *
 * Repository functions that hand a Prisma builder straight back return one of
 * Prisma's own thenables (`PrismaPromise`, `Prisma__CohortClient`) rather than
 * a plain `Promise`. Those types carry a branded `[Symbol.toStringTag]` and
 * extra relation methods, so a test's plain async stub is not assignable to
 * `typeof repo.x`. Declaring deps in terms of the *awaited* result keeps the
 * contract at "returns this data", which is the only part a caller — or a
 * substitute — actually has to honour.
 */
type AsDep<F> = F extends (...args: infer A) => PromiseLike<infer R>
  ? (...args: A) => Promise<R>
  : never;

export interface AnalyticsDeps {
  getStudentProfileByUserId?: AsDep<typeof repo.getStudentProfileByUserId>;
  listFinalizedRecordsForStudent?: AsDep<typeof repo.listFinalizedRecordsForStudent>;
  listActiveCohortIdsForStudent?: AsDep<typeof repo.listActiveCohortIdsForStudent>;
  countUnconfirmedSessionsToday?: AsDep<typeof repo.countUnconfirmedSessionsToday>;
  getAttendanceRecordDetail?: AsDep<typeof repo.getAttendanceRecordDetail>;
  listCohortFacultyLinks?: AsDep<typeof repo.listCohortFacultyLinks>;
  listCohortsForInstitution?: AsDep<typeof repo.listCohortsForInstitution>;
  countActiveEnrollmentsPerCohort?: AsDep<typeof repo.countActiveEnrollmentsPerCohort>;
  listCohortSubjectsForFaculty?: AsDep<typeof repo.listCohortSubjectsForFaculty>;
  listCohortSubjectsForInstitution?: AsDep<typeof repo.listCohortSubjectsForInstitution>;
  listSessionsInScope?: AsDep<typeof repo.listSessionsInScope>;
  listLastSessionDatePerCohort?: AsDep<typeof repo.listLastSessionDatePerCohort>;
  getCohortHeader?: AsDep<typeof repo.getCohortHeader>;
  listCohortSessionsWithStudents?: AsDep<typeof repo.listCohortSessionsWithStudents>;
  listCorrectionsForCohort?: AsDep<typeof repo.listCorrectionsForCohort>;
  countInstitutionTotals?: AsDep<typeof repo.countInstitutionTotals>;
  listFinalizedRecordsForInstitution?: AsDep<typeof repo.listFinalizedRecordsForInstitution>;
  countSessionsPerCohort?: AsDep<typeof repo.countSessionsPerCohort>;
  listCohortStudentCounts?: AsDep<typeof repo.listCohortStudentCounts>;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  now?: () => Date;
}

/**
 * The two institution-configured numbers every attendance view needs, loaded
 * together because they come from the same row.
 *
 * `lowAttendanceThreshold` is returned here rather than left to the page so
 * that no component has to decide for itself what counts as low attendance.
 * A missing institution falls back to the platform defaults instead of
 * throwing: these are display concerns, and a dashboard that renders with the
 * default rule is better than one that 500s.
 */
async function attendanceModeFor(
  institutionId: string,
  deps: AnalyticsDeps,
): Promise<{
  mode: "DAILY" | "SUBJECT_WISE";
  lowAttendanceThreshold: number;
  institution: Institution | null;
}> {
  const getInstitution = deps.getInstitutionById ?? getInstitutionByIdDefault;
  const institution = await getInstitution(institutionId);
  return {
    mode: institution ? resolveAttendanceMode(institution) : "DAILY",
    lowAttendanceThreshold: institution
      ? resolveLowAttendanceThreshold(institution)
      : DEFAULT_LOW_ATTENDANCE_THRESHOLD,
    institution,
  };
}

// ---------------------------------------------------------------------------
// Student portal
// ---------------------------------------------------------------------------

function toStudentItem(row: StudentRecordRow): StudentAttendanceItem {
  return {
    attendanceRecordId: row.id,
    sessionId: row.session.id,
    sessionDate: row.session.sessionDate.toISOString(),
    result: row.finalResult,
    isManuallyCorrected: row.isManuallyCorrected,
    cohortName: row.session.cohort?.name ?? "",
    subjectName: row.session.cohortSubject?.subject?.name ?? null,
    subjectCode: row.session.cohortSubject?.subject?.code ?? null,
  };
}

/**
 * Per-subject attendance for a college student.
 *
 * Grouped by `cohortSubjectId`, not by subject name: the same subject taught
 * to two cohorts is two different registers with two different denominators,
 * and merging them would produce a percentage that belongs to neither.
 * Sessions with no subject (a daily register in a college) are skipped here
 * and still counted in `overall`.
 */
export function summarizeBySubject(rows: StudentRecordRow[]): SubjectAttendanceSummary[] {
  const buckets = new Map<
    string,
    { name: string; code: string; faculty: string | null; rows: StudentRecordRow[] }
  >();
  for (const row of rows) {
    const id = row.session.cohortSubjectId;
    if (!id) continue;
    const existing = buckets.get(id);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    buckets.set(id, {
      name: row.session.cohortSubject?.subject?.name ?? "Subject",
      code: row.session.cohortSubject?.subject?.code ?? "",
      faculty: row.session.cohortSubject?.faculty?.name ?? null,
      rows: [row],
    });
  }
  return Array.from(buckets.entries())
    .map(([cohortSubjectId, b]) => ({
      cohortSubjectId,
      subjectName: b.name,
      subjectCode: b.code,
      facultyName: b.faculty,
      rate: rateOf(b.rows),
    }))
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

/** School view: one line per day, newest first. */
export function summarizeByDay(rows: StudentRecordRow[]): DailyAttendanceSummary[] {
  return rows.map((row) => ({
    sessionDate: row.session.sessionDate.toISOString(),
    cohortName: row.session.cohort?.name ?? "",
    result: row.finalResult,
    attendanceRecordId: row.id,
    isManuallyCorrected: row.isManuallyCorrected,
  }));
}

/**
 * The student dashboard: today, overall, and the breakdown their institution
 * actually uses (subject-wise for college, day-by-day for school).
 *
 * Returns `null` when the signed-in user has no `Student` row — a STUDENT
 * account that was never linked. The caller renders an explanation rather
 * than an empty dashboard that implies zero attendance.
 */
export async function getStudentDashboard(
  actor: SessionUser,
  deps: AnalyticsDeps = {},
): Promise<StudentDashboard | null> {
  requirePermission(actor, "attendanceRecord.read.own");

  const findStudent = deps.getStudentProfileByUserId ?? repo.getStudentProfileByUserId;
  const student = await findStudent(actor.userId);
  if (!student) return null;

  const listRecords = deps.listFinalizedRecordsForStudent ?? repo.listFinalizedRecordsForStudent;
  const rows = await listRecords(student.id);

  const now = (deps.now ?? (() => new Date()))();
  const { start, end } = utcDayRange(now);

  const listCohortIds = deps.listActiveCohortIdsForStudent ?? repo.listActiveCohortIdsForStudent;
  const countUnconfirmed = deps.countUnconfirmedSessionsToday ?? repo.countUnconfirmedSessionsToday;
  const cohortIds = await listCohortIds(student.id);
  const todayAwaitingConfirmation = await countUnconfirmed(cohortIds, start, end);

  const { mode, lowAttendanceThreshold } = await attendanceModeFor(student.institutionId, deps);

  const today = rows.filter((r) => isSameUtcDay(r.session.sessionDate, now)).map(toStudentItem);

  return {
    studentId: student.id,
    studentCode: student.studentCode,
    fullName: fullName(student),
    attendanceMode: mode,
    lowAttendanceThreshold,
    today,
    todayAwaitingConfirmation,
    overall: rateOf(rows),
    subjects: mode === "SUBJECT_WISE" ? summarizeBySubject(rows) : [],
    daily: summarizeByDay(rows).slice(0, 30),
    recent: rows.slice(0, 10).map(toStudentItem),
  };
}

function toCorrectionEntry(c: {
  id: string;
  previousResult: string;
  newResult: string;
  reason: string | null;
  source: string;
  changedAt: Date;
  changedBy: { name: string } | null;
}): AttendanceCorrectionEntry {
  return {
    id: c.id,
    previousResult: c.previousResult as AttendanceCorrectionEntry["previousResult"],
    newResult: c.newResult as AttendanceCorrectionEntry["newResult"],
    reason: c.reason,
    source: c.source as AttendanceCorrectionEntry["source"],
    changedAt: c.changedAt.toISOString(),
    changedByName: c.changedBy?.name ?? null,
  };
}

function readGenerationSource(metadata: unknown): "recognition" | "manual" | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const bucket = (metadata as Record<string, unknown>).attendanceReview;
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return null;
  const source = (bucket as Record<string, unknown>).generationSource;
  return source === "recognition" || source === "manual" ? source : null;
}

function readCaptureCount(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const bucket = (metadata as Record<string, unknown>).attendanceReview;
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return 0;
  const images = (bucket as Record<string, unknown>).captureImages;
  return Array.isArray(images) ? images.length : 0;
}

function readFinalizedAt(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const bucket = (metadata as Record<string, unknown>).attendanceReview;
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return null;
  const at = (bucket as Record<string, unknown>).finalizedAt;
  return typeof at === "string" ? at : null;
}

export function toStudentDetail(row: RecordDetailRow): StudentAttendanceDetail {
  return {
    attendanceRecordId: row.id,
    sessionId: row.session.id,
    sessionDate: row.session.sessionDate.toISOString(),
    startedAt: row.session.startedAt.toISOString(),
    endedAt: row.session.endedAt?.toISOString() ?? null,
    cohortName: row.session.cohort?.name ?? "",
    subjectName: row.session.cohortSubject?.subject?.name ?? null,
    subjectCode: row.session.cohortSubject?.subject?.code ?? null,
    // The subject's assigned faculty is who owns the class; the session's
    // faculty is whoever ran it that day (a substitute, for instance). The
    // person accountable for *this* register is the one who ran it.
    facultyName: row.session.faculty?.name ?? row.session.cohortSubject?.faculty?.name ?? null,
    result: row.finalResult,
    isManuallyCorrected: row.isManuallyCorrected,
    finalizedAt: readFinalizedAt(row.session.metadata) ?? row.session.endedAt?.toISOString() ?? null,
    generationSource: readGenerationSource(row.session.metadata),
    captureCount: readCaptureCount(row.session.metadata),
    corrections: row.corrections.map(toCorrectionEntry),
  };
}

/**
 * One of the caller's own attendance records, opened.
 *
 * Two independent gates: the record must belong to the `Student` row linked to
 * the signed-in user, and the session must be FINALIZED. The first stops a
 * student reading somebody else's attendance by guessing an id; the second
 * stops them reading a draft register — including their own.
 */
export async function getOwnAttendanceDetail(
  actor: SessionUser,
  attendanceRecordId: string,
  deps: AnalyticsDeps = {},
): Promise<StudentAttendanceDetail | null> {
  requirePermission(actor, "attendanceRecord.read.own");

  const findStudent = deps.getStudentProfileByUserId ?? repo.getStudentProfileByUserId;
  const student = await findStudent(actor.userId);
  if (!student) return null;

  const getDetail = deps.getAttendanceRecordDetail ?? repo.getAttendanceRecordDetail;
  const row = await getDetail(attendanceRecordId);
  if (!row) return null;
  if (row.studentId !== student.id) throw new ForbiddenError("not_your_attendance_record");
  if (row.session.status !== "FINALIZED") return null;

  return toStudentDetail(row);
}

// ---------------------------------------------------------------------------
// Faculty scope
// ---------------------------------------------------------------------------

export interface FacultyScope {
  scope: SessionScope;
  kind: "assigned" | "institution";
  cohorts: FacultyCohortSummary[];
  subjects: FacultySubjectSummary[];
  isClassTeacher: boolean;
}

function toSubjectSummary(row: CohortSubjectRow): FacultySubjectSummary {
  return {
    cohortSubjectId: row.id,
    cohortId: row.cohortId,
    cohortName: row.cohort?.name ?? "",
    subjectName: row.subject?.name ?? "Subject",
    subjectCode: row.subject?.code ?? "",
  };
}

/**
 * What this faculty member is allowed to see, resolved once.
 *
 * An actor with `cohort.manage` administers the institution and gets an
 * unrestricted scope. Everyone else gets the union of:
 *
 *   - classes they are linked to via `CohortFaculty` (school class teacher,
 *     or a college lecturer attached to the class), and
 *   - subjects assigned to them via `CohortSubject.facultyId`.
 *
 * A college lecturer with only subject assignments therefore sees their
 * subjects' sessions and nothing else from that class — which is the Phase 7
 * rule, and also why the union is expressed as two clauses rather than
 * collapsed into a list of cohort ids.
 */
export async function resolveFacultyScope(
  actor: SessionUser,
  deps: AnalyticsDeps = {},
): Promise<FacultyScope> {
  const isAdmin = hasPermission(actor, "cohort.manage");
  const institutionId = requireInstitutionScope(actor);

  const countEnrollments =
    deps.countActiveEnrollmentsPerCohort ?? repo.countActiveEnrollmentsPerCohort;
  const lastSessions = deps.listLastSessionDatePerCohort ?? repo.listLastSessionDatePerCohort;

  if (isAdmin) {
    const listCohorts = deps.listCohortsForInstitution ?? repo.listCohortsForInstitution;
    const listSubjects =
      deps.listCohortSubjectsForInstitution ?? repo.listCohortSubjectsForInstitution;
    const [cohortRows, subjectRows] = await Promise.all([
      listCohorts(institutionId),
      listSubjects(institutionId),
    ]);
    const cohortIds = cohortRows.map((c) => c.id);
    const [counts, last] = await Promise.all([
      countEnrollments(cohortIds),
      lastSessions(cohortIds),
    ]);
    const countBy = new Map(counts.map((c) => [c.cohortId, c.students]));
    const lastBy = new Map(last.map((l) => [l.cohortId, l.sessionDate]));
    return {
      scope: { institutionId, cohortIds: null, cohortSubjectIds: [] },
      kind: "institution",
      cohorts: cohortRows.map((c) => ({
        cohortId: c.id,
        name: c.name,
        termLabel: c.termLabel,
        studentCount: countBy.get(c.id) ?? 0,
        facultyRole: "ADMIN" as const,
        lastSessionDate: lastBy.get(c.id)?.toISOString() ?? null,
      })),
      subjects: subjectRows.map(toSubjectSummary),
      isClassTeacher: false,
    };
  }

  const listLinks = deps.listCohortFacultyLinks ?? repo.listCohortFacultyLinks;
  const listSubjects = deps.listCohortSubjectsForFaculty ?? repo.listCohortSubjectsForFaculty;
  const [linkRows, subjectRows] = await Promise.all([
    listLinks(actor.userId),
    listSubjects(actor.userId, institutionId),
  ]);

  // Tenancy: a faculty link or subject assignment in another institution is
  // not visible from this session, whatever the database says.
  const links = linkRows.filter((l) => l.cohort?.institutionId === institutionId);
  const subjects = subjectRows.filter((s) => s.cohort?.institutionId === institutionId);

  const linkedCohortIds = links.map((l) => l.cohortId);
  const cohortById = new Map<
    string,
    { name: string; termLabel: string | null; role: "PRIMARY" | "ASSISTANT" }
  >();
  for (const link of links) {
    cohortById.set(link.cohortId, {
      name: link.cohort?.name ?? "",
      termLabel: link.cohort?.termLabel ?? null,
      role: link.role === "PRIMARY" ? "PRIMARY" : "ASSISTANT",
    });
  }
  for (const subject of subjects) {
    if (cohortById.has(subject.cohortId)) continue;
    // Reached through a subject only: they teach into this class without
    // being its class teacher.
    cohortById.set(subject.cohortId, {
      name: subject.cohort?.name ?? "",
      termLabel: null,
      role: "ASSISTANT",
    });
  }

  const allCohortIds = Array.from(cohortById.keys());
  const [counts, last] = await Promise.all([
    countEnrollments(allCohortIds),
    lastSessions(allCohortIds),
  ]);
  const countBy = new Map(counts.map((c) => [c.cohortId, c.students]));
  const lastBy = new Map(last.map((l) => [l.cohortId, l.sessionDate]));

  return {
    scope: {
      institutionId,
      cohortIds: linkedCohortIds,
      cohortSubjectIds: subjects.map((s) => s.id),
    },
    kind: "assigned",
    cohorts: Array.from(cohortById.entries())
      .map(([cohortId, c]) => ({
        cohortId,
        name: c.name,
        termLabel: c.termLabel,
        studentCount: countBy.get(cohortId) ?? 0,
        facultyRole: c.role,
        lastSessionDate: lastBy.get(cohortId)?.toISOString() ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    subjects: subjects.map(toSubjectSummary),
    isClassTeacher: links.some((l) => l.role === "PRIMARY"),
  };
}

function toSessionSummary(row: SessionSummaryRow): FacultySessionSummary {
  return {
    sessionId: row.id,
    cohortId: row.cohortId,
    cohortName: row.cohort?.name ?? "",
    subjectName: row.cohortSubject?.subject?.name ?? null,
    subjectCode: row.cohortSubject?.subject?.code ?? null,
    sessionDate: row.sessionDate.toISOString(),
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    counts: sessionCountsOf(row.attendanceRecords),
    facultyName: row.faculty?.name ?? null,
  };
}

/**
 * The faculty dashboard. Four queries against one scope: today's sessions,
 * the review queue, recently finalized registers, and the class/subject lists
 * that come from the scope itself.
 */
export async function getFacultyDashboard(
  actor: SessionUser,
  deps: AnalyticsDeps = {},
): Promise<FacultyDashboard> {
  requirePermission(actor, "attendanceRecord.read");

  const institutionId = requireInstitutionScope(actor);
  const resolved = await resolveFacultyScope(actor, deps);
  const listSessions = deps.listSessionsInScope ?? repo.listSessionsInScope;
  const now = (deps.now ?? (() => new Date()))();
  const { start, end } = utcDayRange(now);

  const [todayRows, reviewRows, recentRows] = await Promise.all([
    listSessions(
      resolved.scope,
      { sessionDate: { gte: start, lt: end }, status: { not: "CANCELLED" } },
      25,
    ),
    listSessions(resolved.scope, { status: "REVIEW" }, 10),
    listSessions(resolved.scope, { status: "FINALIZED" }, 8),
  ]);

  const { mode } = await attendanceModeFor(institutionId, deps);

  return {
    attendanceMode: mode,
    scope: resolved.kind,
    today: todayRows.map(toSessionSummary),
    cohorts: resolved.cohorts,
    subjects: resolved.subjects,
    pendingReview: reviewRows.map(toSessionSummary),
    recent: recentRows.map(toSessionSummary),
    isClassTeacher: resolved.isClassTeacher,
  };
}

// ---------------------------------------------------------------------------
// Class attendance history
// ---------------------------------------------------------------------------

function toCohortCorrection(row: CorrectionRow): CohortCorrectionEntry {
  const student = row.attendanceRecord?.student;
  return {
    ...toCorrectionEntry(row),
    studentCode: student?.studentCode ?? "",
    studentName: student ? fullName(student) : "Unknown student",
    sessionDate: row.attendanceRecord?.session?.sessionDate.toISOString() ?? "",
    sessionId: row.attendanceRecord?.session?.id ?? "",
  };
}

function toHistoryEntry(row: SessionWithStudentsRow): CohortAttendanceHistoryEntry {
  const records = row.attendanceRecords;
  const isFinalized = row.status === "FINALIZED";
  return {
    sessionId: row.id,
    cohortId: row.cohortId,
    cohortName: row.cohort?.name ?? "",
    subjectName: row.cohortSubject?.subject?.name ?? null,
    subjectCode: row.cohortSubject?.subject?.code ?? null,
    sessionDate: row.sessionDate.toISOString(),
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    counts: sessionCountsOf(records),
    facultyName: row.faculty?.name ?? null,
    rate: rateOf(records),
    absentStudents: records
      .filter((r) => r.finalResult === "ABSENT")
      .map(
        (r): AbsentStudentEntry => ({
          studentId: r.student?.id ?? "",
          studentCode: r.student?.studentCode ?? "",
          firstName: r.student?.firstName ?? "Unknown",
          lastName: r.student?.lastName ?? "student",
          isManuallyCorrected: r.isManuallyCorrected,
        }),
      )
      .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)),
    isFinalized,
  };
}

/**
 * Read access to one class's history.
 *
 * Intentionally a little wider than `requireCohortAccess`, and only for
 * reading: a college lecturer with no `CohortFaculty` row still needs the
 * history of the subject assigned to them. When that is the only basis for
 * access, the returned history is filtered down to their own subjects'
 * sessions. `requireCohortAccess` itself is untouched — every write path
 * still goes through it unchanged.
 */
async function resolveCohortViewScope(
  actor: SessionUser,
  cohortId: string,
  deps: AnalyticsDeps,
): Promise<{ restrictToCohortSubjectIds: string[] | undefined; isClassTeacher: boolean }> {
  if (hasPermission(actor, "cohort.manage")) {
    return { restrictToCohortSubjectIds: undefined, isClassTeacher: false };
  }
  const institutionId = requireInstitutionScope(actor);
  const listLinks = deps.listCohortFacultyLinks ?? repo.listCohortFacultyLinks;
  const links = await listLinks(actor.userId);
  const link = links.find(
    (l) => l.cohortId === cohortId && l.cohort?.institutionId === institutionId,
  );
  if (link) {
    return { restrictToCohortSubjectIds: undefined, isClassTeacher: link.role === "PRIMARY" };
  }
  const listSubjects = deps.listCohortSubjectsForFaculty ?? repo.listCohortSubjectsForFaculty;
  const subjects = (await listSubjects(actor.userId, institutionId)).filter(
    (s) => s.cohortId === cohortId,
  );
  if (subjects.length === 0) throw new ForbiddenError("cohort_access_denied");
  return { restrictToCohortSubjectIds: subjects.map((s) => s.id), isClassTeacher: false };
}

/**
 * Class attendance, daily attendance, absent students, history, corrections —
 * the class-teacher view, and the per-subject view for a college lecturer.
 */
export async function getCohortAttendanceHistory(
  actor: SessionUser,
  cohortId: string,
  deps: AnalyticsDeps = {},
  take = 30,
): Promise<CohortAttendanceHistory> {
  requirePermission(actor, "attendanceRecord.read");

  const getHeader = deps.getCohortHeader ?? repo.getCohortHeader;
  const cohort = await getHeader(cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const { restrictToCohortSubjectIds } = await resolveCohortViewScope(actor, cohortId, deps);

  const listSessions = deps.listCohortSessionsWithStudents ?? repo.listCohortSessionsWithStudents;
  const listCorrections = deps.listCorrectionsForCohort ?? repo.listCorrectionsForCohort;
  const countEnrollments =
    deps.countActiveEnrollmentsPerCohort ?? repo.countActiveEnrollmentsPerCohort;

  const [sessionRows, correctionRows, counts] = await Promise.all([
    listSessions(cohortId, take, restrictToCohortSubjectIds),
    listCorrections(cohortId, 25, restrictToCohortSubjectIds),
    countEnrollments([cohortId]),
  ]);

  const sessions = sessionRows.map(toHistoryEntry);
  const { mode, lowAttendanceThreshold } = await attendanceModeFor(cohort.institutionId, deps);

  // Overall is computed from finalized sessions only: a register still in
  // review has no result to average.
  const finalizedRecords = sessionRows
    .filter((s) => s.status === "FINALIZED")
    .flatMap((s) => s.attendanceRecords);

  return {
    cohortId: cohort.id,
    cohortName: cohort.name,
    termLabel: cohort.termLabel,
    attendanceMode: mode,
    lowAttendanceThreshold,
    studentCount: counts[0]?.students ?? 0,
    overall: rateOf(finalizedRecords),
    sessions,
    corrections: correctionRows.map(toCohortCorrection),
  };
}

// ---------------------------------------------------------------------------
// Institution report — superseded
// ---------------------------------------------------------------------------

/**
 * The Phase 7 institution report. Nothing renders it any more.
 *
 * `/dashboard/reports` is now served by `modules/attendance-reporting`, which
 * aggregates in PostgreSQL. This path does the same arithmetic in JavaScript,
 * which means loading every finalized record in the window to count it: on a
 * 482,760-record institution that measured 5.5 s and 238 MB of heap, against
 * 25 ms for the same figures from a `GROUP BY`. It also cannot filter,
 * paginate, or group by anything but class and student.
 *
 * Left in place rather than deleted because the standing instruction for this
 * phase is that existing behaviour must keep working exactly as it is, and
 * deleting a module's public functions is not that. Its tests still pass. But
 * it is a dead end: anything new belongs in `attendance-reporting`.
 *
 * @deprecated Use `modules/attendance-reporting/service` instead.
 */
export const DEFAULT_REPORT_WINDOW_DAYS = 90;
// Re-exported, not redefined: the threshold has exactly one definition, in the
// institutions module, next to the settings key that overrides it.
export { DEFAULT_LOW_ATTENDANCE_THRESHOLD };

/**
 * Aggregates the report's two rollups — per class, and per student — from one
 * pass over the window's finalized records. Pure, so the arithmetic is
 * testable without a database.
 *
 * @deprecated Superseded by `attendance-reporting`, which groups in SQL.
 */
export function buildReportRollups(
  records: ReportRecordRow[],
  threshold: number,
): { cohorts: Map<string, CohortReportRow>; lowAttendance: LowAttendanceStudent[] } {
  const byCohort = new Map<string, { name: string; termLabel: string | null; rows: ReportRecordRow[] }>();
  const byStudent = new Map<
    string,
    { code: string; name: string; cohortName: string; rows: ReportRecordRow[] }
  >();

  for (const record of records) {
    const cohortId = record.session?.cohortId;
    if (!cohortId) continue;
    const cohortName = record.session?.cohort?.name ?? "";
    const cohortBucket = byCohort.get(cohortId);
    if (cohortBucket) cohortBucket.rows.push(record);
    else
      byCohort.set(cohortId, {
        name: cohortName,
        termLabel: record.session?.cohort?.termLabel ?? null,
        rows: [record],
      });

    const studentBucket = byStudent.get(record.studentId);
    if (studentBucket) studentBucket.rows.push(record);
    else
      byStudent.set(record.studentId, {
        code: record.student?.studentCode ?? "",
        name: record.student ? fullName(record.student) : "Unknown student",
        cohortName,
        rows: [record],
      });
  }

  const cohorts = new Map<string, CohortReportRow>();
  for (const [cohortId, b] of byCohort) {
    cohorts.set(cohortId, {
      cohortId,
      cohortName: b.name,
      termLabel: b.termLabel,
      studentCount: 0,
      sessionCount: 0,
      rate: rateOf(b.rows),
    });
  }

  const lowAttendance: LowAttendanceStudent[] = [];
  for (const [studentId, b] of byStudent) {
    const rate = rateOf(b.rows);
    // A student with no decided rows has no percentage, and "no data" is not
    // "below threshold" — they are left out rather than reported as at risk.
    if (rate.percentage === null || rate.percentage >= threshold) continue;
    lowAttendance.push({
      studentId,
      studentCode: b.code,
      fullName: b.name,
      cohortName: b.cohortName,
      rate,
    });
  }
  lowAttendance.sort((a, b) => (a.rate.percentage ?? 0) - (b.rate.percentage ?? 0));

  return { cohorts, lowAttendance };
}

export interface InstitutionReportOptions {
  windowDays?: number;
  lowAttendanceThreshold?: number;
}

/**
 * Institution-level attendance reporting for an institution admin.
 *
 * Requires both `institution.read` (this is institution-scoped data) and
 * `attendanceRecord.read` (it is attendance data) — a role holding only one
 * of the two has not been granted this view.
 *
 * @deprecated No longer rendered anywhere. `/dashboard/reports` is served by
 * `modules/attendance-reporting/service`, which applies the same two
 * permission checks and aggregates in PostgreSQL instead of in memory.
 */
export async function getInstitutionAttendanceReport(
  actor: SessionUser,
  options: InstitutionReportOptions = {},
  deps: AnalyticsDeps = {},
): Promise<InstitutionAttendanceReport> {
  requirePermission(actor, "institution.read");
  requirePermission(actor, "attendanceRecord.read");

  const windowDays = Math.min(Math.max(options.windowDays ?? DEFAULT_REPORT_WINDOW_DAYS, 1), 365);
  const threshold = Math.min(
    Math.max(options.lowAttendanceThreshold ?? DEFAULT_LOW_ATTENDANCE_THRESHOLD, 0),
    100,
  );

  const now = (deps.now ?? (() => new Date()))();
  const { end } = utcDayRange(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);

  const institutionId = requireInstitutionScope(actor);
  const countTotals = deps.countInstitutionTotals ?? repo.countInstitutionTotals;
  const listRecords =
    deps.listFinalizedRecordsForInstitution ?? repo.listFinalizedRecordsForInstitution;
  const countSessions = deps.countSessionsPerCohort ?? repo.countSessionsPerCohort;
  const countStudents = deps.listCohortStudentCounts ?? repo.listCohortStudentCounts;

  const [totals, records, sessionsPerCohort, studentsPerCohort, { mode, institution }] =
    await Promise.all([
      countTotals(institutionId, start, end),
      listRecords(institutionId, start, end),
      countSessions(institutionId, start, end),
      countStudents(institutionId),
      attendanceModeFor(institutionId, deps),
    ]);

  const { cohorts, lowAttendance } = buildReportRollups(records, threshold);
  const sessionsBy = new Map(sessionsPerCohort.map((s) => [s.cohortId, s.sessions]));
  const studentsBy = new Map(studentsPerCohort.map((s) => [s.cohortId, s.students]));
  for (const [cohortId, row] of cohorts) {
    row.sessionCount = sessionsBy.get(cohortId) ?? 0;
    row.studentCount = studentsBy.get(cohortId) ?? 0;
  }

  return {
    institutionId,
    institutionName: institution?.name ?? "",
    attendanceMode: mode,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    windowDays,
    totals,
    overall: rateOf(records),
    cohorts: Array.from(cohorts.values()).sort((a, b) =>
      a.cohortName.localeCompare(b.cohortName),
    ),
    lowAttendanceThreshold: threshold,
    lowAttendance,
  };
}
