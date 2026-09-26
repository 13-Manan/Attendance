import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 21 — a student login reaches the student's own record and nothing else.
 *
 * The risk being tested is not "can a student sign in" — it is what the new
 * account turns out to hold. A login provisioned here gets a role assignment
 * like any other, and the failure mode worth guarding is the one where it
 * quietly carries more than STUDENT, or is attached to a student in a
 * different institution than the administrator who made it.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const HOME = "slp-home";
const OTHER = "slp-other";

type Module = typeof import("./login-provisioning.ts");
let mod: Module;

async function cleanup() {
  const ids = [HOME, OTHER];
  await prisma.auditLog.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.session.deleteMany({ where: { user: { institutionId: { in: ids } } } });
  await prisma.student.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.userRoleAssignment.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.user.deleteMany({ where: { institutionId: { in: ids } } });
  await prisma.institution.deleteMany({ where: { id: { in: ids } } });
}

async function seedStudents() {
  await prisma.student.createMany({
    data: [
      { id: "slp-stu-1", institutionId: HOME, studentCode: "H-1", firstName: "Home", lastName: "One", status: "ACTIVE" },
      { id: "slp-stu-2", institutionId: HOME, studentCode: "H-2", firstName: "Home", lastName: "Two", status: "ACTIVE" },
      { id: "slp-stu-x", institutionId: OTHER, studentCode: "O-1", firstName: "Other", lastName: "Tenant", status: "ACTIVE" },
    ],
  });
}

before(async () => {
  if (SKIP) return;
  mod = await import("./login-provisioning.ts");
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: HOME, name: "Login Home", type: "SCHOOL" },
      { id: OTHER, name: "Login Other", type: "COLLEGE" },
    ],
  });
  await seedStudents();
});

beforeEach(async () => {
  if (SKIP) return;
  await prisma.auditLog.deleteMany({ where: { institutionId: { in: [HOME, OTHER] } } });
  await prisma.student.updateMany({ where: { institutionId: { in: [HOME, OTHER] } }, data: { userId: null } });
  await prisma.userRoleAssignment.deleteMany({ where: { institutionId: { in: [HOME, OTHER] } } });
  await prisma.user.deleteMany({ where: { institutionId: { in: [HOME, OTHER] } } });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

function actor(permissions: string[], institutionId: string | null): SessionUser {
  return {
    userId: "slp-actor",
    email: "admin@home.test",
    name: "Admin",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const admin = () => actor(["user.invite", "student.read", "student.create"], HOME);

// ---------------------------------------------------------------------------
// The permitted path
// ---------------------------------------------------------------------------

test("an institution admin provisions a login for their own student", { skip: SKIP }, async () => {
  const result = await mod.provisionStudentLogin(admin(), "slp-stu-1", {
    email: "home.one@student.test",
  });

  assert.equal(result.account.email, "home.one@student.test");
  assert.equal(result.account.status, "ACTIVE");
  assert.ok(result.password.length >= 16);

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: "slp-stu-1" },
    select: { userId: true },
  });
  assert.equal(student.userId, result.account.userId, "the student must be linked to the account");
});

test("the account holds exactly the STUDENT role and no staff permission", { skip: SKIP }, async () => {
  const result = await mod.provisionStudentLogin(admin(), "slp-stu-1", {
    email: "role.check@student.test",
  });

  const assignments = await prisma.userRoleAssignment.findMany({
    where: { userId: result.account.userId },
    select: { institutionId: true, role: { select: { key: true, permissions: true } } },
  });

  assert.equal(assignments.length, 1, "exactly one role");
  assert.equal(assignments[0].role.key, "STUDENT");
  assert.equal(assignments[0].institutionId, HOME, "scoped to the student's institution");

  const granted = assignments[0].role.permissions.map((p) => p.permission).sort();
  // Every staff and platform capability must be absent. Listed explicitly
  // rather than counted, so adding a permission to STUDENT fails this test.
  for (const forbidden of [
    "platform.institution.create",
    "platform.institution.suspend",
    "user.invite",
    "role.assign",
    "student.create",
    "student.update",
    "student.read",
    "attendanceRecord.read",
    "attendanceRecord.correct",
    "attendanceSession.finalize",
    "faceEmbedding.manage",
    "auditLog.read",
  ]) {
    assert.equal(granted.includes(forbidden), false, `STUDENT must not hold ${forbidden}`);
  }
  // And the self-scoped ones it must hold.
  assert.ok(granted.includes("student.read.own"));
  assert.ok(granted.includes("attendanceRecord.read.own"));
});

test("the user belongs to the same institution as the student", { skip: SKIP }, async () => {
  const result = await mod.provisionStudentLogin(admin(), "slp-stu-1", {
    email: "same.inst@student.test",
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: result.account.userId },
    select: { institutionId: true },
  });
  assert.equal(user.institutionId, HOME);
});

