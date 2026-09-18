import { test } from "node:test";
import assert from "node:assert/strict";
import { listStudentsForCohortRequest } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Student } from "./types.ts";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "TEST_ROLE",
        name: "Test Role",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const ENROLLED_STUDENTS: Student[] = [
  { id: "student-1", firstName: "A", lastName: "One" } as Student,
  { id: "student-2", firstName: "B", lastName: "Two" } as Student,
];

// "School student cannot appear in another institution" / cross-institution
// data access, generalized: an institution admin from inst-A must be denied
// access to a cohort belonging to inst-B, before any data is fetched.
test("cross-institution cohort request is denied before any repository call", async () => {
  const adminOfInstA = makeUser({ institutionId: "inst-A", roleKey: "INSTITUTION_ADMIN", permissions: ["student.read"] });
  let listCalled = false;
  let accessCheckCalled = false;

  await assert.rejects(
    () =>
      listStudentsForCohortRequest(
        adminOfInstA,
        { cohortId: "cohort-in-inst-B", institutionId: "inst-B" },
        {
          checkCohortAccess: async () => {
            accessCheckCalled = true;
          },
          listStudentsByCohort: async () => {
            listCalled = true;
            return ENROLLED_STUDENTS;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(accessCheckCalled, false, "cohort access should never be checked once cross-institution is denied");
  assert.equal(listCalled, false, "the repository must never be called once access is denied");
});

// "Faculty only sees assigned classes/subjects": denied before the
// repository call when the ownership check fails.
test("faculty without a cohort-access link is denied before the repository call", async () => {
  const faculty = makeUser({ institutionId: "inst-A", roleKey: "FACULTY", permissions: ["student.read"] });
  let listCalled = false;

  await assert.rejects(
    () =>
      listStudentsForCohortRequest(
        faculty,
        { cohortId: "cohort-not-mine", institutionId: "inst-A" },
        {
          checkCohortAccess: async () => {
            throw new ForbiddenError("not_cohort_faculty");
          },
          listStudentsByCohort: async () => {
            listCalled = true;
            return ENROLLED_STUDENTS;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(listCalled, false);
});

// "College class only sees enrolled students": once authorized, the
// function returns exactly what the (enrollment-scoped) repository returns —
// no broader query is possible through this code path.
test("an authorized faculty member sees exactly the cohort's enrolled students", async () => {
  const faculty = makeUser({ institutionId: "inst-A", roleKey: "FACULTY", permissions: ["student.read"] });

  const result = await listStudentsForCohortRequest(
    faculty,
    { cohortId: "cohort-mine", institutionId: "inst-A" },
    {
      checkCohortAccess: async () => {},
      listStudentsByCohort: async () => ENROLLED_STUDENTS,
    },
  );

  assert.deepEqual(result, ENROLLED_STUDENTS);
});

test("a user without student.read is denied regardless of cohort access", async () => {
  const student = makeUser({ institutionId: "inst-A", roleKey: "STUDENT", permissions: ["student.read.own"] });

  await assert.rejects(
    () =>
      listStudentsForCohortRequest(
        student,
        { cohortId: "cohort-mine", institutionId: "inst-A" },
        { checkCohortAccess: async () => {}, listStudentsByCohort: async () => ENROLLED_STUDENTS },
      ),
    ForbiddenError,
  );
});
