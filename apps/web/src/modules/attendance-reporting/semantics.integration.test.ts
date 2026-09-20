import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { aggregateByDimension, aggregateOverall } from "./repository.ts";
import type { CohortScope } from "./unit-tree.ts";
import type { ReportFilters } from "./types.ts";

/**
 * What a report is allowed to count, measured against real PostgreSQL.
 *
 * Every rule in this file lives in a raw SQL string — `s.status = 'FINALIZED'`,
 * `count(*) FILTER (WHERE ar."finalResult" = 'PRESENT')`, and the grant clause
 * Phase 8 added. None of it is reachable by a unit test with a stubbed
 * repository: stubbing the repository stubs out precisely the code that
 * decides which rows are eligible, so a suite full of green unit tests would
 * say nothing about whether a cancelled session is counted as attendance.
 *
 * That matters more here than almost anywhere else in the product. A report is
 * the artefact somebody quotes in a meeting, and the two ways it can lie are
 * counting a register nobody confirmed, and counting a student's unresolved
 * row as an absence. Both are one word in a WHERE clause away.
 *
 * Gated on a real database, and skipped otherwise, following
 * `lib/face-ai-client.integration.test.ts`:
 *
 *   REPORTING_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.REPORTING_DB_TEST !== "1" ? "REPORTING_DB_TEST is not set" : false;

const INSTITUTION = "rpt-inst";
const OTHER_INSTITUTION = "rpt-inst-other";
const COHORT_A = "rpt-cohort-a";
const COHORT_B = "rpt-cohort-b";
const SUBJECT_LINK_A = "rpt-cs-a";

const WINDOW: ReportFilters = {
  from: new Date("2026-09-01T00:00:00.000Z"),
  to: new Date("2026-10-01T00:00:00.000Z"),
};

const UNRESTRICTED: CohortScope = { cohortIds: null, buckets: null, facultyScope: null };

/**
 * Fixture, written straight to the tables rather than through the domain
 * services on purpose.
 *
 * The services refuse to produce most of these states — Phase 6 will not
 * finalize a session holding a NEEDS_REVIEW row, which is exactly the
 * invariant that makes "unresolved rows are excluded" hard to reach through
 * the front door. The rule still has to hold: a row can arrive in that state
 * through a historical import or a register that was cancelled mid-review,
 * and a report must not quietly turn one into an absence.
 */
