import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignFacultyToCohortForRequest,
  createCohortForRequest,
  listCohortsForInstitutionRequest,
} from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { AcademicUnit } from "../academic-structure/types.ts";
import type { AcademicSession } from "../academic-sessions/types.ts";
import type { Cohort, CohortFaculty } from "./types.ts";

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

test("cross-institution cohort listing is denied before any repository call", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["cohort.read"] });
  let called = false;
  await assert.rejects(
    () =>
      listCohortsForInstitutionRequest(admin, "inst-B", {
        listCohortsByInstitution: async () => {
          called = true;
          return [];
        },
      }),
    ForbiddenError,
  );
  assert.equal(called, false);
});

// The join-point smuggle: request body says institutionId=inst-A (matches
// caller), but the AcademicUnit actually belongs to inst-B. Must be rejected.
test("cohort creation rejects a cross-institution AcademicUnit", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["cohort.manage"] });
  let createCalled = false;
  await assert.rejects(
    () =>
      createCohortForRequest(
        admin,
        {
          institutionId: "inst-A",
          academicUnitId: "unit-1",
          academicSessionId: "sess-1",
          name: "10-A",
        },
        {
          getAcademicUnitById: async () => ({ id: "unit-1", institutionId: "inst-B" } as AcademicUnit),
          getAcademicSessionById: async () => ({ id: "sess-1", institutionId: "inst-A" } as AcademicSession),
          createCohort: async () => {
            createCalled = true;
            return {} as Cohort;
          },
        },
      ),
    /cross_institution_academic_unit/,
  );
  assert.equal(createCalled, false);
});

test("cohort creation rejects a cross-institution AcademicSession", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["cohort.manage"] });
  let createCalled = false;
  await assert.rejects(
    () =>
      createCohortForRequest(
        admin,
        {
          institutionId: "inst-A",
          academicUnitId: "unit-1",
          academicSessionId: "sess-1",
          name: "10-A",
        },
        {
          getAcademicUnitById: async () => ({ id: "unit-1", institutionId: "inst-A" } as AcademicUnit),
          getAcademicSessionById: async () => ({ id: "sess-1", institutionId: "inst-B" } as AcademicSession),
          createCohort: async () => {
            createCalled = true;
            return {} as Cohort;
          },
        },
      ),
    /cross_institution_academic_session/,
  );
  assert.equal(createCalled, false);
});

test("assigning faculty rejects a user from a different institution", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["cohort.manage"] });
  let upsertCalled = false;
  await assert.rejects(
    () =>
      assignFacultyToCohortForRequest(
        admin,
        { cohortId: "coh-1", userId: "user-x", role: "PRIMARY" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getUserById: async () => ({ id: "user-x", institutionId: "inst-B" }),
          upsertCohortFaculty: async () => {
            upsertCalled = true;
            return {} as CohortFaculty;
          },
        },
      ),
    /cross_institution_user/,
  );
  assert.equal(upsertCalled, false);
});

test("a faculty without cohort.manage cannot assign class teachers", async () => {
  const faculty = makeUser({
    roleKey: "FACULTY",
    institutionId: "inst-A",
    permissions: ["cohort.read", "student.read"],
  });
  await assert.rejects(
    () =>
      assignFacultyToCohortForRequest(
        faculty,
        { cohortId: "coh-1", userId: "user-x", role: "PRIMARY" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getUserById: async () => ({ id: "user-x", institutionId: "inst-A" }),
          upsertCohortFaculty: async () => ({} as CohortFaculty),
        },
      ),
    ForbiddenError,
  );
});
