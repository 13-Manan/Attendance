import { test } from "node:test";
import assert from "node:assert/strict";
import { getInstitutionSettingsForUser, resolveAttendanceMode } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "./types.ts";

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

const FAKE_INSTITUTION = { id: "inst-A", name: "Delhi Public School" } as Institution;

// Scenario 3: admin accessing their OWN institution's settings — allowed.
test("an admin can read their own institution's settings", async () => {
  const admin = makeUser({ institutionId: "inst-A", roleKey: "INSTITUTION_ADMIN", permissions: ["institution.read"] });

  const result = await getInstitutionSettingsForUser(admin, "inst-A", {
    getInstitutionById: async () => FAKE_INSTITUTION,
  });

  assert.deepEqual(result, FAKE_INSTITUTION);
});

// Scenario 4: cross-institution data access — denied, and denied before any
// data is fetched.
test("an admin cannot read another institution's settings", async () => {
  const adminOfInstA = makeUser({
    institutionId: "inst-A",
    roleKey: "INSTITUTION_ADMIN",
    permissions: ["institution.read"],
  });
  let repositoryCalled = false;

  await assert.rejects(
    () =>
      getInstitutionSettingsForUser(adminOfInstA, "inst-B", {
        getInstitutionById: async () => {
          repositoryCalled = true;
          return FAKE_INSTITUTION;
        },
      }),
    ForbiddenError,
  );
  assert.equal(repositoryCalled, false, "the repository must never be called once cross-institution access is denied");
});

test("resolveAttendanceMode defaults schools to DAILY and colleges to SUBJECT_WISE", () => {
  const school = { type: "SCHOOL", settings: {} } as unknown as Institution;
  const college = { type: "COLLEGE", settings: {} } as unknown as Institution;
  assert.equal(resolveAttendanceMode(school), "DAILY");
  assert.equal(resolveAttendanceMode(college), "SUBJECT_WISE");
});

test("resolveAttendanceMode honors an explicit override", () => {
  const school = {
    type: "SCHOOL",
    settings: { attendanceMode: "SUBJECT_WISE" },
  } as unknown as Institution;
  assert.equal(resolveAttendanceMode(school), "SUBJECT_WISE");
});