test("the password is not stored readable and is not audited", { skip: SKIP }, async () => {
  const result = await mod.provisionStudentLogin(admin(), "slp-stu-1", {
    email: "secret@student.test",
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: result.account.userId },
    select: { passwordHash: true },
  });
  assert.notEqual(user.passwordHash, result.password);

  const audits = await prisma.auditLog.findMany({ where: { institutionId: HOME } });
  assert.equal(JSON.stringify(audits).includes(result.password), false);
  assert.ok(audits.some((a) => a.action === "user.created"), "provisioning must be audited");
});

// ---------------------------------------------------------------------------
// Tenant isolation and refusals
// ---------------------------------------------------------------------------

test("an admin cannot provision a login for another institution's student", { skip: SKIP }, async () => {
  await assert.rejects(
    () => mod.provisionStudentLogin(admin(), "slp-stu-x", { email: "cross@student.test" }),
    /not in this institution/,
  );
  const student = await prisma.student.findUniqueOrThrow({
    where: { id: "slp-stu-x" },
    select: { userId: true },
  });
  assert.equal(student.userId, null, "the foreign student must be untouched");
});

test("a platform user cannot provision here — this is a tenant action", { skip: SKIP }, async () => {
  const platform = actor(["platform.institution.create", "user.invite"], null);
  await assert.rejects(
    () => mod.provisionStudentLogin(platform, "slp-stu-1", { email: "plat@student.test" }),
    /not scoped to a single institution/,
  );
});

test("a caller without user.invite is refused", { skip: SKIP }, async () => {
  const faculty = actor(["student.read", "attendanceRecord.read"], HOME);
  await assert.rejects(
    () => mod.provisionStudentLogin(faculty, "slp-stu-1", { email: "faculty@student.test" }),
    ForbiddenError,
  );
});

test("a student cannot provision a login at all", { skip: SKIP }, async () => {
  const student = actor(["student.read.own", "attendanceRecord.read.own"], HOME);
  await assert.rejects(
    () => mod.provisionStudentLogin(student, "slp-stu-2", { email: "self@student.test" }),
    ForbiddenError,
  );
});

test("a second login for the same student is refused", { skip: SKIP }, async () => {
  await mod.provisionStudentLogin(admin(), "slp-stu-1", { email: "first@student.test" });
  await assert.rejects(
    () => mod.provisionStudentLogin(admin(), "slp-stu-1", { email: "second@student.test" }),
    /already has a login/,
  );
  assert.equal(await prisma.user.count({ where: { email: "second@student.test" } }), 0);
});

test("an address already in use anywhere is refused", { skip: SKIP }, async () => {
  await mod.provisionStudentLogin(admin(), "slp-stu-1", { email: "taken@student.test" });
  await assert.rejects(
    () => mod.provisionStudentLogin(admin(), "slp-stu-2", { email: "taken@student.test" }),
    /already uses/,
  );
});

test("a malformed address is refused before anything is written", { skip: SKIP }, async () => {
  await assert.rejects(
    () => mod.provisionStudentLogin(admin(), "slp-stu-1", { email: "not-an-address" }),
    /does not look like an email/,
  );
  assert.equal(await prisma.user.count({ where: { institutionId: HOME } }), 0);
});

// ---------------------------------------------------------------------------
// Reset and read
// ---------------------------------------------------------------------------

test("a reset issues a new password and ends existing sessions", { skip: SKIP }, async () => {
  const created = await mod.provisionStudentLogin(admin(), "slp-stu-1", {
    email: "reset@student.test",
  });
  await prisma.session.create({
    data: {
      userId: created.account.userId,
      tokenHash: `slp-${Date.now()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const reissued = await mod.resetStudentLoginPassword(admin(), "slp-stu-1");
  assert.notEqual(reissued.password, created.password);
  assert.equal(await prisma.session.count({ where: { userId: created.account.userId } }), 0);
});

test("a reset refuses another institution's student", { skip: SKIP }, async () => {
  await assert.rejects(
    () => mod.resetStudentLoginPassword(admin(), "slp-stu-x"),
    /not in this institution/,
  );
});

test("a reset refuses a student with no login", { skip: SKIP }, async () => {
  await assert.rejects(
    () => mod.resetStudentLoginPassword(admin(), "slp-stu-2"),
    /does not have a login/,
  );
});

test("reading a login is tenant-scoped and never returns a secret", { skip: SKIP }, async () => {
  await mod.provisionStudentLogin(admin(), "slp-stu-1", { email: "read@student.test" });

  const own = await mod.getStudentLogin(admin(), "slp-stu-1");
  assert.equal(own?.email, "read@student.test");
  // An allowlist, so a new field is a decision rather than an accident: what
  // the panel shows about a login, and never a password, hash or token.
  assert.equal(
    Object.keys(own!).sort().join(","),
    "email,institutionId,lastLoginAt,loginId,status,studentOnRoll,userId",
  );
  assert.ok(!/password|hash|token/i.test(JSON.stringify(own)), "a secret-shaped field was returned");

  const foreign = await mod.getStudentLogin(admin(), "slp-stu-x");
  assert.equal(foreign, null, "another institution's student must read as null");
});
