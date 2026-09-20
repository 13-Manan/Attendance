import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { assignRole } from "./role-management.ts";
import { ForbiddenError } from "./types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 14 — an administrator may only administer their own tenant's users.
 *
 * Phase 13 closed "you cannot grant authority you do not hold" by checking the
 * *role* being granted. It did not check the *person* being granted it, and
 * nothing else did either:
 *
 *   assignRole(actor, input)
 *     requirePermission(actor, "role.assign")        // actor is an admin: yes
 *     if (input.institutionId)                       // pass null: skipped
 *       requireSameInstitution(...)
 *     assertMayGrantRole(actor, input)               // inspects input.roleId only
 *     -> userRoleAssignment.create({ userId: input.targetUserId, ... })
 *
 * `input.targetUserId` reached the write unexamined. So Greenwood's admin
 * could hand a role to somebody at Northfield.
 *
 * The damage lands in the victim's tenant, not the attacker's, which is why
 * `requireSameInstitution` never fired: `toSessionUser` copies every
 * assignment's permissions onto the session, while tenancy is decided by
 * `User.institutionId`. A Northfield student granted INSTITUTION_ADMIN becomes
 * an administrator *of Northfield* — installed by a stranger, invisible to
 * Northfield's own administrators except as an audit row they did not write.
 *
 * These tests attack the boundary from both directions: a foreign target must
 * be refused, and a legitimate same-tenant grant must still work.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const HOME = "xt-home";
const FOREIGN = "xt-foreign";

let roleIds: Record<string, string> = {};

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { institutionId: { in: [HOME, FOREIGN] } } });
  await prisma.userRoleAssignment.deleteMany({
    where: { userId: { in: ["xt-home-user", "xt-foreign-user", "xt-orphan-user"] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: ["xt-home-user", "xt-foreign-user", "xt-orphan-user"] } },
  });
  await prisma.institution.deleteMany({ where: { id: { in: [HOME, FOREIGN] } } });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: HOME, name: "Home Tenant", type: "SCHOOL" },
      { id: FOREIGN, name: "Foreign Tenant", type: "COLLEGE" },
    ],
  });
  await prisma.user.createMany({
    data: [
      {
        id: "xt-home-user",
        institutionId: HOME,
        email: "xt-home@test.local",
        name: "Home User",
        passwordHash: "x",
        status: "ACTIVE",
      },
      {
        id: "xt-foreign-user",
        institutionId: FOREIGN,
        email: "xt-foreign@test.local",
        name: "Foreign User",
        passwordHash: "x",
        status: "ACTIVE",
      },
    ],
  });

  // The deployment's real seeded roles, not fixtures.
  const rows = await prisma.role.findMany({
    where: { key: { in: ["INSTITUTION_ADMIN", "FACULTY", "STUDENT", "PLATFORM_SUPER_ADMIN"] } },
    select: { id: true, key: true },
  });
  roleIds = Object.fromEntries(rows.map((row) => [row.key, row.id]));
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

/** An institution admin of HOME, holding exactly the seeded admin permissions. */
function homeAdmin(): SessionUser {
  return {
    userId: "xt-admin",
    email: "admin@home.test",
    name: "Home Admin",
    institutionId: HOME,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: HOME,
        campusId: null,
        permissions: [
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
        ] as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

async function assignmentsFor(userId: string) {
  return prisma.userRoleAssignment.findMany({ where: { userId } });
}

// ---------------------------------------------------------------------------
// The attack
// ---------------------------------------------------------------------------

test("an admin cannot grant a role to a user in another institution", { skip: SKIP }, async () => {
  // `institutionId: null` is the shape that slipped past every guard: it skips
  // `requireSameInstitution`, and every system role legitimately carries a
  // null institution so the role itself looks unremarkable.
  await assert.rejects(
    () =>
      assignRole(homeAdmin(), {
        targetUserId: "xt-foreign-user",
        roleId: roleIds.FACULTY,
        institutionId: null,
      }),
    ForbiddenError,
  );

  assert.deepEqual(
    await assignmentsFor("xt-foreign-user"),
    [],
    "the foreign user must not have gained anything",
  );
});

test("naming the victim's institution outright is refused too", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      assignRole(homeAdmin(), {
        targetUserId: "xt-foreign-user",
        roleId: roleIds.FACULTY,
        institutionId: FOREIGN,
      }),
    ForbiddenError,
  );
  assert.deepEqual(await assignmentsFor("xt-foreign-user"), []);
});

test("nor can an admin install an administrator in another tenant", { skip: SKIP }, async () => {
  // The worst version: INSTITUTION_ADMIN is a permission set the attacker
  // fully holds, so Phase 13's subset rule passes it without complaint.
  await assert.rejects(
    () =>
      assignRole(homeAdmin(), {
        targetUserId: "xt-foreign-user",
        roleId: roleIds.INSTITUTION_ADMIN,
        institutionId: null,
      }),
    ForbiddenError,
  );
  assert.deepEqual(await assignmentsFor("xt-foreign-user"), []);
});

test("a refused cross-tenant grant writes no audit row", { skip: SKIP }, async () => {
  // A refusal that still logged would let an attacker write into the victim
  // tenant's audit trail.
  const before = await prisma.auditLog.count({ where: { institutionId: FOREIGN } });
  await assignRole(homeAdmin(), {
    targetUserId: "xt-foreign-user",
    roleId: roleIds.FACULTY,
    institutionId: null,
  }).catch(() => undefined);
  assert.equal(await prisma.auditLog.count({ where: { institutionId: FOREIGN } }), before);
});

test("a target who exists nowhere is refused rather than created", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      assignRole(homeAdmin(), {
        targetUserId: "xt-no-such-user",
        roleId: roleIds.FACULTY,
        institutionId: null,
      }),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// The legitimate path must survive the fix
// ---------------------------------------------------------------------------

test("an admin can still grant faculty inside their own institution", { skip: SKIP }, async () => {
  const assignment = await assignRole(homeAdmin(), {
    targetUserId: "xt-home-user",
    roleId: roleIds.FACULTY,
    institutionId: HOME,
  });
  assert.equal(assignment.userId, "xt-home-user");

  await prisma.userRoleAssignment.delete({ where: { id: assignment.id } });
});

test("a null-scoped grant to one's own user is still allowed", { skip: SKIP }, async () => {
  // Null institution on the *assignment* is a legitimate shape — it is how
  // every seeded system role is attached. The fix must key on the target
  // user's tenant, not on this field, or it would break normal assignment.
  const assignment = await assignRole(homeAdmin(), {
    targetUserId: "xt-home-user",
    roleId: roleIds.STUDENT,
    institutionId: null,
  });
  assert.equal(assignment.userId, "xt-home-user");

  await prisma.userRoleAssignment.delete({ where: { id: assignment.id } });
});

test("the Phase 13 guard is still in force", { skip: SKIP }, async () => {
  // Regression on the previous phase: unheld permissions remain ungrantable
  // even to one's own user.
  await assert.rejects(
    () =>
      assignRole(homeAdmin(), {
        targetUserId: "xt-home-user",
        roleId: roleIds.PLATFORM_SUPER_ADMIN,
        institutionId: null,
      }),
    ForbiddenError,
  );
  assert.deepEqual(await assignmentsFor("xt-home-user"), []);
});
