import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { ForbiddenError } from "./types.ts";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions.ts";
import { PLATFORM_ADMIN_ROLE_KEY, FIRST_ADMIN_ROLE_KEY } from "./bootstrap.ts";
import { GRANTABLE_ADMIN_ROLES } from "../platform/administrator-roles.ts";
import { FACULTY_ROLE_KEYS } from "../faculty/directory-types.ts";

/**
 * Phase 22 — PLATFORM_SUPER_ADMIN is reachable from the bootstrap and from
 * nowhere else a tenant can get to.
 *
 * Every assertion here runs without a database. That is the point: these are
 * claims about which role keys the tenant-facing workflows will even consider,
 * and each of those workflows validates its inputs before it issues a query, so
 * the refusals are observable without one. A suite that needed
 * INTEGRATION_DB_TEST would be skipped in exactly the run most likely to catch
 * a regression — the default one.
 *
 * The generic `assignRole` path is not re-tested here; Phase 14 covers it in
 * role-escalation.integration.test.ts, including "an institution admin cannot
 * grant PLATFORM_SUPER_ADMIN" and "passing a null institution does not bypass
 * the guard".
 */

function actor(permissions: string[], institutionId: string | null, roleKey: string): SessionUser {
  return {
    userId: "psr-actor",
    email: "actor@example.test",
    name: "Actor",
    institutionId,
    campusId: null,
    roles: [
      {
        key: roleKey,
        name: roleKey,
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

/** Everything an institution administrator holds — the strongest tenant actor. */
const ADMIN_PERMISSIONS = SYSTEM_ROLES.find((role) => role.key === "INSTITUTION_ADMIN")!.permissions;

const institutionAdmin = () => actor([...ADMIN_PERMISSIONS], "inst-home", "INSTITUTION_ADMIN");
const platformActor = () => actor([...PERMISSIONS], null, PLATFORM_ADMIN_ROLE_KEY);

// ---------------------------------------------------------------------------
// The allow-lists
// ---------------------------------------------------------------------------

test("the Phase 21 administrator allow-list is exactly the three tenant admin roles", () => {
  // Pinned rather than merely checked for absence: widening this list is the
  // single edit that would let the platform tier hand a platform role
  // downward, and it should not be possible to do accidentally.
  assert.deepEqual(
    [...GRANTABLE_ADMIN_ROLES],
    ["INSTITUTION_ADMIN", "SCHOOL_ADMIN", "COLLEGE_ADMIN"],
  );
});

test("no tenant-facing allow-list contains a role carrying platform permissions", () => {
  const platformCapable = new Set(
    SYSTEM_ROLES.filter((role) =>
      role.permissions.some((permission) => permission.startsWith("platform.")),
    ).map((role) => role.key),
  );

  assert.ok(platformCapable.has(PLATFORM_ADMIN_ROLE_KEY), "the platform role must be platform-capable");

  for (const key of [...GRANTABLE_ADMIN_ROLES, ...FACULTY_ROLE_KEYS, "STUDENT"]) {
    assert.equal(
      platformCapable.has(key),
      false,
      `${key} is offered by a tenant-facing workflow and must carry no platform permission`,
    );
  }
});

test("the institution-admin role holds no platform permission", () => {
  for (const permission of ADMIN_PERMISSIONS) {
    assert.equal(
      permission.startsWith("platform."),
      false,
      `${FIRST_ADMIN_ROLE_KEY} must not hold ${permission}`,
    );
  }
});

test("the platform role is the only one carrying platform permissions", () => {
  const carriers = SYSTEM_ROLES.filter((role) =>
    role.permissions.some((permission) => permission.startsWith("platform.")),
  ).map((role) => role.key);

  assert.deepEqual(carriers, [PLATFORM_ADMIN_ROLE_KEY]);
});

test("the two bootstrap role keys are distinct and unchanged", () => {
  // Phase 22 added stage C beside stage B rather than re-pointing it. If these
  // ever collapse to one value, the tenant bootstrap would mint a platform
  // account, which is the mistake this whole phase exists to avoid.
  assert.equal(FIRST_ADMIN_ROLE_KEY, "INSTITUTION_ADMIN");
  assert.equal(PLATFORM_ADMIN_ROLE_KEY, "PLATFORM_SUPER_ADMIN");
  assert.notEqual(FIRST_ADMIN_ROLE_KEY, PLATFORM_ADMIN_ROLE_KEY);
});

// ---------------------------------------------------------------------------
// The workflows refuse it — each before reaching a database
// ---------------------------------------------------------------------------

test("the platform administrator workflow refuses to grant the platform role", async () => {
  const { createInstitutionAdministrator, AdministratorError } = await import(
    "../platform/administrators.ts"
  );

  for (const key of ["PLATFORM_SUPER_ADMIN", "platform_super_admin", " Platform_Super_Admin "]) {
    await assert.rejects(
      () =>
        createInstitutionAdministrator(platformActor(), "inst-home", {
          name: "Would-Be Platform Admin",
          email: "wouldbe@example.test",
          roleKey: key,
        }),
      (error: Error) =>
        error instanceof AdministratorError && /cannot be granted here/i.test(error.message),
      `should refuse roleKey ${JSON.stringify(key)}`,
    );
  }
});

test("the platform administrator workflow refuses staff and student roles too", async () => {
  const { createInstitutionAdministrator, AdministratorError } = await import(
    "../platform/administrators.ts"
  );

  for (const key of [...FACULTY_ROLE_KEYS, "STUDENT"]) {
    await assert.rejects(
      () =>
        createInstitutionAdministrator(platformActor(), "inst-home", {
          name: "Wrong Tier",
          email: "wrong@example.test",
          roleKey: key,
        }),
      AdministratorError,
      `should refuse roleKey ${key}`,
    );
  }
});

test("an institution admin cannot reach the platform administrator workflow at all", async () => {
  const { createInstitutionAdministrator } = await import("../platform/administrators.ts");

  // Refused on the permission, before the role key is even looked at — so
  // there is no combination of arguments that gets an admin any further.
  await assert.rejects(
    () =>
      createInstitutionAdministrator(institutionAdmin(), "inst-home", {
        name: "Second Admin",
        email: "second@example.test",
        roleKey: "INSTITUTION_ADMIN",
      }),
    ForbiddenError,
  );
});

test("faculty provisioning refuses the platform role", async () => {
  const { validateFacultyRole } = await import("../faculty/directory-policy.ts");

  for (const key of ["PLATFORM_SUPER_ADMIN", "INSTITUTION_ADMIN", "SCHOOL_ADMIN", "STUDENT"]) {
    assert.throws(
      () => validateFacultyRole(key),
      /is not a role that can be granted here/i,
      `faculty provisioning should refuse ${key}`,
    );
  }
  // And still accepts the three it is for.
  for (const key of FACULTY_ROLE_KEYS) {
    assert.equal(validateFacultyRole(key), key);
  }
});

test("student login provisioning refuses a platform actor — it is a tenant action", async () => {
  const { provisionStudentLogin } = await import("../students/login-provisioning.ts");

  await assert.rejects(
    () => provisionStudentLogin(platformActor(), "any-student", { email: "s@example.test" }),
    /not scoped to a single institution/,
  );
});

test("student login provisioning grants no role the caller could choose", async () => {
  // The role is not an input at all: there is no parameter through which
  // STUDENT could become something else. Asserted on the signature so that
  // adding one is a deliberate, visible change.
  const { provisionStudentLogin } = await import("../students/login-provisioning.ts");
  assert.equal(provisionStudentLogin.length, 3, "actor, studentId, { email } — no role parameter");

  const student = SYSTEM_ROLES.find((role) => role.key === "STUDENT")!;
  for (const permission of student.permissions) {
    assert.equal(permission.startsWith("platform."), false, `STUDENT must not hold ${permission}`);
  }
});
