import { test } from "node:test";
import assert from "node:assert/strict";
import { PERMISSIONS, SYSTEM_ROLES } from "../authorization/permissions.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import {
  ACCESS_GROUPS,
  ACCESS_ITEMS,
  NARROWED_FROM,
  NEVER_GRANTABLE,
  accessFromPermissions,
  defaultAccess,
  isReceptionist,
  isReceptionistRoleKey,
  permissionsFor,
  receptionistRoleKey,
  resolveAccess,
} from "./catalog.ts";
import { grantableAccess, mayGrant, validateReceptionistPhone } from "./policy.ts";
import { ReceptionistError } from "./types.ts";

function actor(roleKey: string, extra: string[] = []): SessionUser {
  const role = SYSTEM_ROLES.find((r) => r.key === roleKey)!;
  return {
    userId: "u1",
    email: "u1@test.local",
    name: "U",
    institutionId: "inst",
    campusId: null,
    roles: [
      {
        key: role.key,
        name: role.name,
        institutionId: "inst",
        campusId: null,
        permissions: [...role.permissions, ...extra] as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

test("a new receptionist starts with the everyday work on and administration off", () => {
  const on = new Set(defaultAccess());
  for (const id of [
    "students.directory",
    "students.add",
    "students.edit",
    "students.placement",
    "students.logins",
    "students.passwords",
    "students.faces",
    "attendance.take",
    "attendance.review",
    "reports.attendance",
    "faculty.view",
  ]) {
    assert.ok(on.has(id), `${id} should be on by default`);
  }
  for (const id of [
    "students.twins",
    "academic.classes",
    "faculty.manage",
    "admin.settings.view",
    "admin.settings.manage",
    "admin.audit",
  ]) {
    assert.ok(!on.has(id), `${id} should be off by default`);
  }
  const keys = permissionsFor(defaultAccess());
  for (const key of ["institution.read", "institution.update", "auditLog.read", "cohort.manage", "twinConfirmation.decide", "staff.manage"]) {
    assert.ok(!keys.includes(key as never), `${key} must not be granted by default`);
  }
});

test("every switch grants real catalogue keys, at least one of its own, and never a key on the never list", () => {
  const catalogue = new Set<string>(PERMISSIONS);
  for (const item of ACCESS_ITEMS) {
    assert.ok(item.grants.length > 0, item.id);
    for (const key of item.grants) {
      assert.ok(catalogue.has(key), `${item.id}: ${key} is not a permission`);
      assert.ok(!NEVER_GRANTABLE.has(key), `${item.id}: ${key} is never grantable`);
    }
    const others = new Set(ACCESS_ITEMS.filter((o) => o.id !== item.id).flatMap((o) => o.grants));
    assert.ok(item.grants.some((key) => !others.has(key)), `${item.id} has no key of its own, so its state can't be read back`);
    for (const dependency of item.requires) assert.ok(ACCESS_ITEMS.some((o) => o.id === dependency), `${item.id} requires unknown ${dependency}`);
    assert.ok(ACCESS_GROUPS.some((group) => group.id === item.group), item.id);
    assert.ok(item.description.length > 0 && !/_|\./.test(item.label), item.id);
  }
  for (const group of ACCESS_GROUPS) assert.ok(ACCESS_ITEMS.some((item) => item.group === group.id), `${group.id} is empty`);
});

test("everything that is off by default and sensitive asks before it is turned on", () => {
  for (const item of ACCESS_ITEMS.filter((i) => i.group === "administration" || i.id === "students.twins" || i.id === "faculty.manage" || i.id === "academic.classes")) {
    assert.equal(item.defaultOn, false, item.id);
    assert.ok(item.confirm && item.confirm.length > 20, `${item.id} has no confirmation`);
  }
});

test("switches resolve with what they need; unknown names are dropped, never guessed", () => {
  assert.deepEqual(resolveAccess(["attendance.take"]), ["attendance.take", "attendance.review", "reports.attendance"]);
  assert.deepEqual(resolveAccess(["attendance.review"]), ["attendance.review", "reports.attendance"]);
  assert.deepEqual(resolveAccess(["students.faces", "made.up", "role.assign"]), ["students.directory", "students.faces"]);
  assert.deepEqual(resolveAccess(["admin.settings.manage"]), ["admin.settings.view", "admin.settings.manage"]);
  assert.deepEqual(permissionsFor(["students.passwords"]), ["cohort.read", "student.read", "studentLogin.reveal"].sort());
});

test("the switches read back from the role's keys exactly, whatever the combination", () => {
  const all = ACCESS_ITEMS.map((item) => item.id);
  // Every subset that is closed under dependencies round-trips.
  for (let mask = 0; mask < 2 ** 10; mask++) {
    const picked = all.filter((_, i) => i < 10 && (mask >> i) & 1);
    const resolved = resolveAccess(picked);
    assert.deepEqual(accessFromPermissions(permissionsFor(resolved)), resolved, picked.join(","));
  }
  assert.deepEqual(accessFromPermissions(permissionsFor(defaultAccess())), resolveAccess(defaultAccess()));
});

test("a receptionist is known by their own role key, and nobody else's key looks like one", () => {
  assert.equal(receptionistRoleKey("abc"), "RECEPTIONIST__abc");
  assert.ok(isReceptionistRoleKey("RECEPTIONIST__abc"));
  for (const role of SYSTEM_ROLES) assert.ok(!isReceptionistRoleKey(role.key), role.key);
  assert.ok(isReceptionist({ roles: [{ key: "RECEPTIONIST__x" }] }));
  assert.ok(!isReceptionist({ roles: [{ key: "SCHOOL_ADMIN" }] }));
});

test("a principal may grant every switch; a teacher, an operator and a head of department may grant none of the administration", () => {
  const principal = actor("SCHOOL_ADMIN");
  for (const item of ACCESS_ITEMS) {
    for (const key of item.grants) assert.ok(mayGrant(principal, key), `${item.id}: ${key}`);
  }
  assert.deepEqual(grantableAccess(principal, ACCESS_ITEMS.map((i) => i.id)).access.length, ACCESS_ITEMS.length);
  for (const key of ["CLASS_TEACHER", "FACULTY", "ATTENDANCE_OPERATOR", "HOD"]) {
    assert.throws(() => grantableAccess(actor(key), defaultAccess()), ReceptionistError, key);
  }
});

test("never-grantable keys stay refused even for someone who holds them", () => {
  const platform = actor("PLATFORM_SUPER_ADMIN");
  for (const key of NEVER_GRANTABLE) assert.equal(mayGrant(platform, key), false, key);
  for (const [narrow, broader] of Object.entries(NARROWED_FROM)) {
    assert.ok(broader && broader.length > 0, narrow);
    for (const parent of broader!) assert.ok(NEVER_GRANTABLE.has(parent) || parent === "cohort.manage" || parent === "institution.read", `${narrow} narrows ${parent}`);
  }
});

test("a phone number is optional, and checked when given", () => {
  assert.equal(validateReceptionistPhone(""), null);
  assert.equal(validateReceptionistPhone(" +91 98765 43210 "), "+91 98765 43210");
  assert.throws(() => validateReceptionistPhone("call me"), ReceptionistError);
  assert.throws(() => validateReceptionistPhone("123"), ReceptionistError);
});
