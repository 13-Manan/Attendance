import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Read-only queries behind the Phase 7 portals.
 *
 * Thin by design: every function here is a shaped `findMany`/`count` and
 * nothing else. All the arithmetic — percentages, bucketing, the decision
 * about what a given role is allowed to be told — lives in `service.ts`,
 * where it can be tested without a database.
 */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Which sessions an actor may be shown.
 *
 * `cohortIds: null` means "everything in the institution" and is only ever
 * produced for an actor holding `cohort.manage`. For everyone else the scope
 * is the explicit union of the classes they are faculty on and the subjects
 * assigned to them — which is exactly the Phase 7 rule that college faculty
 * see only their assigned subjects, assigned classes, and permitted sessions.
 */
export interface SessionScope {
  institutionId: string;
  cohortIds: string[] | null;
  cohortSubjectIds: string[];
}

export function sessionScopeWhere(scope: SessionScope): Prisma.AttendanceSessionWhereInput {
  if (scope.cohortIds === null) {
    return { institutionId: scope.institutionId };
  }
  return {
    institutionId: scope.institutionId,
    OR: [
      { cohortId: { in: scope.cohortIds } },
      // `{ in: [] }` matches nothing, which is the right answer for a faculty
      // member with no assignments yet — but Prisma rejects an empty OR, so
      // the cohort clause above always carries the array.
      { cohortSubjectId: { in: scope.cohortSubjectIds } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared selects
// ---------------------------------------------------------------------------

const SESSION_SUMMARY_SELECT = {
  id: true,
  cohortId: true,
  sessionDate: true,
  startedAt: true,
  status: true,
  cohort: { select: { name: true } },
  cohortSubject: { select: { subject: { select: { name: true, code: true } } } },
  faculty: { select: { name: true } },
  attendanceRecords: { select: { finalResult: true } },
} as const;

const SESSION_WITH_STUDENTS_SELECT = {
  ...SESSION_SUMMARY_SELECT,
  attendanceRecords: {
    select: {
      finalResult: true,
      isManuallyCorrected: true,
      student: { select: { id: true, studentCode: true, firstName: true, lastName: true } },
    },
  },
} as const;

export type SessionSummaryRow = Prisma.AttendanceSessionGetPayload<{
  select: typeof SESSION_SUMMARY_SELECT;
}>;

export type SessionWithStudentsRow = Prisma.AttendanceSessionGetPayload<{
  select: typeof SESSION_WITH_STUDENTS_SELECT;
}>;

// ---------------------------------------------------------------------------
// Student
// ---------------------------------------------------------------------------

export function getStudentProfileByUserId(userId: string) {
  return prisma.student.findUnique({
    where: { userId },
    select: {
      id: true,
      institutionId: true,
      studentCode: true,
      firstName: true,
      lastName: true,
    },
  });
}

const STUDENT_RECORD_SELECT = {
  id: true,
  finalResult: true,
  isManuallyCorrected: true,
  session: {
    select: {
      id: true,
      sessionDate: true,
      cohortSubjectId: true,
      cohort: { select: { name: true } },
      cohortSubject: {
        select: {
          subject: { select: { name: true, code: true } },
          faculty: { select: { name: true } },
        },
      },
    },
  },
} as const;

export type StudentRecordRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof STUDENT_RECORD_SELECT;
}>;

/**
 * Every finalized attendance row for one student.
 *
 * Unbounded on purpose: this is the denominator of the overall percentage and
 * of every per-subject percentage, and a `take` here would silently turn
 * "your attendance" into "your attendance over the last N classes". One
 * student's rows for one academic session are in the hundreds.
 */
export function listFinalizedRecordsForStudent(studentId: string): Promise<StudentRecordRow[]> {
  return prisma.attendanceRecord.findMany({
    where: { studentId, session: { status: "FINALIZED" } },
    select: STUDENT_RECORD_SELECT,
    orderBy: [{ session: { sessionDate: "desc" } }, { session: { startedAt: "desc" } }],
  });
}

export function listActiveCohortIdsForStudent(studentId: string): Promise<string[]> {
  return prisma.enrollment
    .findMany({ where: { studentId, status: "ACTIVE" }, select: { cohortId: true } })
    .then((rows) => rows.map((r) => r.cohortId));
}

/**
 * Sessions held today in the student's classes whose register is not closed.
 * Counted, never listed: the student learns a result is pending, not what it
 * provisionally says.
 */
export function countUnconfirmedSessionsToday(
  cohortIds: string[],
  dayStart: Date,
  dayEnd: Date,
): Promise<number> {
  if (cohortIds.length === 0) return Promise.resolve(0);
  return prisma.attendanceSession.count({
    where: {
      cohortId: { in: cohortIds },
      sessionDate: { gte: dayStart, lt: dayEnd },
      status: { notIn: ["FINALIZED", "CANCELLED"] },
    },
  });
}

const RECORD_DETAIL_SELECT = {
  id: true,
  studentId: true,
  finalResult: true,
  isManuallyCorrected: true,
  session: {
    select: {
      id: true,
      status: true,
      sessionDate: true,
      startedAt: true,
      endedAt: true,
      metadata: true,
      cohort: { select: { name: true } },
      faculty: { select: { name: true } },
      cohortSubject: {
        select: {
          subject: { select: { name: true, code: true } },
          faculty: { select: { name: true } },
        },
      },
    },
  },
  corrections: {
    select: {
      id: true,
      previousResult: true,
      newResult: true,
      reason: true,
      source: true,
      changedAt: true,
      changedBy: { select: { name: true } },
    },
    orderBy: { changedAt: "asc" },
  },
} as const;

export type RecordDetailRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof RECORD_DETAIL_SELECT;
}>;

export function getAttendanceRecordDetail(recordId: string): Promise<RecordDetailRow | null> {
  return prisma.attendanceRecord.findUnique({
    where: { id: recordId },
    select: RECORD_DETAIL_SELECT,
  });
}

// ---------------------------------------------------------------------------
// Faculty
// ---------------------------------------------------------------------------

export function listCohortFacultyLinks(userId: string) {
  return prisma.cohortFaculty.findMany({
    where: { userId },
    select: {
      cohortId: true,
      role: true,
      cohort: { select: { id: true, name: true, termLabel: true, institutionId: true } },
    },
  });
}

/** Every cohort in the institution, for an actor who administers all of them. */
export function listCohortsForInstitution(institutionId: string) {
  return prisma.cohort.findMany({
    where: { institutionId },
    select: { id: true, name: true, termLabel: true, institutionId: true },
    orderBy: [{ name: "asc" }],
  });
}

/**
 * ACTIVE enrollment counts, keyed by cohort.
 *
 * Deliberately not a `_count` on the cohort select: that counts every
 * `Enrollment` row, including students who have left the class. A class card
 * reading "42 students" when 6 of them unenrolled last term is a wrong
 * number, not a rounding difference.
 */
export function countActiveEnrollmentsPerCohort(
  cohortIds: string[],
): Promise<Array<{ cohortId: string; students: number }>> {
  if (cohortIds.length === 0) return Promise.resolve([]);
  return prisma.enrollment
    .groupBy({
      by: ["cohortId"],
      where: { cohortId: { in: cohortIds }, status: "ACTIVE" },
      _count: { _all: true },
    })
    .then((rows) => rows.map((r) => ({ cohortId: r.cohortId, students: r._count._all })));
}

const COHORT_SUBJECT_SELECT = {
  id: true,
  cohortId: true,
  facultyId: true,
  cohort: { select: { name: true, institutionId: true } },
  subject: { select: { name: true, code: true } },
} as const;

export type CohortSubjectRow = Prisma.CohortSubjectGetPayload<{
  select: typeof COHORT_SUBJECT_SELECT;
}>;

/** The subjects assigned to this faculty member — the college scope rule. */
export function listCohortSubjectsForFaculty(
  userId: string,
  institutionId: string,
): Promise<CohortSubjectRow[]> {
  return prisma.cohortSubject.findMany({
    where: { facultyId: userId, cohort: { institutionId } },
    select: COHORT_SUBJECT_SELECT,
    orderBy: [{ subject: { name: "asc" } }],
  });
}

export function listCohortSubjectsForInstitution(
  institutionId: string,
): Promise<CohortSubjectRow[]> {
  return prisma.cohortSubject.findMany({
    where: { cohort: { institutionId } },
    select: COHORT_SUBJECT_SELECT,
    orderBy: [{ subject: { name: "asc" } }],
  });
}

export function listSessionsInScope(
  scope: SessionScope,
  where: Prisma.AttendanceSessionWhereInput,
  take: number,
): Promise<SessionSummaryRow[]> {
  return prisma.attendanceSession.findMany({
    where: { AND: [sessionScopeWhere(scope), where] },
    select: SESSION_SUMMARY_SELECT,
    orderBy: [{ sessionDate: "desc" }, { startedAt: "desc" }],
    take,
  });
}

/** Newest session date per cohort, so a class card can say when it last met. */
export function listLastSessionDatePerCohort(
  cohortIds: string[],
): Promise<Array<{ cohortId: string; sessionDate: Date | null }>> {
  if (cohortIds.length === 0) return Promise.resolve([]);
  return prisma.attendanceSession
    .groupBy({
      by: ["cohortId"],
      where: { cohortId: { in: cohortIds }, status: "FINALIZED" },
      _max: { sessionDate: true },
    })
    .then((rows) => rows.map((r) => ({ cohortId: r.cohortId, sessionDate: r._max.sessionDate })));
}

// ---------------------------------------------------------------------------
// Cohort history (class teacher)
// ---------------------------------------------------------------------------

export function getCohortHeader(cohortId: string) {
  return prisma.cohort.findUnique({
    where: { id: cohortId },
    select: { id: true, name: true, termLabel: true, institutionId: true },
  });
}

export function listCohortSessionsWithStudents(
  cohortId: string,
  take: number,
  cohortSubjectIds?: string[],
): Promise<SessionWithStudentsRow[]> {
  return prisma.attendanceSession.findMany({
    where: {
      cohortId,
      status: { not: "CANCELLED" },
      ...(cohortSubjectIds ? { cohortSubjectId: { in: cohortSubjectIds } } : {}),
    },
    select: SESSION_WITH_STUDENTS_SELECT,
    orderBy: [{ sessionDate: "desc" }, { startedAt: "desc" }],
    take,
  });
}

const CORRECTION_SELECT = {
  id: true,
  previousResult: true,
  newResult: true,
  reason: true,
  source: true,
  changedAt: true,
  changedBy: { select: { name: true } },
  attendanceRecord: {
    select: {
      student: { select: { studentCode: true, firstName: true, lastName: true } },
      session: { select: { id: true, sessionDate: true } },
    },
  },
} as const;

export type CorrectionRow = Prisma.AttendanceCorrectionGetPayload<{
  select: typeof CORRECTION_SELECT;
}>;

export function listCorrectionsForCohort(
  cohortId: string,
  take: number,
  cohortSubjectIds?: string[],
): Promise<CorrectionRow[]> {
  return prisma.attendanceCorrection.findMany({
    where: {
      attendanceRecord: {
        session: {
          cohortId,
          ...(cohortSubjectIds ? { cohortSubjectId: { in: cohortSubjectIds } } : {}),
        },
      },
    },
    select: CORRECTION_SELECT,
    orderBy: { changedAt: "desc" },
    take,
  });
}

// ---------------------------------------------------------------------------
// Institution report
// ---------------------------------------------------------------------------

export function countInstitutionTotals(institutionId: string, windowStart: Date, windowEnd: Date) {
  return Promise.all([
    prisma.student.count({ where: { institutionId } }),
    prisma.cohort.count({ where: { institutionId } }),
    prisma.attendanceSession.count({
      where: {
        institutionId,
        status: "FINALIZED",
        sessionDate: { gte: windowStart, lt: windowEnd },
      },
    }),
    prisma.attendanceSession.count({
      where: { institutionId, status: { in: ["REVIEW", "PROCESSING"] } },
    }),
  ]).then(([students, cohorts, finalizedSessions, sessionsAwaitingReview]) => ({
    students,
    cohorts,
    finalizedSessions,
    sessionsAwaitingReview,
  }));
}

const REPORT_RECORD_SELECT = {
  finalResult: true,
  studentId: true,
  student: { select: { studentCode: true, firstName: true, lastName: true } },
  session: { select: { cohortId: true, cohort: { select: { name: true, termLabel: true } } } },
} as const;

export type ReportRecordRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof REPORT_RECORD_SELECT;
}>;

/**
 * Every finalized attendance row in the institution inside the report window.
 *
 * Windowed, not paginated: the report aggregates over the whole set, so a
 * `take` would produce a number that looks institution-wide but isn't. The
 * bound that keeps this honest is the date range, which the report always
 * states.
 */
export function listFinalizedRecordsForInstitution(
  institutionId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ReportRecordRow[]> {
  return prisma.attendanceRecord.findMany({
    where: {
      institutionId,
      session: {
        status: "FINALIZED",
        sessionDate: { gte: windowStart, lt: windowEnd },
      },
    },
    select: REPORT_RECORD_SELECT,
  });
}

export function countSessionsPerCohort(
  institutionId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Array<{ cohortId: string; sessions: number }>> {
  return prisma.attendanceSession
    .groupBy({
      by: ["cohortId"],
      where: {
        institutionId,
        status: "FINALIZED",
        sessionDate: { gte: windowStart, lt: windowEnd },
      },
      _count: { _all: true },
    })
    .then((rows) => rows.map((r) => ({ cohortId: r.cohortId, sessions: r._count._all })));
}

export function listCohortStudentCounts(
  institutionId: string,
): Promise<Array<{ cohortId: string; students: number }>> {
  return prisma.enrollment
    .groupBy({
      by: ["cohortId"],
      where: { status: "ACTIVE", institutionId },
      _count: { _all: true },
    })
    .then((rows) => rows.map((r) => ({ cohortId: r.cohortId, students: r._count._all })));
}
