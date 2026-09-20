import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { assignRole } from "./role-management.ts";
import { ForbiddenError } from "./types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 13 — an administrator cannot grant authority they do not hold.
 *
 * Database-backed because the guard reads the target role's permissions out
 * of `RolePermission`. A stubbed repository would be asserting against the
 * fixture's idea of what FACULTY means rather than the deployment's.
 *
 * ## The vulnerability this pins shut
 *
 * `assignRole` checked `role.assign` and `requireSameInstitution`. The second
 * is skipped when `institutionId` is null — and every system role in this
 * deployment *has* a null institution. So an institution admin could pass
 * `institutionId: null` with the PLATFORM_SUPER_ADMIN role id and mint a
 * platform administrator over every other tenant on the platform.
 *
 * It was not theoretical: Greenwood's institution admin did exactly that
 * against the development database before the guard existed.
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INSTITUTION = "esc-inst";
const OTHER_INSTITUTION = "esc-inst-other";

let roleIds: Record<string, string> = {};
let targetUserId = "";

async function cleanup() {
  for (const inst of [INSTITUTION, OTHER_INSTITUTION]) {
    await prisma.userRoleAssignment.deleteMany({ where: { institutionId: inst } });
    await prisma.user.deleteMany({ where: { institutionId: inst } });
    await prisma.role.deleteMany({ where: { institutionId: inst } });
    await prisma.institution.deleteMany({ where: { id: inst } });
  }
  await prisma.userRoleAssignment.deleteMany({ where: { userId: "esc-target" } });
  await prisma.user.deleteMany({ where: { id: "esc-target" } });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: INSTITUTION, name: "Escalation Test", type: "SCHOOL" },
      { id: OTHER_INSTITUTION, name: "Other Tenant", type: "SCHOOL" },
    ],
  });
  await prisma.user.create({
    data: {
      id: "esc-target",
      institutionId: INSTITUTION,
      email: "esc-target@test.local",
      name: "Target",
      passwordHash: "x",
      status: "ACTIVE",
    },
  });
  targetUserId = "esc-target";

  // The real seeded system roles, not fixtures — the whole point is to test
  // against what this deployment actually grants.
  const rows = await prisma.role.findMany({
    where: { key: { in: ["PLATFORM_SUPER_ADMIN", "INSTITUTION_ADMIN", "FACULTY", "STUDENT"] } },
    select: { id: true, key: true },
  });
  roleIds = Object.fromEntries(rows.map((row) => [row.key, row.id]));

  // A role belonging to a different tenant, to test the cross-institution arm.
  await prisma.role.create({
    data: {
      id: "esc-foreign-role",
      key: "FOREIGN_ROLE",
      name: "Foreign",
      institutionId: OTHER_INSTITUTION,
      isSystem: false,
    },
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

function actor(permissions: string[], institutionId: string | null = INSTITUTION): SessionUser {
  return {
    userId: "esc-actor",
    email: "esc-actor@test.local",
    name: "Actor",
    institutionId,
    campusId: null,
    roles: [
      {
        key: institutionId === null ? "PLATFORM_SUPER_ADMIN" : "INSTITUTION_ADMIN",
        name: "Actor role",
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

/** What an institution admin actually holds, per `SYSTEM_ROLES`. */
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
// The escalation
// ---------------------------------------------------------------------------

test("an institution admin cannot grant PLATFORM_SUPER_ADMIN", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
        targetUserId,
        roleId: roleIds.PLATFORM_SUPER_ADMIN,
        institutionId: INSTITUTION,
      }),
    (error: unknown) =>
      error instanceof ForbiddenError && error.reason === "platform_role_not_grantable",
  );
});

test("passing a null institution does not bypass the guard", { skip: SKIP }, async () => {
  // The exact shape of the original vulnerability: `requireSameInstitution`
  // returns early on null, so before the guard this call succeeded.
  await assert.rejects(
    () =>
      assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
        targetUserId,
        roleId: roleIds.PLATFORM_SUPER_ADMIN,
        institutionId: null,
      }),
    (error: unknown) =>
      error instanceof ForbiddenError && error.reason === "platform_role_not_grantable",
  );
});

