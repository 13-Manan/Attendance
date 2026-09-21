import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 21 — the hierarchy, and the two directions it must not run.
 *
 * The platform tier can now put an administrator inside a tenant. That is a
 * genuinely privileged act: it is the only path by which somebody who is not
 * in an institution grants somebody else authority over one. So the tests that
 * matter are the refusals — an institution admin reaching this workflow, any
 * caller reaching PLATFORM_SUPER_ADMIN through it, and an administrator
 * created here turning out to be a platform user by accident.
 *
 * Database-backed because the guard reads the role catalogue and the target
 * institution out of Postgres. A stubbed repository would be asserting against
 * the fixture's idea of what SCHOOL_ADMIN means rather than the deployment's.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const SCHOOL = "adm-school";
const COLLEGE = "adm-college";

type Module = typeof import("./administrators.ts");
let mod: Module;

async function cleanup() {
  const ids = [SCHOOL, COLLEGE];
  await prisma.auditLog.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.session.deleteMany({ where: { user: { institutionId: { in: ids } } } });
  await prisma.userRoleAssignment.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.user.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.institution.deleteMany({ where: { id: { in: ids } } });
}

before(async () => {
  if (SKIP) return;
  mod = await import("./administrators.ts");
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: SCHOOL, name: "Admin Test School", type: "SCHOOL" },
      { id: COLLEGE, name: "Admin Test College", type: "COLLEGE" },
    ],
  });
});

beforeEach(async () => {
  if (SKIP) return;
  await prisma.auditLog.deleteMany({ where: { institutionId: { in: [SCHOOL, COLLEGE] } } });
  await prisma.userRoleAssignment.deleteMany({ where: { institutionId: { in: [SCHOOL, COLLEGE] } } });
  await prisma.user.deleteMany({ where: { institutionId: { in: [SCHOOL, COLLEGE] } } });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

function actor(permissions: string[], institutionId: string | null, key = "ROLE"): SessionUser {
  return {
    userId: "adm-actor",
    email: "actor@example.com",
    name: "Actor",
    institutionId,
    campusId: null,
    roles: [
      {
        key,
        name: key,
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

/** A platform user: no institution, holds the platform permissions. */
const platform = () =>
  actor(
    ["platform.institution.create", "platform.institution.suspend", "user.invite"],
    null,
    "PLATFORM_SUPER_ADMIN",
  );

/** Everything an institution admin holds — every permission except platform.*. */
const INSTITUTION_ADMIN_PERMISSIONS = [
  "institution.read",
  "institution.update",
  "campus.manage",
  "academicStructure.manage",
  "cohort.manage",
  "cohort.read",
  "user.invite",
  "user.update",
  "user.deactivate",
  "role.assign",
  "role.read",
  "student.create",
  "student.update",
  "student.read",
  "enrollment.manage",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
  "faceEmbedding.manage",
  "auditLog.read",
];

// ---------------------------------------------------------------------------
// The platform tier may
// ---------------------------------------------------------------------------

test("a platform user creates an administrator bound to the institution", { skip: SKIP }, async () => {
  const result = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "Priya Admin",
    email: "priya.admin@school.test",
    roleKey: "SCHOOL_ADMIN",
  });

  assert.equal(result.administrator.status, "ACTIVE");
  assert.deepEqual(result.administrator.roleKeys, ["SCHOOL_ADMIN"]);
  // The whole point: bound to this tenant, never institution-less.
  assert.equal(result.administrator.institutionId, SCHOOL);

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: result.administrator.id },
    select: { institutionId: true, status: true, roleAssignments: { select: { institutionId: true } } },
  });
  assert.equal(row.institutionId, SCHOOL, "the user must belong to the institution");
  assert.equal(row.roleAssignments[0].institutionId, SCHOOL, "and so must the assignment");
});

test("the temporary password is returned once and never stored readable", { skip: SKIP }, async () => {
  const result = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "Pass Test",
    email: "pass.test@school.test",
    roleKey: "SCHOOL_ADMIN",
  });

  assert.ok(result.password.length >= 16);
  assert.ok(result.notice.length > 0);

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: result.administrator.id },
    select: { passwordHash: true },
  });
  assert.notEqual(row.passwordHash, result.password, "the plaintext must not be the stored value");
  assert.ok(!row.passwordHash?.includes(result.password), "nor contained in it");

  // And it must not be in the audit trail.
  const audits = await prisma.auditLog.findMany({ where: { institutionId: SCHOOL } });
  const serialized = JSON.stringify(audits);
  assert.equal(serialized.includes(result.password), false, "the password reached the audit log");
});

