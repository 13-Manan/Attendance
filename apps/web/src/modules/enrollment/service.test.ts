import { test } from "node:test";
import assert from "node:assert/strict";
import { enrollStudentInCohortForRequest, listEnrollmentsForRequest } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Student } from "../students/types.ts";
import type { Enrollment } from "./types.ts";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

// "School student cannot appear in another institution" — the enrollment
// choke point. A student from inst-B being pushed into a cohort from inst-A
// would leak that student into inst-A's per-cohort face search scope.
test("enrolling a student from another institution is denied before any write", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["enrollment.manage"] });
  let called = false;
  await assert.rejects(
    () =>
      enrollStudentInCohortForRequest(
        admin,
        { studentId: "stu-1", cohortId: "coh-1" },
        {
          getStudentById: async () => ({ id: "stu-1", institutionId: "inst-B" } as Student),
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          upsertEnrollment: async () => {
            called = true;
            return {} as Enrollment;
          },
        },
      ),
    /cross_institution_enrollment/,
  );
  assert.equal(called, false);
});

test("an admin from inst-A cannot enroll a student into an inst-B cohort", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["enrollment.manage"] });
  let called = false;
  await assert.rejects(
    () =>
      enrollStudentInCohortForRequest(
        admin,
        { studentId: "stu-1", cohortId: "coh-B" },
        {
          getStudentById: async () => ({ id: "stu-1", institutionId: "inst-B" } as Student),
          getCohortById: async () => ({ id: "coh-B", institutionId: "inst-B" } as Cohort),
          upsertEnrollment: async () => {
            called = true;
            return {} as Enrollment;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(called, false);
});

test("listing enrollments for a foreign cohort is denied", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["cohort.read"] });
  let listed = false;
  await assert.rejects(
    () =>
      listEnrollmentsForRequest(admin, "coh-B", {
        getCohortById: async () => ({ id: "coh-B", institutionId: "inst-B" } as Cohort),
        listEnrollmentsForCohort: async () => {
          listed = true;
          return [];
        },
      }),
    ForbiddenError,
  );
  assert.equal(listed, false);
});