test("nothing is written when a grant is refused", { skip: SKIP }, async () => {
  const before = await prisma.userRoleAssignment.count({ where: { userId: targetUserId } });
  await assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
    targetUserId,
    roleId: roleIds.PLATFORM_SUPER_ADMIN,
    institutionId: null,
  }).catch(() => undefined);
  const after = await prisma.userRoleAssignment.count({ where: { userId: targetUserId } });
  assert.equal(after, before, "a refused grant must leave no assignment behind");
});

test("a platform user may grant PLATFORM_SUPER_ADMIN", { skip: SKIP }, async () => {
  // The capability still exists for whoever legitimately holds it — the guard
  // narrows who may use it, it does not remove it.
  const platform = actor(
    [...INSTITUTION_ADMIN_PERMISSIONS, "platform.institution.create", "platform.institution.suspend"],
    null,
  );
  const assignment = await assignRole(platform, {
    targetUserId,
    roleId: roleIds.PLATFORM_SUPER_ADMIN,
    institutionId: null,
  });
  assert.ok(assignment.id);
  await prisma.userRoleAssignment.delete({ where: { id: assignment.id } });
});

// ---------------------------------------------------------------------------
// The general rule, and the exception
// ---------------------------------------------------------------------------

test("an actor cannot grant a permission they do not hold", { skip: SKIP }, async () => {
  // A user administrator who cannot finalize attendance must not be able to
  // hand somebody else the ability.
  const weak = actor(["role.assign", "user.update", "student.read"]);
  await assert.rejects(
    () => assignRole(weak, { targetUserId, roleId: roleIds.FACULTY, institutionId: INSTITUTION }),
    (error: unknown) =>
      error instanceof ForbiddenError &&
      error.reason.startsWith("cannot_grant_unheld_permissions:"),
  );
});

test("self-scoped permissions are always grantable", { skip: SKIP }, async () => {
  // No administrator holds `student.read.own` — they are not a student.
  // Requiring it would make creating a student account impossible, and
  // `.own` permissions confer nothing over anybody else.
  const assignment = await assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
    targetUserId,
    roleId: roleIds.STUDENT,
    institutionId: INSTITUTION,
  });
  assert.ok(assignment.id);
  await prisma.userRoleAssignment.delete({ where: { id: assignment.id } });
});

test("a peer-level grant is allowed", { skip: SKIP }, async () => {
  // An admin appointing a co-admin is not escalation: the permission sets are
  // identical, so nothing new enters the system.
  const assignment = await assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
    targetUserId,
    roleId: roleIds.INSTITUTION_ADMIN,
    institutionId: INSTITUTION,
  });
  assert.ok(assignment.id);
  await prisma.userRoleAssignment.delete({ where: { id: assignment.id } });
});

test("a role belonging to another institution is not grantable", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
        targetUserId,
        roleId: "esc-foreign-role",
        institutionId: INSTITUTION,
      }),
    (error: unknown) => error instanceof ForbiddenError && error.reason === "cross_institution",
  );
});

test("an unknown role id is refused without revealing that it is unknown", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
        targetUserId,
        roleId: "does-not-exist",
        institutionId: INSTITUTION,
      }),
    (error: unknown) => error instanceof ForbiddenError && error.reason === "role_not_grantable",
  );
});

test("role.assign is still required before any of this runs", { skip: SKIP }, async () => {
  const noAssign = actor(["student.read", "attendanceRecord.read"]);
  await assert.rejects(
    () => assignRole(noAssign, { targetUserId, roleId: roleIds.FACULTY, institutionId: INSTITUTION }),
    (error: unknown) => error instanceof ForbiddenError && error.reason === "role.assign",
  );
});

test("a successful grant is audited with before and after role keys", { skip: SKIP }, async () => {
  const assignment = await assignRole(actor(INSTITUTION_ADMIN_PERMISSIONS), {
    targetUserId,
    roleId: roleIds.FACULTY,
    institutionId: INSTITUTION,
  });

  const audit = await prisma.auditLog.findFirst({
    where: { action: "user.role_changed", entityId: targetUserId },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(audit, "a role change must leave a trail");
  assert.equal(audit.actorUserId, "esc-actor");
  assert.equal(audit.institutionId, INSTITUTION);
  const after = audit.afterJson as { roleKeys: string[] };
  assert.ok(after.roleKeys.includes("FACULTY"));

  await prisma.userRoleAssignment.delete({ where: { id: assignment.id } });
  await prisma.auditLog.deleteMany({ where: { id: audit.id } });
});