test("creating an administrator is audited with who and what access", { skip: SKIP }, async () => {
  await mod.createInstitutionAdministrator(platform(), COLLEGE, {
    name: "Audit Admin",
    email: "audit.admin@college.test",
    roleKey: "COLLEGE_ADMIN",
  });

  const audit = await prisma.auditLog.findFirst({
    where: { institutionId: COLLEGE, action: "user.created" },
  });
  assert.ok(audit, "an audit row must exist");
  assert.equal(audit.actorUserId, "adm-actor");
  assert.match(JSON.stringify(audit.afterJson), /COLLEGE_ADMIN/);
});

test("administrators are listed for their own institution only", { skip: SKIP }, async () => {
  await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "School Admin",
    email: "s.admin@school.test",
    roleKey: "SCHOOL_ADMIN",
  });
  await mod.createInstitutionAdministrator(platform(), COLLEGE, {
    name: "College Admin",
    email: "c.admin@college.test",
    roleKey: "COLLEGE_ADMIN",
  });

  const schoolAdmins = await mod.listInstitutionAdministrators(platform(), SCHOOL);
  assert.equal(schoolAdmins.length, 1);
  assert.equal(schoolAdmins[0].email, "s.admin@school.test");
});

// ---------------------------------------------------------------------------
// The escalation that must never work
// ---------------------------------------------------------------------------

test("PLATFORM_SUPER_ADMIN cannot be granted through this workflow", { skip: SKIP }, async () => {
  // The single most important refusal here. An allow-list, so this holds even
  // if a new platform-capable role is added to the catalogue tomorrow.
  await assert.rejects(
    () =>
      mod.createInstitutionAdministrator(platform(), SCHOOL, {
        name: "Escalation",
        email: "escalate@school.test",
        roleKey: "PLATFORM_SUPER_ADMIN",
      }),
    /cannot be granted here/,
  );
  assert.equal(await prisma.user.count({ where: { institutionId: SCHOOL } }), 0);
});

test("no staff or student role can be granted here either", { skip: SKIP }, async () => {
  for (const roleKey of ["FACULTY", "CLASS_TEACHER", "ATTENDANCE_OPERATOR", "STUDENT"]) {
    await assert.rejects(
      () =>
        mod.createInstitutionAdministrator(platform(), SCHOOL, {
          name: "Wrong Role",
          email: `wrong.${roleKey.toLowerCase()}@school.test`,
          roleKey,
        }),
      /cannot be granted here/,
      `${roleKey} should not be grantable from the platform administrator workflow`,
    );
  }
});

test("an institution admin cannot reach this workflow at all", { skip: SKIP }, async () => {
  // They hold every permission except platform.* — which is exactly the shape
  // that would slip through a check written against the wrong permission.
  const insider = actor(INSTITUTION_ADMIN_PERMISSIONS, SCHOOL, "INSTITUTION_ADMIN");

  await assert.rejects(
    () =>
      mod.createInstitutionAdministrator(insider, SCHOOL, {
        name: "Self Promoted",
        email: "self@school.test",
        roleKey: "SCHOOL_ADMIN",
      }),
    ForbiddenError,
  );
  await assert.rejects(() => mod.listInstitutionAdministrators(insider, SCHOOL), ForbiddenError);
  assert.equal(await prisma.user.count({ where: { institutionId: SCHOOL } }), 0);
});

