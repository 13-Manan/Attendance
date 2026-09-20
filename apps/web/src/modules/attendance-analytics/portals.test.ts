import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeEnrollment,
  getStudentSubjectDetail,
  listFacultySessions,
  normalizeSessionFilters,
  sessionFilterWhere,
  summarizeTrend,
  toEnrollmentContext,
} from "./service.ts";
import type { AnalyticsDeps } from "./service.ts";
import type {
  CohortSubjectRow,
  SessionSummaryRow,
  StudentEnrollmentRow,
  StudentRecordRow,
} from "./repository.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";

/**
 * Phase 7 — the student and faculty portals.
 *
 * The concern running through every test here is the same one: a portal is a
 * surface that hands data to somebody outside the staff room, and the only
 * thing standing between "my attendance" and "somebody's attendance" is that
 * the server resolves *who* rather than believing the URL. So the negative
 * cases are the point — a foreign subject id, a foreign class id, a tampered
 * status, another institution's cohort — and each of them asserts an empty
 * result rather than an error, because a 403 that distinguishes "not yours"
 * from "does not exist" is itself a disclosure.
 *
 * Read-only by construction: nothing in this module can write, so there is no
 * mutation to test. That is asserted at the end, against the module's own
 * exports, so it stays true if somebody adds one.
 */

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

const ADMIN_PERMISSIONS = [...FACULTY_PERMISSIONS, "cohort.manage", "institution.read"];

function makeUser(
  overrides: { permissions?: string[]; userId?: string; institutionId?: string | null } = {},
): SessionUser {
  const institutionId = overrides.institutionId === undefined ? "inst-A" : overrides.institutionId;
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
    corrected?: boolean;
  } = {},
): StudentRecordRow {
  const cohortSubjectId =
    overrides.cohortSubjectId === undefined ? "cs-dbms" : overrides.cohortSubjectId;
  return {
    id: overrides.id ?? "rec-1",
    finalResult: (overrides.result ?? "PRESENT") as StudentRecordRow["finalResult"],
    isManuallyCorrected: overrides.corrected ?? false,
    session: {
      id: `sess-${overrides.id ?? "1"}`,
      sessionDate: new Date(overrides.date ?? "2026-09-15T00:00:00.000Z"),
      cohortSubjectId,
      cohort: { name: "CSE 3A" },
      cohortSubject: cohortSubjectId
        ? {
            subject: { name: overrides.subjectName ?? "Database Management", code: "CS301" },
            faculty: { name: "Dr. Rao" },
          }
        : null,
    },
  } as StudentRecordRow;
}

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
  overrides: { id?: string; cohortId?: string; status?: string; date?: string } = {},
): SessionSummaryRow {
  return {
    id: overrides.id ?? "sess-1",
    cohortId: overrides.cohortId ?? "coh-1",
    sessionDate: new Date(overrides.date ?? "2026-09-16T00:00:00.000Z"),
    startedAt: new Date(overrides.date ?? "2026-09-16T09:00:00.000Z"),
    status: (overrides.status ?? "FINALIZED") as SessionSummaryRow["status"],
    cohort: { name: "CSE 3A" },
    cohortSubject: { subject: { name: "Database Management", code: "CS301" } },
    faculty: { name: "Dr. Rao" },
    attendanceRecords: [{ finalResult: "PRESENT" }, { finalResult: "ABSENT" }],
  } as unknown as SessionSummaryRow;
}

function cohortSubjectRow(id: string, cohortId: string): CohortSubjectRow {
  return {
    id,
    cohortId,
    facultyId: "user-faculty",
    cohort: { name: "CSE 3A", institutionId: "inst-A" },
    subject: { name: "Database Management", code: "CS301" },
  } as CohortSubjectRow;
}

function studentDeps(rows: StudentRecordRow[], type: "SCHOOL" | "COLLEGE" = "COLLEGE"): AnalyticsDeps {
  return {
    getStudentProfileByUserId: async () => ({
      id: "stu-1",
      institutionId: "inst-A",
      studentCode: "S001",
      firstName: "Rahul",
      lastName: "Sharma",
    }),
    listFinalizedRecordsForStudent: async () => rows,
    getInstitutionById: async () => institution(type),
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  };
}