async function seed() {
  await cleanup();

  await prisma.institution.createMany({
    data: [
      { id: INSTITUTION, name: "Reporting Test", type: "SCHOOL" },
      { id: OTHER_INSTITUTION, name: "Other Tenant", type: "SCHOOL" },
    ],
  });

  await prisma.academicSession.create({
    data: {
      id: "rpt-as",
      institutionId: INSTITUTION,
      name: "2026-27",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2027-05-31T00:00:00.000Z"),
      isCurrent: true,
    },
  });

  await prisma.academicUnit.create({
    data: { id: "rpt-unit", institutionId: INSTITUTION, kind: "GRADE", name: "Grade 8" },
  });

  await prisma.cohort.createMany({
    data: [
      {
        id: COHORT_A,
        institutionId: INSTITUTION,
        academicUnitId: "rpt-unit",
        academicSessionId: "rpt-as",
        name: "8A",
      },
      {
        id: COHORT_B,
        institutionId: INSTITUTION,
        academicUnitId: "rpt-unit",
        academicSessionId: "rpt-as",
        name: "8B",
      },
    ],
  });

  await prisma.subject.create({
    data: { id: "rpt-subj", institutionId: INSTITUTION, name: "Maths", code: "M1" },
  });
  await prisma.cohortSubject.create({
    data: { id: SUBJECT_LINK_A, cohortId: COHORT_B, subjectId: "rpt-subj" },
  });

  await prisma.user.create({
    data: {
      id: "rpt-user",
      institutionId: INSTITUTION,
      email: "rpt@test.local",
      name: "Teacher",
      passwordHash: "x",
      status: "ACTIVE",
    },
  });

  // Four students, because `AttendanceRecord` is unique on
  // (sessionId, studentId) — one register line per student, which is the
  // right constraint and means the four result states need four people.
  await prisma.student.createMany({
    data: [1, 2, 3, 4].map((n) => ({
      id: `rpt-stu-${n}`,
      institutionId: INSTITUTION,
      studentCode: `S${n}`,
      firstName: "Test",
      lastName: `Student ${n}`,
      status: "ACTIVE" as const,
    })),
  });

  // One session per status, each with exactly one PRESENT record, so any
  // status wrongly treated as eligible shows up as +1 present.
  const sessions = [
    { id: "rpt-s-final", cohortId: COHORT_A, cohortSubjectId: null, status: "FINALIZED" },
    { id: "rpt-s-review", cohortId: COHORT_A, cohortSubjectId: null, status: "REVIEW" },
    { id: "rpt-s-open", cohortId: COHORT_A, cohortSubjectId: null, status: "OPEN" },
    { id: "rpt-s-processing", cohortId: COHORT_A, cohortSubjectId: null, status: "PROCESSING" },
    { id: "rpt-s-capturing", cohortId: COHORT_A, cohortSubjectId: null, status: "CAPTURING" },
    { id: "rpt-s-cancelled", cohortId: COHORT_A, cohortSubjectId: null, status: "CANCELLED" },
    { id: "rpt-s-b", cohortId: COHORT_B, cohortSubjectId: SUBJECT_LINK_A, status: "FINALIZED" },
  ] as const;

  for (const session of sessions) {
    await prisma.attendanceSession.create({
      data: {
        id: session.id,
        institutionId: INSTITUTION,
        cohortId: session.cohortId,
        cohortSubjectId: session.cohortSubjectId,
        facultyId: "rpt-user",
        sessionDate: new Date("2026-09-15T00:00:00.000Z"),
        startedAt: new Date("2026-09-15T09:00:00.000Z"),
        status: session.status,
      },
    });
    await prisma.attendanceRecord.create({
      data: {
        id: `${session.id}-rec`,
        institutionId: INSTITUTION,
        sessionId: session.id,
        studentId: "rpt-stu-1",
        aiResult: "PRESENT",
        finalResult: "PRESENT",
      },
    });
  }

  // The other three states, on the finalized register alongside student 1's
  // PRESENT. A real ABSENT so the denominator is not trivially 1, and the two
  // unresolved states that must stay out of it entirely.
  await prisma.attendanceRecord.createMany({
    data: [
      {
        id: "rpt-r-absent",
        institutionId: INSTITUTION,
        sessionId: "rpt-s-final",
        studentId: "rpt-stu-2",
        aiResult: "ABSENT",
        finalResult: "ABSENT",
      },
      {
        id: "rpt-r-review",
        institutionId: INSTITUTION,
        sessionId: "rpt-s-final",
        studentId: "rpt-stu-3",
        aiResult: "NEEDS_REVIEW",
        finalResult: "NEEDS_REVIEW",
      },
      {
        id: "rpt-r-noteval",
        institutionId: INSTITUTION,
        sessionId: "rpt-s-final",
        studentId: "rpt-stu-4",
        aiResult: "NOT_EVALUATED",
        finalResult: "NOT_EVALUATED",
      },
    ],
  });
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "AttendanceRecord" WHERE "institutionId" IN (${INSTITUTION}, ${OTHER_INSTITUTION})`;
  await prisma.$executeRaw`DELETE FROM "AttendanceSession" WHERE "institutionId" IN (${INSTITUTION}, ${OTHER_INSTITUTION})`;
  await prisma.$executeRaw`DELETE FROM "CohortSubject" WHERE id = ${SUBJECT_LINK_A}`;
  await prisma.$executeRaw`DELETE FROM "Subject" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "Enrollment" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "Student" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "Cohort" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "AcademicUnit" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "AcademicSession" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "User" WHERE "institutionId" = ${INSTITUTION}`;
  await prisma.$executeRaw`DELETE FROM "Institution" WHERE id IN (${INSTITUTION}, ${OTHER_INSTITUTION})`;
}

before(async () => {
  if (SKIP) return;
  await seed();
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

test("only finalized sessions are counted", { skip: SKIP }, async () => {
  const rows = await aggregateOverall(INSTITUTION, WINDOW, UNRESTRICTED);
  // Eligible: the PRESENT on rpt-s-final, its ABSENT, and the PRESENT on
  // rpt-s-b. The five non-finalized sessions contribute nothing at all.
  assert.equal(rows[0]?.present ?? 0, 2, "REVIEW/OPEN/PROCESSING/CAPTURING must not count");
  assert.equal(rows[0]?.absent ?? 0, 1);
});

test("a cancelled session is not attendance", { skip: SKIP }, async () => {
  const rows = await aggregateByDimension(
    INSTITUTION,
    "cohort",
    WINDOW,
    UNRESTRICTED,
    "label",
    50,
    0,
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // 8A's only eligible register is rpt-s-final: 1 present, 1 absent. If the
  // cancelled session leaked in, present would be 2.
  assert.equal(byKey.get(COHORT_A)?.present, 1);
  assert.equal(byKey.get(COHORT_A)?.absent, 1);
});

test("unresolved rows are in neither the numerator nor the denominator", { skip: SKIP }, async () => {
  const rows = await aggregateOverall(INSTITUTION, WINDOW, UNRESTRICTED);
  const present = rows[0]?.present ?? 0;
  const absent = rows[0]?.absent ?? 0;
  assert.equal(present + absent, 3, "NEEDS_REVIEW and NOT_EVALUATED are not decisions");
  // The percentage a report would quote: 2/3, not 2/5.
  assert.equal(Math.round((present / (present + absent)) * 1000) / 10, 66.7);
});

test("the teaching grant restricts the rollup to assigned classes", { skip: SKIP }, async () => {
  const scope: CohortScope = {
    cohortIds: null,
    buckets: null,
    facultyScope: { cohortIds: [COHORT_A], cohortSubjectIds: [] },
  };
  const rows = await aggregateByDimension(INSTITUTION, "cohort", WINDOW, scope, "label", 50, 0);
  assert.deepEqual(
    rows.map((r) => r.key),
    [COHORT_A],
    "8B is a real class with a finalized register, and is still absent",
  );
});

test("a subject grant reaches that subject's register and not the class", { skip: SKIP }, async () => {
  const scope: CohortScope = {
    cohortIds: null,
    buckets: null,
    facultyScope: { cohortIds: [], cohortSubjectIds: [SUBJECT_LINK_A] },
  };
  const rows = await aggregateByDimension(INSTITUTION, "cohort", WINDOW, scope, "label", 50, 0);
  assert.deepEqual(rows.map((r) => r.key), [COHORT_B]);
  assert.equal(rows[0]?.present, 1, "only the subject's own register");
});

test("an empty grant reaches nothing, rather than everything", { skip: SKIP }, async () => {
  const scope: CohortScope = {
    cohortIds: null,
    buckets: null,
    facultyScope: { cohortIds: [], cohortSubjectIds: [] },
  };
  const rows = await aggregateByDimension(INSTITUTION, "cohort", WINDOW, scope, "label", 50, 0);
  assert.deepEqual(rows, [], "the FALSE clause, measured rather than assumed");

  const overall = await aggregateOverall(INSTITUTION, WINDOW, scope);
  assert.equal(overall[0]?.present ?? 0, 0);
});

test("a cohort filter outside the grant intersects to nothing", { skip: SKIP }, async () => {
  const scope: CohortScope = {
    // The caller asked for 8B; the grant only permits 8A.
    cohortIds: [COHORT_B],
    buckets: null,
    facultyScope: { cohortIds: [COHORT_A], cohortSubjectIds: [] },
  };
  const rows = await aggregateByDimension(INSTITUTION, "cohort", WINDOW, scope, "label", 50, 0);
  assert.deepEqual(rows, [], "a filter cannot reach outside the grant");
});

test("the date window is half-open and excludes the upper bound", { skip: SKIP }, async () => {
  const before = await aggregateOverall(
    INSTITUTION,
    { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-09-15T00:00:00.000Z") },
    UNRESTRICTED,
  );
  assert.equal(before[0]?.present ?? 0, 0, "a session on the 15th is outside [1, 15)");

  const including = await aggregateOverall(
    INSTITUTION,
    { from: new Date("2026-09-15T00:00:00.000Z"), to: new Date("2026-09-16T00:00:00.000Z") },
    UNRESTRICTED,
  );
  assert.equal(including[0]?.present ?? 0, 2);
});

test("another tenant's data is never reachable through the institution id", { skip: SKIP }, async () => {
  const rows = await aggregateOverall(OTHER_INSTITUTION, WINDOW, UNRESTRICTED);
  assert.equal(rows[0]?.present ?? 0, 0);
});