test("a faculty member and a student are refused too", { skip: SKIP }, async () => {
  for (const [label, perms] of [
    ["faculty", ["cohort.read", "student.read", "attendanceRecord.read"]],
    ["student", ["student.read.own", "attendanceRecord.read.own"]],
    ["no permissions", []],
  ] as const) {
    await assert.rejects(
      () =>
        mod.createInstitutionAdministrator(actor([...perms], SCHOOL), SCHOOL, {
          name: "Nope",
          email: "nope@school.test",
          roleKey: "SCHOOL_ADMIN",
        }),
      ForbiddenError,
      `${label} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test("a created administrator holds no permission over another institution", { skip: SKIP }, async () => {
  const created = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "Scoped Admin",
    email: "scoped@school.test",
    roleKey: "SCHOOL_ADMIN",
  });

  const assignments = await prisma.userRoleAssignment.findMany({
    where: { userId: created.administrator.id },
    select: { institutionId: true, role: { select: { key: true, permissions: true } } },
  });

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].institutionId, SCHOOL, "scoped to one institution");

  const granted = assignments[0].role.permissions.map((p) => p.permission);
  const platformPermissions = granted.filter((p) => p.startsWith("platform."));
  assert.deepEqual(platformPermissions, [], "an institution admin must hold no platform permission");
});

test("password reset refuses a user from another institution", { skip: SKIP }, async () => {
  const schoolAdmin = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "S", email: "reset.s@school.test", roleKey: "SCHOOL_ADMIN",
  });

  // Correct user, wrong institution in the path.
  await assert.rejects(
    () => mod.resetAdministratorPassword(platform(), COLLEGE, schoolAdmin.administrator.id),
    /not an administrator of this institution/,
  );
});

test("status changes refuse a user from another institution", { skip: SKIP }, async () => {
  const schoolAdmin = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "S2", email: "status.s@school.test", roleKey: "SCHOOL_ADMIN",
  });

  await assert.rejects(
    () => mod.setAdministratorStatus(platform(), COLLEGE, schoolAdmin.administrator.id, false),
    /not an administrator of this institution/,
  );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("a password reset ends the sessions the old one opened", { skip: SKIP }, async () => {
  const created = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "Session Admin", email: "session@school.test", roleKey: "SCHOOL_ADMIN",
  });

  await prisma.session.create({
    data: {
      userId: created.administrator.id,
      tokenHash: `adm-test-${Date.now()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  assert.equal(await prisma.session.count({ where: { userId: created.administrator.id } }), 1);

  const reissued = await mod.resetAdministratorPassword(platform(), SCHOOL, created.administrator.id);
  assert.notEqual(reissued.password, created.password, "a new password, not the old one");
  assert.equal(
    await prisma.session.count({ where: { userId: created.administrator.id } }),
    0,
    "the old sessions must not survive the reset",
  );
});

test("deactivating keeps the account and ends its sessions", { skip: SKIP }, async () => {
  const created = await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "Deact Admin", email: "deact@school.test", roleKey: "SCHOOL_ADMIN",
  });
  await prisma.session.create({
    data: {
      userId: created.administrator.id,
      tokenHash: `adm-deact-${Date.now()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const off = await mod.setAdministratorStatus(platform(), SCHOOL, created.administrator.id, false);
  assert.equal(off.status, "INACTIVE");
  assert.equal(await prisma.session.count({ where: { userId: created.administrator.id } }), 0);
  // Not a delete — the account authored audit rows and must keep naming somebody.
  assert.ok(await prisma.user.findUnique({ where: { id: created.administrator.id } }));

  const on = await mod.setAdministratorStatus(platform(), SCHOOL, created.administrator.id, true);
  assert.equal(on.status, "ACTIVE");
});

test("an address cannot be reused across institutions", { skip: SKIP }, async () => {
  await mod.createInstitutionAdministrator(platform(), SCHOOL, {
    name: "First", email: "shared@example.test", roleKey: "SCHOOL_ADMIN",
  });
  await assert.rejects(
    () =>
      mod.createInstitutionAdministrator(platform(), COLLEGE, {
        name: "Second",
        email: "shared@example.test",
        roleKey: "COLLEGE_ADMIN",
      }),
    /already uses/,
  );
});

test("an unknown institution is refused without creating anything", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      mod.createInstitutionAdministrator(platform(), "no-such-institution", {
        name: "Ghost", email: "ghost@example.test", roleKey: "SCHOOL_ADMIN",
      }),
    /no longer exists/,
  );
  assert.equal(await prisma.user.count({ where: { email: "ghost@example.test" } }), 0);
});

test("the default role follows the institution type", { skip: SKIP }, () => {
  assert.equal(mod.defaultAdminRoleFor("SCHOOL"), "SCHOOL_ADMIN");
  assert.equal(mod.defaultAdminRoleFor("COLLEGE"), "COLLEGE_ADMIN");
});

test("the grantable set never contains a platform role", { skip: SKIP }, () => {
  // Guards the allow-list itself against a careless edit.
  for (const key of mod.GRANTABLE_ADMIN_ROLES) {
    assert.ok(!key.startsWith("PLATFORM"), `${key} must not be grantable here`);
  }
});