/** A faculty scope with one linked class and one assigned subject. */
function facultyDeps(
  sessions: SessionSummaryRow[],
  capture?: { scope?: unknown; where?: unknown },
): AnalyticsDeps {
  return {
    listCohortFacultyLinks: async () => [
      {
        cohortId: "coh-1",
        role: "PRIMARY",
        cohort: { name: "CSE 3A", termLabel: "Sem 5", institutionId: "inst-A" },
      },
    ] as never,
    listCohortSubjectsForFaculty: async () => [cohortSubjectRow("cs-dbms", "coh-1")],
    countActiveEnrollmentsPerCohort: async () => [],
    listLastSessionDatePerCohort: async () => [],
    listSessionsInScope: async (scope, where) => {
      if (capture) {
        capture.scope = scope;
        capture.where = where;
      }
      return sessions;
    },
    getInstitutionById: async () => institution("COLLEGE"),
    now: () => new Date("2026-09-16T10:00:00.000Z"),
  };
}

// ---------------------------------------------------------------------------
// 1–2. A student sees their own attendance, and only their own
// ---------------------------------------------------------------------------

test("the subject drill-down takes no student id — the student comes from the session", () => {
  // Structural, not behavioural: a function that cannot be handed a student id
  // cannot be pointed at another student. Two required parameters — the actor
  // and the subject — and `deps` is defaulted, so it is not counted here.
  assert.equal(getStudentSubjectDetail.length, 2);
});

test("a student opens their own subject and gets its rate and every lecture behind it", async () => {
  const detail = await getStudentSubjectDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "cs-dbms",
    studentDeps([
      ...subjectRecords("cs-dbms", "Database Management", 18, 22),
      ...subjectRecords("cs-os", "Operating Systems", 20, 22),
    ]),
  );

  assert.ok(detail);
  assert.equal(detail.subjectName, "Database Management");
  assert.equal(detail.rate.present, 18);
  assert.equal(detail.rate.total, 22);
  assert.equal(detail.rate.percentage, 81.8);
  assert.equal(detail.sessions.length, 22, "every lecture the percentage was computed from");
  assert.ok(
    detail.sessions.every((s) => s.attendanceRecordId.startsWith("cs-dbms")),
    "no other subject's lecture leaks into this subject's history",
  );
});

test("a subject the student does not study is indistinguishable from one that does not exist", async () => {
  const deps = studentDeps(subjectRecords("cs-dbms", "Database Management", 18, 22));
  const actor = makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" });

  // Somebody else's subject...
  assert.equal(await getStudentSubjectDetail(actor, "cs-someone-elses", deps), null);
  // ...and pure nonsense produce the same answer, so the page cannot be used
  // to probe for which subject ids are real.
  assert.equal(await getStudentSubjectDetail(actor, "../../etc/passwd", deps), null);
  assert.equal(await getStudentSubjectDetail(actor, "", deps), null);
});

test("an account with no linked student profile gets null, not somebody's attendance", async () => {
  const detail = await getStudentSubjectDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "cs-dbms",
    { ...studentDeps([]), getStudentProfileByUserId: async () => null },
  );
  assert.equal(detail, null);
});

test("a faculty member cannot read a student drill-down through the student route", async () => {
  await assert.rejects(
    () =>
      getStudentSubjectDetail(
        makeUser({ permissions: FACULTY_PERMISSIONS }),
        "cs-dbms",
        studentDeps(subjectRecords("cs-dbms", "Database Management", 1, 1)),
      ),
    ForbiddenError,
    "attendanceRecord.read is not attendanceRecord.read.own",
  );
});

// ---------------------------------------------------------------------------
// 11–12. Only finalized attendance is visible; corrections stay visible
// ---------------------------------------------------------------------------

