import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getFilterOptions,
  getLowAttendance,
  getRecords,
  getRollup,
  resolveScope,
  type ReportAccess,
} from "./service.ts";
import type { ReportingDeps } from "./service.ts";
import type { ReportFilters } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";

/**
 * Phase 8 — who a report is allowed to be about.
 *
 * The reporting engine answers institution-wide questions, and Phase 8 opened
 * it to faculty. That is the dangerous direction to move a permission in: the
 * same screen, the same query string and the same export endpoint now serve
 * two audiences whose correct answers differ, and the only thing separating
 * them is `requireReportAccess` resolving a grant from the session.
 *
 * So these tests are almost all negative. The property being defended is not
 * "a lecturer can see their class" — that is easy and obvious — it is "a
 * lecturer asking for somebody else's class gets nothing, whatever they put
 * in the URL." Filters may narrow the grant. Nothing may widen it.
 */

const WINDOW: ReportFilters = {
  from: new Date("2026-09-01T00:00:00.000Z"),
  to: new Date("2026-10-01T00:00:00.000Z"),
};

const PAGE = { page: 1, pageSize: 25 };

function makeUser(permissions: string[], institutionId: string | null = "inst-A"): SessionUser {
  return {
    userId: "user-1",
    email: "person@example.com",
    name: "A Person",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "ROLE",
        name: "Role",
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const FACULTY = ["cohort.read", "attendanceRecord.read", "attendanceSession.capture"];
const CLASS_TEACHER = [...FACULTY, "enrollment.manage"];
const ADMIN = [...FACULTY, "institution.read", "cohort.manage"];
const STUDENT = ["student.read.own", "attendanceRecord.read.own", "cohort.read"];

/** Captures whatever scope the repository layer is ultimately handed. */
function spy() {
  const seen: { scope?: unknown } = {};
  const deps: ReportingDeps = {
    getInstitutionById: async () =>
      ({ id: "inst-A", name: "Test", type: "COLLEGE", settings: null }) as unknown as Institution,
    aggregateByDimension: async (_i, _d, _f, scope) => {
      seen.scope = scope;
      return [];
    },
    countSessionsByDimension: async () => [],
    listLowAttendanceStudents: async (_i, _f, scope) => {
      seen.scope = scope;
      return [];
    },
    countLowAttendanceStudents: async () => [{ count: 0 }],
    listRecords: async (_i, _f, scope) => {
      seen.scope = scope;
      return [];
    },
    countRecords: async () => [{ count: 0 }],
    aggregateOverall: async () => [],
    now: () => new Date("2026-09-20T10:00:00.000Z"),
  };
  return { seen, deps };
}

/** A lecturer: class teacher of c-8a, assigned subject cs-ds in c-9b. */
function teaching(cohortIds: string[], cohortSubjectIds: string[]): ReportingDeps {
  return {
    resolveFacultyScope: async () =>
      ({
        scope: { institutionId: "inst-A", cohortIds, cohortSubjectIds },
        kind: "assigned",
        cohorts: [],
        subjects: [],
        isClassTeacher: true,
      }) as never,
  };
}

function grantOf(scope: unknown) {
  return (scope as { facultyScope: unknown }).facultyScope;
}

// ---------------------------------------------------------------------------
// 1–3. A student reaches none of it
// ---------------------------------------------------------------------------

test("a student cannot run an institution report", async () => {
  const { deps } = spy();
  await assert.rejects(
    () => getRollup(makeUser(STUDENT), "cohort", WINDOW, PAGE, "label", deps),
    ForbiddenError,
    "attendanceRecord.read.own is not attendanceRecord.read",
  );
});

test("a student cannot reach the record listing or the low-attendance list", async () => {
  const { deps } = spy();
  await assert.rejects(
    () => getRecords(makeUser(STUDENT), WINDOW, PAGE, deps),
    ForbiddenError,
  );
  await assert.rejects(
    () => getLowAttendance(makeUser(STUDENT), WINDOW, PAGE, undefined, deps),
    ForbiddenError,
  );
});

test("a student cannot enumerate the institution through the filter options", async () => {
  await assert.rejects(() => getFilterOptions(makeUser(STUDENT), spy().deps), ForbiddenError);
});

test("a student cannot reach a report by grouping by student", async () => {
  // The dimension is not a permission. Grouping by student does not turn
  // "my own attendance" into "everyone's, listed".
  const { deps } = spy();
  await assert.rejects(
    () => getRollup(makeUser(STUDENT), "student", WINDOW, PAGE, "label", deps),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// 4–7. Faculty are held to their assignment
// ---------------------------------------------------------------------------

test("a lecturer's report carries their grant into the query", async () => {
  const { seen, deps } = spy();
  await getRollup(makeUser(FACULTY), "cohort", WINDOW, PAGE, "label", {
    ...deps,
    ...teaching(["c-8a"], ["cs-ds"]),
  });
  assert.deepEqual(grantOf(seen.scope), { cohortIds: ["c-8a"], cohortSubjectIds: ["cs-ds"] });
});

test("asking for an unrelated cohort does not widen the grant", async () => {
  const { seen, deps } = spy();
  await getRollup(
    makeUser(FACULTY),
    "cohort",
    { ...WINDOW, cohortIds: ["c-not-mine"] },
    PAGE,
    "label",
    { ...deps, ...teaching(["c-8a"], []) },
  );

  const scope = seen.scope as { cohortIds: string[] | null; facultyScope: unknown };
  // The filter lands where filters land...
  assert.deepEqual(scope.cohortIds, ["c-not-mine"]);
  // ...and the grant is untouched beside it. The repository ANDs the two, so
  // the intersection is empty — an empty report, not somebody else's class.
  assert.deepEqual(grantOf(seen.scope), { cohortIds: ["c-8a"], cohortSubjectIds: [] });
});

test("asking for an unrelated subject does not widen the grant", async () => {
  const { seen, deps } = spy();
  await getRollup(
    makeUser(FACULTY),
    "subject",
    { ...WINDOW, subjectIds: ["subj-not-mine"] },
    PAGE,
    "label",
    { ...deps, ...teaching([], ["cs-ds"]) },
  );
  assert.deepEqual(grantOf(seen.scope), { cohortIds: [], cohortSubjectIds: ["cs-ds"] });
});

test("a subject lecturer is not promoted to the whole class by the grant", async () => {
  // Reaching a class through one assigned subject must not carry the class's
  // other registers with it. The grant keeps the two lists apart precisely so
  // the query can say "this class OR this subject link", never "this class".
  const { seen, deps } = spy();
  await getRollup(makeUser(FACULTY), "cohort", WINDOW, PAGE, "label", {
    ...deps,
    ...teaching([], ["cs-ds"]),
  });
  const grant = grantOf(seen.scope) as { cohortIds: string[]; cohortSubjectIds: string[] };
  assert.deepEqual(grant.cohortIds, [], "no class-level reach from a subject assignment");
  assert.deepEqual(grant.cohortSubjectIds, ["cs-ds"]);
});

test("a faculty member with no assignment gets an empty grant, not an absent one", async () => {
  // The distinction that matters: `{cohortIds: [], cohortSubjectIds: []}` is
  // enforced as an unsatisfiable clause, whereas `null` would mean
  // institution-wide. A new teacher must see nothing, not everything.
  const { seen, deps } = spy();
  await getRollup(makeUser(FACULTY), "cohort", WINDOW, PAGE, "label", {
    ...deps,
    ...teaching([], []),
  });
  assert.deepEqual(grantOf(seen.scope), { cohortIds: [], cohortSubjectIds: [] });
  assert.notEqual(grantOf(seen.scope), null);
});

test("a class teacher is scoped the same way as any other faculty member", async () => {
  const { seen, deps } = spy();
  await getRollup(makeUser(CLASS_TEACHER), "student", WINDOW, PAGE, "label", {
    ...deps,
    ...teaching(["c-8a"], []),
  });
  assert.deepEqual(grantOf(seen.scope), { cohortIds: ["c-8a"], cohortSubjectIds: [] });
});

test("the grant survives a unit filter, which resolves cohorts independently", async () => {
  // A unit filter walks the academic tree and produces cohort ids. That is a
  // filter, and it must not be mistaken for a grant: resolving "Grade 8" must
  // not hand a lecturer the classes in Grade 8 they do not teach.
  const { seen, deps } = spy();
  await getRollup(
    makeUser(FACULTY),
    "cohort",
    { ...WINDOW, academicUnitIds: ["grade-8"] },
    PAGE,
    "label",
    {
      ...deps,
      ...teaching(["c-8a"], []),
      loadUnitTreeRows: async () => ({
        units: [{ id: "grade-8", parentId: null, kind: "GRADE", name: "Grade 8", code: null }],
        cohorts: [
          { id: "c-8a", academicUnitId: "grade-8" },
          { id: "c-8b", academicUnitId: "grade-8" },
        ],
      }),
    },
  );
  const scope = seen.scope as { cohortIds: string[] | null };
  assert.deepEqual(scope.cohortIds?.sort(), ["c-8a", "c-8b"], "the filter resolved both");
  assert.deepEqual(
    grantOf(seen.scope),
    { cohortIds: ["c-8a"], cohortSubjectIds: [] },
    "but the grant still names only 8A, and the query ANDs them",
  );
});

// ---------------------------------------------------------------------------
// 8–9. Cross-tenant
// ---------------------------------------------------------------------------

test("a platform account with no institution is refused rather than shown every tenant", async () => {
  const { deps } = spy();
  await assert.rejects(
    () => getRollup(makeUser(ADMIN, null), "cohort", WINDOW, PAGE, "label", deps),
    ForbiddenError,
  );
});

test("the institution is resolved from the session, never from a filter", async () => {
  // There is no institutionId parameter anywhere in ReportFilters. This pins
  // that, so adding one later has to be a deliberate act with a test to
  // delete rather than an accident.
  assert.equal("institutionId" in (WINDOW as object), false);
  const { seen, deps } = spy();
  await getRollup(makeUser(ADMIN), "cohort", WINDOW, PAGE, "label", deps);
  assert.equal(grantOf(seen.scope), null, "an admin is unrestricted inside their own tenant only");
});

// ---------------------------------------------------------------------------
// Filter options are themselves a disclosure
// ---------------------------------------------------------------------------

const ALL_OPTIONS = {
  cohorts: [
    { id: "c-8a", name: "8A", termLabel: null },
    { id: "c-8b", name: "8B", termLabel: null },
  ],
  academicUnits: [
    { id: "grade-8", name: "Grade 8", code: null, kind: "GRADE" as const, parentId: null },
  ],
  subjects: [
    { id: "subj-ds", name: "Data Structures", code: "CS301" },
    { id: "subj-os", name: "Operating Systems", code: "CS302" },
  ],
  faculty: [{ id: "user-2", name: "Another Lecturer" }],
};

test("an administrator is offered the whole institution to filter by", async () => {
  const options = await getFilterOptions(makeUser(ADMIN), {
    ...spy().deps,
    listFilterOptions: async () => ALL_OPTIONS,
  });
  assert.equal(options.cohorts.length, 2);
  assert.equal(options.faculty.length, 1);
});

test("a lecturer's filter form names only what they teach", async () => {
  const options = await getFilterOptions(makeUser(FACULTY), {
    ...spy().deps,
    ...teaching(["c-8a"], ["cs-ds"]),
    listFilterOptions: async () => ALL_OPTIONS,
    listReachableSubjectIds: async () => ["subj-ds"],
  });

  assert.deepEqual(options.cohorts.map((c) => c.id), ["c-8a"]);
  assert.deepEqual(options.subjects.map((s) => s.id), ["subj-ds"]);
  assert.deepEqual(
    options.faculty,
    [],
    "a dropdown of colleagues is a staff list, and not one a lecturer is owed",
  );
  assert.deepEqual(
    options.academicUnits,
    [],
    "and the academic tree is the institution's shape, which a two-class grant does not need",
  );
});

// ---------------------------------------------------------------------------
// The scope object itself
// ---------------------------------------------------------------------------

test("resolveScope carries the grant through untouched on the fast path", async () => {
  const access: ReportAccess = {
    institutionId: "inst-A",
    facultyScope: { cohortIds: ["c-8a"], cohortSubjectIds: [] },
  };
  const scope = await resolveScope(access, null, WINDOW);
  assert.deepEqual(scope, {
    cohortIds: null,
    buckets: null,
    facultyScope: { cohortIds: ["c-8a"], cohortSubjectIds: [] },
  });
});

test("an admin scope is explicitly null rather than an empty grant", async () => {
  const scope = await resolveScope({ institutionId: "inst-A", facultyScope: null }, null, WINDOW);
  assert.equal(scope.facultyScope, null);
});
