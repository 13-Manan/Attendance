import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPermission } from "../authorization/service.ts";
import { SYSTEM_ROLES } from "../authorization/permissions.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { decideCollegeScope, delegate } from "./scope.ts";

const base = {
  institutionId: "inst",
  isAdmin: false,
  isDepartmentHead: true,
  headedDepartmentIds: ["cse"],
  userDepartmentId: "cse",
  userActive: true,
};

test("an administrator reaches every department", () => {
  assert.deepEqual(decideCollegeScope({ ...base, isAdmin: true, isDepartmentHead: false }), {
    kind: "admin",
    institutionId: "inst",
  });
});

test("a head of department reaches exactly the department that names them and is theirs", () => {
  assert.deepEqual(decideCollegeScope(base), { kind: "hod", institutionId: "inst", departmentId: "cse" });
});

test("a head is refused when any of the facts disagree — never widened", () => {
  // Moved to Mechanical on the Faculty page: CSE still names them, but they
  // are no longer CSE's — and Mechanical does not name them. Neither.
  assert.equal(decideCollegeScope({ ...base, userDepartmentId: "me" }), null);
  // Named nowhere (stepped down), still holding the role for a moment.
  assert.equal(decideCollegeScope({ ...base, headedDepartmentIds: [] }), null);
  // Their account has been stopped.
  assert.equal(decideCollegeScope({ ...base, userActive: false }), null);
  // No department at all.
  assert.equal(decideCollegeScope({ ...base, userDepartmentId: null }), null);
  // The role is gone.
  assert.equal(decideCollegeScope({ ...base, isDepartmentHead: false }), null);
  // Two departments name them (a corrupted row): only their own counts.
  assert.deepEqual(decideCollegeScope({ ...base, headedDepartmentIds: ["me", "cse"] }), {
    kind: "hod",
    institutionId: "inst",
    departmentId: "cse",
  });
});

test("a delegated call carries exactly the lent permissions, and the actor is left unchanged", () => {
  const head: SessionUser = {
    userId: "hod",
    email: "hod@college.test",
    name: "Head",
    institutionId: "inst",
    campusId: null,
    roles: [{ key: "HOD", name: "Head of Department", institutionId: null, campusId: null, permissions: ["department.manage"] }],
  };
  const lent = delegate(head, ["enrollment.manage"]);
  assert.equal(lent.userId, "hod", "audit rows still name the head");
  assert.equal(hasPermission(lent, "enrollment.manage"), true);
  assert.equal(hasPermission(lent, "student.create"), false);
  assert.equal(hasPermission(lent, "student.read"), false);
  assert.equal(hasPermission(head, "enrollment.manage"), false, "the caller's own session is not widened");
});

test("the HOD role can teach and run one department, and reads nothing college-wide", () => {
  const hod = SYSTEM_ROLES.find((role) => role.key === "HOD");
  assert.ok(hod, "HOD is a system role");
  assert.deepEqual([...hod.permissions].sort(), [
    "attendanceRecord.correct",
    "attendanceRecord.read",
    "attendanceSession.capture",
    "attendanceSession.create",
    "attendanceSession.finalize",
    "department.manage",
  ]);
  // Each of these would reach another department's rows through an existing
  // institution-wide screen or bypass.
  for (const forbidden of [
    "student.read",
    "cohort.read",
    "institution.read",
    "cohort.manage",
    "academicStructure.manage",
    "enrollment.manage",
    "student.create",
    "student.update",
    "user.invite",
    "user.update",
    "user.deactivate",
    "role.assign",
    "faceEmbedding.manage",
    "auditLog.read",
  ]) {
    assert.equal((hod.permissions as string[]).includes(forbidden), false, `HOD must not hold ${forbidden}`);
  }
});

test("department.manage belongs to the HOD role and the platform role only", () => {
  const holders = SYSTEM_ROLES.filter((role) => (role.permissions as string[]).includes("department.manage"))
    .map((role) => role.key)
    .sort();
  assert.deepEqual(holders, ["HOD", "PLATFORM_SUPER_ADMIN"]);
});