test("the drill-down counts only finalized registers, because that is all it is given", async () => {
  // `listFinalizedRecordsForStudent` filters on session.status = FINALIZED in
  // SQL. The guarantee this asserts is that the service adds no second source
  // of rows that could bypass it.
  const detail = await getStudentSubjectDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "cs-dbms",
    studentDeps(subjectRecords("cs-dbms", "Database Management", 3, 4)),
  );
  assert.equal(detail?.rate.total, 4);
});

test("a corrected record still appears, and says so", async () => {
  const detail = await getStudentSubjectDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "cs-dbms",
    studentDeps([
      studentRecord({ id: "a", result: "PRESENT", corrected: true }),
      studentRecord({ id: "b", result: "ABSENT" }),
    ]),
  );
  assert.equal(detail?.rate.present, 1);
  assert.equal(detail?.sessions.find((s) => s.attendanceRecordId === "a")?.isManuallyCorrected, true);
});

test("an unresolved row never depresses a subject percentage", async () => {
  const detail = await getStudentSubjectDetail(
    makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
    "cs-dbms",
    studentDeps([
      studentRecord({ id: "a", result: "PRESENT" }),
      studentRecord({ id: "b", result: "NEEDS_REVIEW" }),
    ]),
  );
  assert.equal(detail?.rate.total, 1, "a review row is in neither numerator nor denominator");
  assert.equal(detail?.rate.percentage, 100);
});

// ---------------------------------------------------------------------------
// 8. Trend arithmetic
// ---------------------------------------------------------------------------

test("the trend buckets by UTC calendar month, oldest first", () => {
  const trend = summarizeTrend([
    studentRecord({ id: "a", date: "2026-09-15T00:00:00.000Z", result: "PRESENT" }),
    studentRecord({ id: "b", date: "2026-09-16T00:00:00.000Z", result: "ABSENT" }),
    studentRecord({ id: "c", date: "2026-08-10T00:00:00.000Z", result: "PRESENT" }),
  ]);
  assert.deepEqual(
    trend.map((p) => p.month),
    ["2026-08", "2026-09"],
  );
  assert.equal(trend[1].rate.percentage, 50);
});

