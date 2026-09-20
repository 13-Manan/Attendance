import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportRollups,
  getCohortAttendanceHistory,
  getFacultyDashboard,
  getInstitutionAttendanceReport,
  getOwnAttendanceDetail,
  getStudentDashboard,
  rateOf,
  resolveFacultyScope,
  sessionCountsOf,
  summarizeBySubject,
  utcDayRange,
} from "./service.ts";
import type { AnalyticsDeps } from "./service.ts";
import { sessionScopeWhere } from "./repository.ts";
import type {
  CohortSubjectRow,
  RecordDetailRow,
  ReportRecordRow,
  SessionSummaryRow,
  SessionWithStudentsRow,
  StudentRecordRow,
} from "./repository.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FACULTY_PERMISSIONS = [
  "cohort.read",
  "student.read",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
];

const STUDENT_PERMISSIONS = [
  "student.read.own",
  "attendanceRecord.read.own",
  "cohort.read",
  "faceEmbedding.enroll.own",
];

const ADMIN_PERMISSIONS = [
  ...FACULTY_PERMISSIONS,
  "cohort.manage",
  "institution.read",
  "auditLog.read",
];

function makeUser(
  overrides: {
    permissions?: string[];
    userId?: string;
    institutionId?: string | null;
  } = {},
): SessionUser {
  const institutionId =
    overrides.institutionId === undefined ? "inst-A" : overrides.institutionId;
  return {
    userId: overrides.userId ?? "user-faculty",
    email: "person@example.com",
    name: "A Person",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "FACULTY",
        name: "Faculty",
        institutionId,
        campusId: null,
        permissions: (overrides.permissions ??
          FACULTY_PERMISSIONS) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function institution(type: "SCHOOL" | "COLLEGE"): Institution {
  return { id: "inst-A", name: "Test Institution", type, settings: null } as unknown as Institution;
}

function studentRecord(
  overrides: {
    id?: string;
    result?: string;
    date?: string;
    cohortSubjectId?: string | null;
    subjectName?: string;
    subjectCode?: string;
    facultyName?: string | null;
    cohortName?: string;
  } = {},
): StudentRecordRow {
  const cohortSubjectId =
    overrides.cohortSubjectId === undefined ? "cs-dbms" : overrides.cohortSubjectId;
  return {
    id: overrides.id ?? "rec-1",
    finalResult: (overrides.result ?? "PRESENT") as StudentRecordRow["finalResult"],
    isManuallyCorrected: false,
    session: {
      id: "sess-1",
      sessionDate: new Date(overrides.date ?? "2026-09-15T00:00:00.000Z"),
      cohortSubjectId,
      cohort: { name: overrides.cohortName ?? "CSE 3A" },
      cohortSubject: cohortSubjectId
        ? {
            subject: {
              name: overrides.subjectName ?? "Database Management",
              code: overrides.subjectCode ?? "CS301",
            },
            faculty:
              overrides.facultyName === null ? null : { name: overrides.facultyName ?? "Dr. Rao" },
          }
        : null,
    },
  } as StudentRecordRow;
}

/** `n` records for one subject, `present` of them PRESENT. */
function subjectRecords(
  cohortSubjectId: string,
  subjectName: string,
  present: number,
  total: number,
): StudentRecordRow[] {
  return Array.from({ length: total }, (_, i) =>
    studentRecord({
      id: `${cohortSubjectId}-${i}`,
      cohortSubjectId,
      subjectName,
      result: i < present ? "PRESENT" : "ABSENT",
    }),
  );
}

function sessionSummary(
  overrides: {
    id?: string;
    cohortId?: string;
    status?: string;
    subjectName?: string | null;
    results?: string[];
    date?: string;
  } = {},
): SessionSummaryRow {
  const subjectName = overrides.subjectName === undefined ? "Database Management" : overrides.subjectName;
  return {
    id: overrides.id ?? "sess-1",
    cohortId: overrides.cohortId ?? "coh-1",
    sessionDate: new Date(overrides.date ?? "2026-09-16T00:00:00.000Z"),
    startedAt: new Date(overrides.date ?? "2026-09-16T09:00:00.000Z"),
    status: (overrides.status ?? "FINALIZED") as SessionSummaryRow["status"],
    cohort: { name: "CSE 3A" },
    cohortSubject: subjectName ? { subject: { name: subjectName, code: "CS301" } } : null,
    faculty: { name: "Dr. Rao" },
    attendanceRecords: (overrides.results ?? ["PRESENT", "ABSENT"]).map((finalResult) => ({
      finalResult: finalResult as SessionSummaryRow["attendanceRecords"][number]["finalResult"],
    })),
  } as SessionSummaryRow;
}

function cohortSubjectRow(id: string, cohortId: string, name: string): CohortSubjectRow {
  return {
    id,
    cohortId,
    facultyId: "user-faculty",
    cohort: { name: "CSE 3A", institutionId: "inst-A" },
    subject: { name, code: "CS301" },
  } as CohortSubjectRow;
}

const NO_OP_REPO: AnalyticsDeps = {
  countActiveEnrollmentsPerCohort: async () => [],
  listLastSessionDatePerCohort: async () => [],
  getInstitutionById: async () => institution("COLLEGE"),
};

// ---------------------------------------------------------------------------
// Percentage arithmetic
// ---------------------------------------------------------------------------

test("attendance percentage matches the way institutions quote it", () => {
  // The Phase 7 brief's own examples.
  const dbms = rateOf(Array.from({ length: 22 }, (_, i) => ({ finalResult: i < 18 ? "PRESENT" : "ABSENT" })));
  assert.equal(dbms.present, 18);
  assert.equal(dbms.total, 22);
  assert.equal(dbms.percentage, 81.8);

  const os = rateOf(Array.from({ length: 22 }, (_, i) => ({ finalResult: i < 20 ? "PRESENT" : "ABSENT" })));
  assert.equal(os.percentage, 90.9);
});

test("a student with no attendance yet has no percentage, not 0%", () => {
  const rate = rateOf([]);
  assert.equal(rate.total, 0);
  assert.equal(rate.percentage, null);
});

test("an unresolved row is excluded from the percentage rather than counted as absent", () => {
  const rate = rateOf([
    { finalResult: "PRESENT" },
    { finalResult: "NEEDS_REVIEW" },
    { finalResult: "NOT_EVALUATED" },
  ]);
  assert.equal(rate.present, 1);
  assert.equal(rate.absent, 0);
  assert.equal(rate.total, 1, "review rows are in neither numerator nor denominator");
  assert.equal(rate.percentage, 100);
});

test("session counts fold NOT_EVALUATED into the needs-review bucket", () => {
  const counts = sessionCountsOf([
    { finalResult: "PRESENT" },
    { finalResult: "PRESENT" },
    { finalResult: "ABSENT" },
    { finalResult: "NEEDS_REVIEW" },
    { finalResult: "NOT_EVALUATED" },
  ]);
  assert.deepEqual(counts, { total: 5, present: 2, absent: 1, needsReview: 2 });
});

test("the portal's day boundary is the half-open UTC day the session uniqueness check uses", () => {
  const { start, end } = utcDayRange(new Date("2026-09-16T17:45:00.000Z"));
  assert.equal(start.toISOString(), "2026-09-16T00:00:00.000Z");
  assert.equal(end.toISOString(), "2026-09-17T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Student portal
// ---------------------------------------------------------------------------

test("subject-wise attendance groups by cohort subject, not by subject name", () => {
  const rows = [
    ...subjectRecords("cs-a", "Operating Systems", 20, 22),
    ...subjectRecords("cs-b", "Operating Systems", 4, 10),
  ];
  const summaries = summarizeBySubject(rows);
  assert.equal(summaries.length, 2, "the same subject in two classes is two registers");
  const byId = new Map(summaries.map((s) => [s.cohortSubjectId, s]));
  assert.equal(byId.get("cs-a")?.rate.percentage, 90.9);
  assert.equal(byId.get("cs-b")?.rate.percentage, 40);
});

test("a daily session in a college is left out of the subject breakdown but stays in the overall", () => {
  const rows = [
    ...subjectRecords("cs-a", "Database Management", 18, 22),
    studentRecord({ id: "daily-1", cohortSubjectId: null, result: "ABSENT" }),
  ];
  assert.equal(summarizeBySubject(rows).length, 1);
  assert.equal(rateOf(rows).total, 23);
});

function studentDeps(rows: StudentRecordRow[], type: "SCHOOL" | "COLLEGE", unconfirmed = 0): AnalyticsDeps {
  return {
    getStudentProfileByUserId: async () => ({
      id: "stu-1",
      institutionId: "inst-A",
      studentCode: "S001",
      firstName: "Rahul",
      lastName: "Sharma",
    }),
    listFinalizedRecordsForStudent: async () => rows,
    listActiveCohortIdsForStudent: async () => ["coh-1"],
    countUnconfirmedSessionsToday: async () => unconfirmed,
    listStudentEnrollmentContext: async () => [
      {
        cohortId: "coh-1",
        cohort: {
          name: "Grade 8 - A",
          termLabel: "Term 1",
          academicUnit: { name: "Section A", kind: "SECTION" as const },
          academicSession: { name: "2026-2027", isCurrent: true },
        },
      },
    ],
    getInstitutionById: async () => institution(type),
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  };
}

test("a college student's dashboard carries the subject breakdown", async () => {
  const dashboard = await getStudentDashboard(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    studentDeps(
      [
        ...subjectRecords("cs-dbms", "Database Management", 18, 22),
        ...subjectRecords("cs-os", "Operating Systems", 20, 22),
      ],
      "COLLEGE",
    ),
  );
  assert.ok(dashboard);
  assert.equal(dashboard.attendanceMode, "SUBJECT_WISE");
  assert.equal(dashboard.subjects.length, 2);
  assert.equal(dashboard.overall.present, 38);
  assert.equal(dashboard.overall.total, 44);
  assert.equal(dashboard.overall.percentage, 86.4);
});

test("a school student's dashboard is day-by-day and carries no subject breakdown", async () => {
  const dashboard = await getStudentDashboard(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    studentDeps(
      [
        studentRecord({ id: "r1", cohortSubjectId: null, date: "2026-09-15T00:00:00.000Z", result: "PRESENT" }),
        studentRecord({ id: "r2", cohortSubjectId: null, date: "2026-09-14T00:00:00.000Z", result: "ABSENT" }),
      ],
      "SCHOOL",
    ),
  );
  assert.ok(dashboard);
  assert.equal(dashboard.attendanceMode, "DAILY");
  assert.deepEqual(dashboard.subjects, []);
  assert.equal(dashboard.daily.length, 2);
  assert.equal(dashboard.daily[0].result, "PRESENT");
});

test("today's row appears under today, and an unconfirmed session is a count with no result", async () => {
  const dashboard = await getStudentDashboard(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    studentDeps(
      [
        studentRecord({ id: "r-today", date: "2026-09-16T04:30:00.000Z", result: "PRESENT" }),
        studentRecord({ id: "r-old", date: "2026-09-10T00:00:00.000Z", result: "ABSENT" }),
      ],
      "COLLEGE",
      2,
    ),
  );
  assert.ok(dashboard);
  assert.equal(dashboard.today.length, 1);
  assert.equal(dashboard.today[0].attendanceRecordId, "r-today");
  assert.equal(dashboard.todayAwaitingConfirmation, 2);
});

test("a user without attendanceRecord.read.own cannot open the student dashboard", async () => {
  await assert.rejects(
    () => getStudentDashboard(makeUser({ permissions: ["cohort.read"] }), studentDeps([], "COLLEGE")),
    ForbiddenError,
  );
});

function detailRow(
  overrides: { studentId?: string; status?: string; corrections?: RecordDetailRow["corrections"] } = {},
): RecordDetailRow {
  return {
    id: "rec-1",
    studentId: overrides.studentId ?? "stu-1",
    finalResult: "PRESENT",
    isManuallyCorrected: true,
    session: {
      id: "sess-1",
      status: (overrides.status ?? "FINALIZED") as RecordDetailRow["session"]["status"],
      sessionDate: new Date("2026-09-15T00:00:00.000Z"),
      startedAt: new Date("2026-09-15T09:00:00.000Z"),
      endedAt: new Date("2026-09-15T10:00:00.000Z"),
      metadata: {
        attendanceReview: {
          generationSource: "recognition",
          captureImages: [{ sequenceNumber: 1 }, { sequenceNumber: 2 }],
          finalizedAt: "2026-09-15T10:05:00.000Z",
        },
      },
      cohort: { name: "CSE 3A" },
      faculty: { name: "Dr. Rao" },
      cohortSubject: {
        subject: { name: "Database Management", code: "CS301" },
        faculty: { name: "Dr. Rao" },
      },
    },
    corrections: overrides.corrections ?? [
      {
        id: "corr-1",
        previousResult: "ABSENT",
        newResult: "PRESENT",
        reason: "Sat at the back",
        source: "FACULTY_REVIEW",
        changedAt: new Date("2026-09-15T10:02:00.000Z"),
        changedBy: { name: "Dr. Rao" },
      },
    ],
  } as RecordDetailRow;
}

test("attendance detail exposes date, subject, faculty, status and provenance — but no confidence", async () => {
  const detail = await getOwnAttendanceDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "rec-1",
    { ...studentDeps([], "COLLEGE"), getAttendanceRecordDetail: async () => detailRow() },
  );
  assert.ok(detail);
  assert.equal(detail.subjectName, "Database Management");
  assert.equal(detail.facultyName, "Dr. Rao");
  assert.equal(detail.result, "PRESENT");
  assert.equal(detail.generationSource, "recognition");
  assert.equal(detail.captureCount, 2);
  assert.equal(detail.finalizedAt, "2026-09-15T10:05:00.000Z");
  assert.equal(detail.corrections.length, 1);
  assert.equal(detail.corrections[0].previousResult, "ABSENT");
  assert.ok(!("aiConfidence" in detail), "a similarity score is not student-facing");
});

test("a student cannot open somebody else's attendance record by guessing its id", async () => {
  await assert.rejects(
    () =>
      getOwnAttendanceDetail(makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }), "rec-1", {
        ...studentDeps([], "COLLEGE"),
        getAttendanceRecordDetail: async () => detailRow({ studentId: "stu-someone-else" }),
      }),
    ForbiddenError,
  );
});

test("a register still in review is invisible to the student it concerns", async () => {
  const detail = await getOwnAttendanceDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "rec-1",
    {
      ...studentDeps([], "COLLEGE"),
      getAttendanceRecordDetail: async () => detailRow({ status: "REVIEW" }),
    },
  );
  assert.equal(detail, null);
});

// ---------------------------------------------------------------------------
// Faculty scope
// ---------------------------------------------------------------------------

test("a college lecturer's scope is their linked classes plus their assigned subjects", async () => {
  const resolved = await resolveFacultyScope(makeUser(), {
    ...NO_OP_REPO,
    listCohortFacultyLinks: async () => [
      {
        cohortId: "coh-1",
        role: "PRIMARY",
        cohort: { id: "coh-1", name: "CSE 3A", termLabel: "Sem 5", institutionId: "inst-A" },
      },
    ],
    listCohortSubjectsForFaculty: async () => [cohortSubjectRow("cs-os", "coh-2", "Operating Systems")],
  });

  assert.equal(resolved.kind, "assigned");
  assert.deepEqual(resolved.scope.cohortIds, ["coh-1"]);
  assert.deepEqual(resolved.scope.cohortSubjectIds, ["cs-os"]);
  assert.equal(resolved.isClassTeacher, true);
  // coh-2 is reachable through the subject, but only as a subject teacher.
  const byId = new Map(resolved.cohorts.map((c) => [c.cohortId, c]));
  assert.equal(byId.get("coh-1")?.facultyRole, "PRIMARY");
  assert.equal(byId.get("coh-2")?.facultyRole, "ASSISTANT");
});

test("a faculty link in another institution is not visible from this session", async () => {
  const resolved = await resolveFacultyScope(makeUser(), {
    ...NO_OP_REPO,
    listCohortFacultyLinks: async () => [
      {
        cohortId: "coh-other",
        role: "PRIMARY",
        cohort: { id: "coh-other", name: "Other", termLabel: null, institutionId: "inst-B" },
      },
    ],
    listCohortSubjectsForFaculty: async () => [],
  });
  assert.deepEqual(resolved.scope.cohortIds, []);
  assert.deepEqual(resolved.cohorts, []);
});

test("an institution admin gets an unrestricted scope; a lecturer's scope is an explicit union", () => {
  const adminWhere = sessionScopeWhere({
    institutionId: "inst-A",
    cohortIds: null,
    cohortSubjectIds: [],
  });
  assert.deepEqual(adminWhere, { institutionId: "inst-A" });

  const facultyWhere = sessionScopeWhere({
    institutionId: "inst-A",
    cohortIds: ["coh-1"],
    cohortSubjectIds: ["cs-os"],
  });
  assert.deepEqual(facultyWhere, {
    institutionId: "inst-A",
    OR: [{ cohortId: { in: ["coh-1"] } }, { cohortSubjectId: { in: ["cs-os"] } }],
  });
});

test("a faculty member with no assignments yet matches no sessions at all", () => {
  const where = sessionScopeWhere({ institutionId: "inst-A", cohortIds: [], cohortSubjectIds: [] });
  assert.deepEqual(where, {
    institutionId: "inst-A",
    OR: [{ cohortId: { in: [] } }, { cohortSubjectId: { in: [] } }],
  });
});

test("the faculty dashboard separates today, the review queue and recent registers", async () => {
  const dashboard = await getFacultyDashboard(makeUser(), {
    ...NO_OP_REPO,
    listCohortFacultyLinks: async () => [
      {
        cohortId: "coh-1",
        role: "PRIMARY",
        cohort: { id: "coh-1", name: "CSE 3A", termLabel: "Sem 5", institutionId: "inst-A" },
      },
    ],
    listCohortSubjectsForFaculty: async () => [cohortSubjectRow("cs-dbms", "coh-1", "Database Management")],
    listSessionsInScope: async (_scope, where) => {
      if (where.status === "REVIEW") {
        return [sessionSummary({ id: "sess-review", status: "REVIEW", results: ["PRESENT", "NEEDS_REVIEW", "NOT_EVALUATED"] })];
      }
      if (where.status === "FINALIZED") return [sessionSummary({ id: "sess-old" })];
      return [sessionSummary({ id: "sess-today", status: "CAPTURING", results: [] })];
    },
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  });

  assert.equal(dashboard.today.length, 1);
  assert.equal(dashboard.today[0].sessionId, "sess-today");
  assert.equal(dashboard.pendingReview.length, 1);
  assert.equal(dashboard.pendingReview[0].counts.needsReview, 2);
  assert.equal(dashboard.recent[0].sessionId, "sess-old");
  assert.equal(dashboard.cohorts.length, 1);
  assert.equal(dashboard.subjects.length, 1);
  assert.equal(dashboard.isClassTeacher, true);
});

test("a platform user with no institution is refused rather than shown an empty institution", async () => {
  await assert.rejects(
    () => getFacultyDashboard(makeUser({ institutionId: null }), NO_OP_REPO),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// Class history
// ---------------------------------------------------------------------------

function historySession(
  overrides: { id?: string; status?: string; cohortSubjectId?: string } = {},
): SessionWithStudentsRow {
  const base = sessionSummary({ id: overrides.id, status: overrides.status });
  return {
    ...base,
    attendanceRecords: [
      {
        finalResult: "PRESENT",
        isManuallyCorrected: false,
        student: { id: "stu-1", studentCode: "S001", firstName: "Rahul", lastName: "Sharma" },
      },
      {
        finalResult: "ABSENT",
        isManuallyCorrected: false,
        student: { id: "stu-2", studentCode: "S002", firstName: "Anita", lastName: "Desai" },
      },
    ],
  } as unknown as SessionWithStudentsRow;
}

function historyDeps(sessions: SessionWithStudentsRow[]): AnalyticsDeps {
  return {
    ...NO_OP_REPO,
    getCohortHeader: async () => ({
      id: "coh-1",
      name: "CSE 3A",
      termLabel: "Sem 5",
      institutionId: "inst-A",
    }),
    countActiveEnrollmentsPerCohort: async () => [{ cohortId: "coh-1", students: 50 }],
    listCohortSessionsWithStudents: async () => sessions,
    listCorrectionsForCohort: async () => [],
  };
}

test("the class-teacher history names the absent students on each session", async () => {
  const history = await getCohortAttendanceHistory(makeUser(), "coh-1", {
    ...historyDeps([historySession()]),
    listCohortFacultyLinks: async () => [
      {
        cohortId: "coh-1",
        role: "PRIMARY",
        cohort: { id: "coh-1", name: "CSE 3A", termLabel: "Sem 5", institutionId: "inst-A" },
      },
    ],
  });
  assert.equal(history.studentCount, 50);
  assert.equal(history.sessions[0].absentStudents.length, 1);
  assert.equal(history.sessions[0].absentStudents[0].studentCode, "S002");
  assert.equal(history.overall.percentage, 50);
});

test("a class's overall rate ignores registers that are still in review", async () => {
  const history = await getCohortAttendanceHistory(makeUser(), "coh-1", {
    ...historyDeps([historySession({ id: "s1" }), historySession({ id: "s2", status: "REVIEW" })]),
    listCohortFacultyLinks: async () => [
      {
        cohortId: "coh-1",
        role: "PRIMARY",
        cohort: { id: "coh-1", name: "CSE 3A", termLabel: "Sem 5", institutionId: "inst-A" },
      },
    ],
  });
  assert.equal(history.sessions.length, 2, "both sessions are listed");
  assert.equal(history.overall.total, 2, "only the finalized one is averaged");
});

test("a lecturer reaching a class only through a subject sees only that subject's sessions", async () => {
  let restrictedTo: string[] | undefined = ["not-called"];
  await getCohortAttendanceHistory(makeUser(), "coh-1", {
    ...historyDeps([historySession()]),
    listCohortFacultyLinks: async () => [],
    listCohortSubjectsForFaculty: async () => [cohortSubjectRow("cs-dbms", "coh-1", "Database Management")],
    listCohortSessionsWithStudents: async (_cohortId, _take, cohortSubjectIds) => {
      restrictedTo = cohortSubjectIds;
      return [historySession()];
    },
  });
  assert.deepEqual(restrictedTo, ["cs-dbms"]);
});

test("a faculty member with neither a class link nor a subject in the class is denied", async () => {
  await assert.rejects(
    () =>
      getCohortAttendanceHistory(makeUser(), "coh-1", {
        ...historyDeps([historySession()]),
        listCohortFacultyLinks: async () => [],
        listCohortSubjectsForFaculty: async () => [],
      }),
    ForbiddenError,
  );
});

test("a class in another institution is not readable even with attendanceRecord.read", async () => {
  await assert.rejects(
    () =>
      getCohortAttendanceHistory(makeUser(), "coh-1", {
        ...historyDeps([]),
        getCohortHeader: async () => ({
          id: "coh-1",
          name: "Other",
          termLabel: null,
          institutionId: "inst-B",
        }),
      }),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// Institution report
// ---------------------------------------------------------------------------

function reportRecord(studentId: string, cohortId: string, finalResult: string): ReportRecordRow {
  return {
    finalResult: finalResult as ReportRecordRow["finalResult"],
    studentId,
    student: { studentCode: studentId.toUpperCase(), firstName: "Student", lastName: studentId },
    session: { cohortId, cohort: { name: `Class ${cohortId}`, termLabel: null } },
  } as ReportRecordRow;
}

test("the low-attendance list is sorted worst-first and excludes students with no decided rows", () => {
  const records = [
    ...Array.from({ length: 10 }, (_, i) => reportRecord("stu-a", "coh-1", i < 4 ? "PRESENT" : "ABSENT")),
    ...Array.from({ length: 10 }, (_, i) => reportRecord("stu-b", "coh-1", i < 7 ? "PRESENT" : "ABSENT")),
    ...Array.from({ length: 10 }, (_, i) => reportRecord("stu-c", "coh-1", i < 9 ? "PRESENT" : "ABSENT")),
    reportRecord("stu-d", "coh-1", "NEEDS_REVIEW"),
  ];
  const { cohorts, lowAttendance } = buildReportRollups(records, 75);

  assert.deepEqual(
    lowAttendance.map((s) => s.studentId),
    ["stu-a", "stu-b"],
    "90% is above the threshold; the review-only student has no percentage at all",
  );
  assert.equal(lowAttendance[0].rate.percentage, 40);
  assert.equal(cohorts.get("coh-1")?.rate.total, 30);
});

test("the institution report states the window it covers and needs both permissions", async () => {
  const deps: AnalyticsDeps = {
    ...NO_OP_REPO,
    countInstitutionTotals: async () => ({
      students: 120,
      cohorts: 4,
      finalizedSessions: 60,
      sessionsAwaitingReview: 3,
    }),
    listFinalizedRecordsForInstitution: async () => [
      reportRecord("stu-a", "coh-1", "PRESENT"),
      reportRecord("stu-a", "coh-1", "ABSENT"),
    ],
    countSessionsPerCohort: async () => [{ cohortId: "coh-1", sessions: 2 }],
    listCohortStudentCounts: async () => [{ cohortId: "coh-1", students: 50 }],
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  };

  const report = await getInstitutionAttendanceReport(
    makeUser({ permissions: ADMIN_PERMISSIONS }),
    { windowDays: 30 },
    deps,
  );
  assert.equal(report.windowDays, 30);
  assert.equal(report.windowStart, "2026-08-18T00:00:00.000Z");
  assert.equal(report.windowEnd, "2026-09-17T00:00:00.000Z");
  assert.equal(report.totals.sessionsAwaitingReview, 3);
  assert.equal(report.overall.percentage, 50);
  assert.equal(report.cohorts[0].sessionCount, 2);
  assert.equal(report.cohorts[0].studentCount, 50);

  // Faculty hold attendanceRecord.read but not institution.read.
  await assert.rejects(
    () => getInstitutionAttendanceReport(makeUser(), {}, deps),
    ForbiddenError,
  );
});
