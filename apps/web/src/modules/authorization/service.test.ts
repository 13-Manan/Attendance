import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPermission, requirePermission, requireSameInstitution } from "./service.ts";
import { ForbiddenError } from "./types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

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

// Scenario 1: student accessing admin functionality must be denied.
test("student cannot exercise admin permissions", () => {
  const student = makeUser({ roleKey: "STUDENT", permissions: ["student.read.own", "attendanceRecord.read.own"] });
  assert.equal(hasPermission(student, "role.assign"), false);
  assert.throws(() => requirePermission(student, "role.assign"), ForbiddenError);
});

// Scenario 2: teacher accessing admin functionality must be denied.
test("teacher/faculty cannot exercise admin permissions", () => {
  const faculty = makeUser({
    roleKey: "FACULTY",
    permissions: ["cohort.read", "student.read", "attendanceRecord.correct"],
  });
  assert.equal(hasPermission(faculty, "user.deactivate"), false);
  assert.throws(() => requirePermission(faculty, "user.deactivate"), ForbiddenError);
});

test("a role that does grant the permission passes", () => {
  const admin = makeUser({ roleKey: "INSTITUTION_ADMIN", permissions: ["institution.update", "user.deactivate"] });
  assert.equal(hasPermission(admin, "institution.update"), true);
  assert.doesNotThrow(() => requirePermission(admin, "institution.update"));
});

// Scenario 3: admin accessing their OWN institution's settings is allowed.
test("requireSameInstitution allows a user acting on their own institution", () => {
  const admin = makeUser({ institutionId: "inst-A", roleKey: "INSTITUTION_ADMIN", permissions: ["institution.update"] });
  assert.doesNotThrow(() => requireSameInstitution(admin, "inst-A"));
});

// Scenario 4: cross-institution access must be denied.
test("requireSameInstitution denies cross-institution access", () => {
  const adminOfInstA = makeUser({
    institutionId: "inst-A",
    roleKey: "INSTITUTION_ADMIN",
    permissions: ["institution.update"],
  });
  assert.throws(() => requireSameInstitution(adminOfInstA, "inst-B"), ForbiddenError);
});

test("a platform super admin bypasses the cross-institution check", () => {
  const platformAdmin = makeUser({
    institutionId: null,
    roleKey: "PLATFORM_SUPER_ADMIN",
    permissions: ["platform.institution.create"],
  });
  assert.doesNotThrow(() => requireSameInstitution(platformAdmin, "inst-B"));
});