test("a month with no classes is absent from the trend rather than plotted as zero", () => {
  const trend = summarizeTrend([
    studentRecord({ id: "a", date: "2026-07-10T00:00:00.000Z" }),
    studentRecord({ id: "b", date: "2026-09-10T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    trend.map((p) => p.month),
    ["2026-07", "2026-09"],
    "August had no class; drawing it at 0% would say the student missed everything",
  );
});

test("the trend keeps the most recent months when there are more than fit", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    studentRecord({ id: `m${i}`, date: `2026-${String(i + 1).padStart(2, "0")}-10T00:00:00.000Z` }),
  );
  const trend = summarizeTrend(rows, 3);
  assert.deepEqual(
    trend.map((p) => p.month),
    ["2026-08", "2026-09", "2026-10"],
  );
});

test("a student with no attendance has an empty trend, not a flat zero line", () => {
  assert.deepEqual(summarizeTrend([]), []);
});

// ---------------------------------------------------------------------------
// Enrollment context — what the figures are a percentage *of*
// ---------------------------------------------------------------------------

test("enrollment context carries class, section and academic year", () => {
  const rows: StudentEnrollmentRow[] = [
    {
      cohortId: "coh-1",
      cohort: {
        name: "Grade 8 - A",
        termLabel: "Term 1",
        academicUnit: { name: "Section A", kind: "SECTION" },
        academicSession: { name: "2026-2027", isCurrent: true },
      },
    } as StudentEnrollmentRow,
  ];
  assert.deepEqual(toEnrollmentContext(rows), [
    {
      cohortId: "coh-1",
      cohortName: "Grade 8 - A",
      termLabel: "Term 1",
      academicUnitName: "Section A",
      academicSessionName: "2026-2027",
      isCurrentSession: true,
    },
  ]);
});

test("a cohort missing its optional relations degrades to nulls rather than throwing", () => {
  const rows = [
    { cohortId: "coh-1", cohort: { name: "X", termLabel: null, academicUnit: null, academicSession: null } },
  ] as unknown as StudentEnrollmentRow[];
  const [context] = toEnrollmentContext(rows);
  assert.equal(context.academicUnitName, null);
  assert.equal(context.isCurrentSession, false);
});

test("a context line drops the parts that repeat what is already on it", () => {
  // The real school fixture: the unit repeats the class name's tail, and the
  // term label and the academic session are the same string.
  assert.deepEqual(
    describeEnrollment({
      cohortId: "c",
      cohortName: "Grade 8 - Section A",
      termLabel: "2026-2027",
      academicUnitName: "Section A",
      academicSessionName: "2026-2027",
      isCurrentSession: true,
    }),
    ["Grade 8 - Section A", "2026-2027"],
  );
});

test("a longer academic session takes the place of the term it contains", () => {
  // The real college fixture: term "2026 Odd" beside session "2026 Odd
  // Semester". Here the *candidate* is the more specific string, so the
  // shorter part gives way rather than the longer one being dropped.
  assert.deepEqual(
    describeEnrollment({
      cohortId: "c",
      cohortName: "CSE Sem 3 - Section 1",
      termLabel: "2026 Odd",
      academicUnitName: "Computer Science",
      academicSessionName: "2026 Odd Semester",
      isCurrentSession: true,
    }),
    ["CSE Sem 3 - Section 1", "Computer Science", "2026 Odd Semester"],
  );
});

test("the class name is never displaced, even by a unit name that contains it", () => {
  assert.deepEqual(
    describeEnrollment({
      cohortId: "c",
      cohortName: "8A",
      termLabel: null,
      academicUnitName: "Grade 8A Main Block",
      academicSessionName: null,
      isCurrentSession: true,
    })[0],
    "8A",
  );
});

test("genuinely distinct parts all survive", () => {
  assert.deepEqual(
    describeEnrollment({
      cohortId: "c",
      cohortName: "CSE Sem 3 - Section 1",
      termLabel: "Term 1",
      academicUnitName: "Computer Science",
      academicSessionName: "2026 Odd Semester",
      isCurrentSession: true,
    }),
    ["CSE Sem 3 - Section 1", "Computer Science", "Term 1", "2026 Odd Semester"],
  );
});

test("a context with nothing but a class name is just the class name", () => {
  assert.deepEqual(
    describeEnrollment({
      cohortId: "c",
      cohortName: "Grade 8 - A",
      termLabel: null,
      academicUnitName: null,
      academicSessionName: null,
      isCurrentSession: false,
    }),
    ["Grade 8 - A"],
  );
});

// ---------------------------------------------------------------------------
// 15. Filter parsing — tampered and malformed URLs
// ---------------------------------------------------------------------------

test("an unparseable filter widens the list instead of breaking the page", () => {
  const filters = normalizeSessionFilters({
    from: "not-a-date",
    to: "2026-13-45",
    status: "DROP TABLE",
  });
  assert.equal(filters.from, null);
  assert.equal(filters.to, null);
  assert.equal(filters.status, null, "an unknown status is no filter, never a raw passthrough");
});

test("only the six real session statuses are accepted as a filter", () => {
  for (const status of ["OPEN", "CAPTURING", "PROCESSING", "REVIEW", "FINALIZED", "CANCELLED"]) {
    assert.equal(normalizeSessionFilters({ status }).status, status);
  }
  // Not a status the state machine has — Phase 7 must not invent one.
  assert.equal(normalizeSessionFilters({ status: "CONFIRMED" }).status, null);
  assert.equal(normalizeSessionFilters({ status: "review" }).status, null);
});

test("a backwards date range is read the way the person meant it", () => {
  const filters = normalizeSessionFilters({ from: "2026-09-30", to: "2026-09-01" });
  assert.equal(filters.from, "2026-09-01");
  assert.equal(filters.to, "2026-09-30");
});

test("today wins over a stale date range in a bookmarked URL", () => {
  const filters = normalizeSessionFilters({ today: "1", from: "2020-01-01", to: "2020-01-02" });
  assert.equal(filters.today, true);
  assert.equal(filters.from, null);
  assert.equal(filters.to, null);
});

test("the to-date is inclusive, so a one-day range contains that day", () => {
  const where = sessionFilterWhere(
    normalizeSessionFilters({ from: "2026-09-20", to: "2026-09-20" }),
    new Date("2026-09-25T10:00:00.000Z"),
  );
  const range = where.sessionDate as { gte: Date; lt: Date };
  assert.equal(range.gte.toISOString(), "2026-09-20T00:00:00.000Z");
  assert.equal(
    range.lt.toISOString(),
    "2026-09-21T00:00:00.000Z",
    "an exclusive same-day bound would silently drop the day being asked for",
  );
});

test("today resolves against the server clock, not against anything in the URL", () => {
  const where = sessionFilterWhere(
    normalizeSessionFilters({ today: "1" }),
    new Date("2026-09-16T23:30:00.000Z"),
  );
  const range = where.sessionDate as { gte: Date; lt: Date };
  assert.equal(range.gte.toISOString(), "2026-09-16T00:00:00.000Z");
  assert.equal(range.lt.toISOString(), "2026-09-17T00:00:00.000Z");
});

test("an empty filter set constrains nothing", () => {
  assert.deepEqual(sessionFilterWhere(normalizeSessionFilters({}), new Date()), {});
});

// ---------------------------------------------------------------------------
// 3–7. Faculty session list: scope, isolation, and filters that cannot widen
// ---------------------------------------------------------------------------

test("the session list is scoped to the faculty member's own classes and subjects", async () => {
  const capture: { scope?: unknown; where?: unknown } = {};
  const list = await listFacultySessions(
    makeUser(),
    normalizeSessionFilters({}),
    facultyDeps([sessionSummary()], capture),
  );

  assert.equal(list.scope, "assigned");
  assert.deepEqual(capture.scope, {
    institutionId: "inst-A",
    cohortIds: ["coh-1"],
    cohortSubjectIds: ["cs-dbms"],
  });
  assert.equal(list.sessions.length, 1);
});

test("an admin's session list is institution-wide but still institution-bounded", async () => {
  const capture: { scope?: unknown; where?: unknown } = {};
  const list = await listFacultySessions(
    makeUser({ permissions: ADMIN_PERMISSIONS }),
    normalizeSessionFilters({}),
    {
      ...facultyDeps([sessionSummary()], capture),
      listCohortsForInstitution: async () => [
        { id: "coh-1", name: "CSE 3A", termLabel: "Sem 5" } as never,
      ],
      listCohortSubjectsForInstitution: async () => [cohortSubjectRow("cs-dbms", "coh-1")],
    },
  );

  assert.equal(list.scope, "institution");
  assert.deepEqual(capture.scope, {
    institutionId: "inst-A",
    cohortIds: null,
    cohortSubjectIds: [],
  });
});

test("a cohort filter for a class the caller does not teach narrows, it does not widen", async () => {
  const capture: { scope?: unknown; where?: unknown } = {};
  await listFacultySessions(
    makeUser(),
    normalizeSessionFilters({ cohortId: "coh-somebody-elses" }),
    facultyDeps([], capture),
  );

  // The filter lands in the WHERE...
  assert.deepEqual(capture.where, { cohortId: "coh-somebody-elses" });
  // ...and the scope, which the repository ANDs with it, still names only the
  // caller's own class. An AND of the two matches nothing, which is the point:
  // typing a foreign id into the address bar returns an empty list.
  assert.deepEqual((capture.scope as { cohortIds: string[] }).cohortIds, ["coh-1"]);
});

test("a faculty member with no assignments has an empty scope, so no session matches", async () => {
  const capture: { scope?: unknown; where?: unknown } = {};
  const list = await listFacultySessions(makeUser(), normalizeSessionFilters({}), {
    ...facultyDeps([], capture),
    listCohortFacultyLinks: async () => [],
    listCohortSubjectsForFaculty: async () => [],
  });

  assert.deepEqual(capture.scope, {
    institutionId: "inst-A",
    cohortIds: [],
    cohortSubjectIds: [],
  });
  assert.deepEqual(list.sessions, []);
  assert.deepEqual(list.cohorts, [], "and nothing to filter by, so the form offers nothing");
});

test("an assignment in another institution is invisible from this session", async () => {
  const list = await listFacultySessions(makeUser(), normalizeSessionFilters({}), {
    ...facultyDeps([]),
    listCohortFacultyLinks: async () =>
      [
        {
          cohortId: "coh-other",
          role: "PRIMARY",
          cohort: { name: "Other", termLabel: null, institutionId: "inst-B" },
        },
      ] as never,
    listCohortSubjectsForFaculty: async () => [],
  });
  assert.deepEqual(list.cohorts, [], "a link in inst-B is not a link in inst-A");
});

test("a platform account with no institution is refused rather than shown everything", async () => {
  await assert.rejects(
    () =>
      listFacultySessions(
        makeUser({ permissions: ADMIN_PERMISSIONS, institutionId: null }),
        normalizeSessionFilters({}),
        facultyDeps([]),
      ),
    ForbiddenError,
  );
});

test("a student cannot open the faculty session list", async () => {
  await assert.rejects(
    () =>
      listFacultySessions(
        makeUser({ permissions: STUDENT_PERMISSIONS, userId: "user-student" }),
        normalizeSessionFilters({}),
        facultyDeps([]),
      ),
    ForbiddenError,
    "attendanceRecord.read.own is not attendanceRecord.read",
  );
});

test("an attendance operator may capture but may not read the register history", async () => {
  await assert.rejects(
    () =>
      listFacultySessions(
        makeUser({ permissions: ["cohort.read", "attendanceSession.create", "attendanceSession.capture"] }),
        normalizeSessionFilters({}),
        facultyDeps([]),
      ),
    ForbiddenError,
  );
});

test("every filter reaches the query, combined rather than replacing one another", async () => {
  const capture: { scope?: unknown; where?: unknown } = {};
  await listFacultySessions(
    makeUser(),
    normalizeSessionFilters({
      from: "2026-09-01",
      to: "2026-09-30",
      cohortId: "coh-1",
      cohortSubjectId: "cs-dbms",
      status: "REVIEW",
    }),
    facultyDeps([], capture),
  );

  const where = capture.where as Record<string, unknown>;
  assert.equal(where.cohortId, "coh-1");
  assert.equal(where.cohortSubjectId, "cs-dbms");
  assert.equal(where.status, "REVIEW");
  assert.ok(where.sessionDate, "and the date range survives alongside them");
});

// ---------------------------------------------------------------------------
// 16. Empty states, and the truncation boundary
// ---------------------------------------------------------------------------

test("a truncated list says so rather than silently ending", async () => {
  const many = Array.from({ length: 201 }, (_, i) => sessionSummary({ id: `s${i}` }));
  const list = await listFacultySessions(
    makeUser(),
    normalizeSessionFilters({}),
    facultyDeps(many),
  );
  assert.equal(list.sessions.length, 200);
  assert.equal(list.truncated, true);
});

test("a list that exactly fills the page is not reported as truncated", async () => {
  const exact = Array.from({ length: 200 }, (_, i) => sessionSummary({ id: `s${i}` }));
  const list = await listFacultySessions(
    makeUser(),
    normalizeSessionFilters({}),
    facultyDeps(exact),
  );
  assert.equal(list.sessions.length, 200);
  assert.equal(list.truncated, false);
});

// ---------------------------------------------------------------------------
// 14. There is nothing here to mutate
// ---------------------------------------------------------------------------

test("the portal read models expose no write path", async () => {
  const service = await import("./service.ts");
  const writeish = Object.keys(service).filter((name) =>
    /^(create|update|delete|set|mark|correct|finalize|confirm|apply|save|write)/i.test(name),
  );
  assert.deepEqual(
    writeish,
    [],
    "a student portal is safe because there is no mutation to reach, not because a button is hidden",
  );
});
