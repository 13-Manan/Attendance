import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/modules/auth-tenancy/password";
import { changeOwnPasswordService, getSessionUserByRawToken, loginService } from "@/modules/auth-tenancy/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import * as college from "@/modules/college-setup/service";
import { EMPTY_STUDENT_FILTERS } from "@/modules/students/directory-filters";
import { listStudentsForRequest } from "@/modules/students/directory-service";
import { StudentError } from "@/modules/students/directory-types";
import {
  getStudentLogin,
  resetStudentLoginPassword,
  setStudentLoginEnabled,
} from "@/modules/students/login-provisioning";
import { updateStudent } from "@/modules/students/service";
import { revealStudentPassword } from "./service.ts";

/**
 * A student's current portal password, revealed to authorised staff on
 * request — and to nobody else, never from anything but the current password,
 * and never from anywhere but that one audited call.
 *
 * Every password here is set through the real flows (a head admitting a
 * student, a reset, a student changing their own after signing in), stored by
 * the real code, and read back only through `revealStudentPassword`. The
 * student-password key is a fresh random one for this run, set the way
 * production sets it — so what is exercised is key version 1, not the
 * development key.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const A = "pr-it-inst";
const B = "pr-it-other";
const INSTITUTIONS = [A, B];
const NOW = "pr-it-now";
const B_NOW = "pr-it-b-now";
const ADMIN = "pr-it-admin";
const HEAD_A = "pr-it-head-a";
const HEAD_B = "pr-it-head-b";
const TA = "pr-it-teacher-a";
const TB = "pr-it-teacher-b";
const B_ADMIN = "pr-it-b-admin";
const B_TEACHER = "pr-it-b-teacher";
const HEAD_A_PASSWORD = "head-a-own-password-1";
const KEY = randomBytes(32).toString("base64");

function actor(userId: string, roleKey: string, institutionId: string | null): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@pr-it.test`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId: null, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}
const admin = () => actor(ADMIN, "COLLEGE_ADMIN", A);
const hodA = () => actor(HEAD_A, "HOD", A);
const hodB = () => actor(HEAD_B, "HOD", A);
const bAdmin = () => actor(B_ADMIN, "COLLEGE_ADMIN", B);

const ids: Record<string, string> = {};
/** Every password this file sets, to look for wherever none may be. */
const passwords: string[] = [];

const newStudent = (studentCode: string, firstName: string, email: string) => ({
  studentCode,
  firstName,
  lastName: "Test",
  email,
  phone: "",
  campusId: "",
  admissionNumber: "",
  admissionDate: "",
});

async function cleanup() {
  const where = { institutionId: { in: INSTITUTIONS } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: where } });
  await prisma.enrollment.deleteMany({ where });
  await prisma.student.deleteMany({ where });
  await prisma.cohortSubject.deleteMany({ where: { cohort: where } });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: where } });
  await prisma.cohort.deleteMany({ where });
  await prisma.subject.deleteMany({ where });
  await prisma.user.updateMany({ where, data: { departmentId: null } });
  for (const kind of ["SECTION", "COURSE", "SEMESTER", "DEPARTMENT"] as const) {
    await prisma.academicUnit.deleteMany({ where: { ...where, kind } });
  }
  await prisma.academicSession.deleteMany({ where });
  await prisma.userRoleAssignment.deleteMany({ where: { user: where } });
  await prisma.user.deleteMany({ where });
  await prisma.institution.deleteMany({ where: { id: { in: INSTITUTIONS } } });
}

async function staff(id: string, institutionId: string, roleKey: string, passwordHash = "x") {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await prisma.user.create({
    data: {
      id,
      institutionId,
      email: `${id}@pr-it.test`,
      name: id,
      passwordHash,
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

const userOf = async (studentId: string) =>
  (await prisma.student.findUniqueOrThrow({ where: { id: studentId }, select: { userId: true } })).userId!;
const hashOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } })).passwordHash!;
const recoverableRow = (userId: string) => prisma.recoverableStudentPassword.findUnique({ where: { userId } });

/** The password staff are shown, or a failure naming what came back instead. */
async function revealed(who: SessionUser, studentId: string): Promise<string> {
  const outcome = await revealStudentPassword(who, studentId);
  assert.equal(outcome.status, "revealed", JSON.stringify(outcome));
  return outcome.status === "revealed" ? outcome.password : "";
}

/** The tables, of every table in the database, in which `secret` appears anywhere in a row. */
async function tablesHolding(secret: string): Promise<string[]> {
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const holding: string[] = [];
  for (const { name } of tables) {
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "${name}" t WHERE strpos(to_jsonb(t)::text, $1) > 0`,
      secret,
    );
    if (Number(row.n) > 0) holding.push(name);
  }
  return holding;
}

/** Everything written to the console while `run` runs, without printing it. */
async function logsOf<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  }
  try {
    return { value: await run(), lines };
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
}

async function signIn(email: string, password: string): Promise<{ user: SessionUser; token: string }> {
  const result = await loginService(email, password);
  assert.equal(result.ok, true, result.ok ? "" : `sign-in refused: ${result.reason}`);
  const token = result.ok ? result.rawToken : "";
  const user = await getSessionUserByRawToken(token);
  assert.ok(user, "the session resolves");
  return { user, token };
}

/** A student replacing their own password, as the portal does: signed in with the current one. */
async function studentChanges(email: string, current: string, next: string) {
  const { user, token } = await signIn(email, current);
  const result = await changeOwnPasswordService(user.userId, token, { current, next, confirm: next });
  assert.deepEqual(result.ok, true, JSON.stringify(result));
  passwords.push(next);
}

const deniedRows = (reason?: string) =>
  prisma.auditLog.count({
    where: {
      institutionId: { in: INSTITUTIONS },
      action: "student.password_view_denied",
      ...(reason ? { afterJson: { path: ["reason"], equals: reason } } : {}),
    },
  });
const viewedRows = (userId: string) =>
  prisma.auditLog.count({ where: { action: "student.password_viewed", entityId: userId } });

const previousKey = process.env.STUDENT_PASSWORD_ENCRYPTION_KEY;

before(async () => {
  if (SKIP) return;
  process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = KEY;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  const settings = { attendanceMode: "SUBJECT_WISE" };
  await prisma.institution.createMany({
    data: [
      { id: A, name: "Reveal College", type: "COLLEGE", settings },
      { id: B, name: "Other College", type: "COLLEGE", settings },
    ],
  });
  await prisma.academicSession.createMany({
    data: [
      { id: NOW, institutionId: A, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
      { id: B_NOW, institutionId: B, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    ],
  });
  await staff(ADMIN, A, "COLLEGE_ADMIN");
  await staff(HEAD_A, A, "FACULTY", await hashPassword(HEAD_A_PASSWORD));
  for (const id of [HEAD_B, TA, TB]) await staff(id, A, "FACULTY");
  await staff(B_ADMIN, B, "COLLEGE_ADMIN");
  await staff(B_TEACHER, B, "FACULTY");

  ids.cse = (await college.createDepartment(admin(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.me = (await college.createDepartment(admin(), { name: "Mechanical", code: "ME" })).departmentId;
  await prisma.user.update({ where: { id: TA }, data: { departmentId: ids.cse } });
  await prisma.user.update({ where: { id: TB }, data: { departmentId: ids.me } });
  await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: HEAD_A });
  await college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: HEAD_B });

  ids.s4 = (await college.createSemester(hodA(), { departmentId: ids.cse, number: 4 })).semesterId;
  ids.phy = (await college.createCourse(hodA(), { semesterId: ids.s4, code: "PHY401", name: "Physics" })).courseId;
  [ids.phyA, ids.phyB] = (
    await college.addCourseSections(hodA(), {
      departmentId: ids.cse,
      semesterId: ids.s4,
      courseId: ids.phy,
      sessionId: NOW,
      sections: [{ name: "A", teacherId: TA }, { name: "B" }],
    })
  ).sectionIds;
  ids.meS1 = (await college.createSemester(hodB(), { departmentId: ids.me, number: 1 })).semesterId;
  ids.mec = (await college.createCourse(hodB(), { semesterId: ids.meS1, code: "MEC101", name: "Mechanics" })).courseId;
  [ids.mecA] = (
    await college.addCourseSections(hodB(), {
      departmentId: ids.me,
      semesterId: ids.meS1,
      courseId: ids.mec,
      sessionId: NOW,
      sections: [{ name: "A", teacherId: TB }],
    })
  ).sectionIds;
  ids.bCse = (await college.createDepartment(bAdmin(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.bS1 = (await college.createSemester(bAdmin(), { departmentId: ids.bCse, number: 1 })).semesterId;
  ids.bCourse = (await college.createCourse(bAdmin(), { semesterId: ids.bS1, code: "CSE101", name: "Programming" })).courseId;
  await prisma.user.update({ where: { id: B_TEACHER }, data: { departmentId: ids.bCse } });
  [ids.bSection] = (
    await college.addCourseSections(bAdmin(), {
      departmentId: ids.bCse,
      semesterId: ids.bS1,
      courseId: ids.bCourse,
      sessionId: B_NOW,
      sections: [{ name: "A", teacherId: B_TEACHER }],
    })
  ).sectionIds;

  // Students, each through the flow that makes such a student for real.
  const admit = async (who: SessionUser, departmentId: string, sectionId: string, code: string, name: string) => {
    const admitted = await college.createDepartmentStudent(who, { departmentId, sectionId }, newStudent(code, name, `${name.toLowerCase()}@pr-it.test`));
    passwords.push(admitted.password);
    return admitted;
  };
  const riya = await admit(hodA(), ids.cse, ids.phyA, "CSE101", "Riya");
  ids.riya = riya.studentId;
  ids.riyaTemp = riya.password;
  ids.meera = (await admit(hodB(), ids.me, ids.mecA, "ME001", "Meera")).studentId;
  ids.elsewhere = (await admit(bAdmin(), ids.bCse, ids.bSection, "CSE101", "Elsewhere")).studentId;
  ids.vera = (await admit(hodA(), ids.cse, ids.phyA, "CSE102", "Vera")).studentId;
  ids.gone = (await admit(hodA(), ids.cse, ids.phyB, "CSE103", "Gone")).studentId;
  await college.removeStudentFromDepartmentSection(hodA(), { departmentId: ids.cse, studentId: ids.gone, sectionId: ids.phyB });

  // Vera's account predates recoverable passwords: a password of her own, no copy.
  const veraUser = await userOf(ids.vera);
  await prisma.recoverableStudentPassword.deleteMany({ where: { userId: veraUser } });
  await prisma.user.update({
    where: { id: veraUser },
    data: { passwordHash: await hashPassword("vera-own-password-1"), mustChangePassword: false },
  });
  passwords.push("vera-own-password-1");

  // A student with no account, and a record linked to a teacher's account.
  for (const [id, code] of [["pr-it-nologin", "CSE104"], ["pr-it-linked", "CSE105"]] as const) {
    await prisma.student.create({ data: { id, institutionId: A, studentCode: code, firstName: code, lastName: "Test" } });
    await college.addStudentToSection(hodA(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyA }, id);
  }
  await prisma.student.update({ where: { id: "pr-it-linked" }, data: { userId: TA } });
});

after(async () => {
  if (SKIP) return;
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pr_it_refuse_view_audit ON "AuditLog"`).catch(() => {});
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pr_it_refuse_view_audit()`).catch(() => {});
  await cleanup();
  if (previousKey === undefined) delete process.env.STUDENT_PASSWORD_ENCRYPTION_KEY;
  else process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = previousKey;
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

test("1. an HOD-created account stores its temporary password recoverably: ciphertext, nonce and tag under key version 1, beside the hash", { skip: SKIP }, async () => {
  const userId = await userOf(ids.riya);
  const row = await recoverableRow(userId);
  assert.ok(row, "a recoverable copy was stored with the account");
  assert.equal(row.keyVersion, 1, "under STUDENT_PASSWORD_ENCRYPTION_KEY, not the development key");
  assert.deepEqual([row.nonce.length, row.authTag.length, row.ciphertext.length], [12, 16, ids.riyaTemp.length]);
  assert.ok(!Buffer.from(row.ciphertext).toString("utf8").includes(ids.riyaTemp));
  const hash = await hashOf(userId);
  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(await verifyPassword(ids.riyaTemp, hash), true, "the hash is still what signs in");
});

test("2. the table holds ciphertext, nonce and tag — no plaintext column; no plaintext or temporary password in any table", { skip: SKIP }, async () => {
  const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'RecoverableStudentPassword' ORDER BY column_name`,
  );
  assert.deepEqual(columns.map((column) => column.column_name), [
    "authTag",
    "ciphertext",
    "createdAt",
    "id",
    "keyVersion",
    "nonce",
    "updatedAt",
    "userId",
  ]);
  for (const password of passwords) assert.deepEqual(await tablesHolding(password), [], "a password is stored in the clear");
});

test("3. the encryption key is in no table", { skip: SKIP }, async () => {
  const key = Buffer.from(KEY, "base64");
  for (const form of [KEY, key.toString("hex"), key.toString("base64url")]) {
    assert.deepEqual(await tablesHolding(form), []);
  }
});

// ---------------------------------------------------------------------------
// Who may reveal
// ---------------------------------------------------------------------------

test("4. a head reveals a student currently in their department — the password that signs in — and it is audited", { skip: SKIP }, async () => {
  const userId = await userOf(ids.riya);
  const { value: password, lines } = await logsOf(() => revealed(hodA(), ids.riya));
  assert.equal(password, ids.riyaTemp);
  assert.equal(await verifyPassword(password, await hashOf(userId)), true);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "student.password_viewed", entityId: userId } });
  assert.deepEqual(
    [audit.actorUserId, audit.institutionId, audit.entityType],
    [HEAD_A, A, "User"],
  );
  assert.deepEqual(audit.afterJson, { studentId: ids.riya, departmentId: ids.cse, actorRoles: ["HOD"], result: "revealed" });
  assert.ok(lines.some((line) => line.includes('"student_password.reveal"') && line.includes('"revealed"')), "observable");
  assert.ok(!lines.join("\n").includes(password), "the password reached a log line");
});

test("5. a head cannot reveal another department's student; the refusal is recorded", { skip: SKIP }, async () => {
  const before = await deniedRows("out_of_scope");
  const outcome = await revealStudentPassword(hodA(), ids.meera);
  assert.equal(outcome.status, "refused");
  assert.equal(outcome.status === "refused" && outcome.reason, "out_of_scope");
  assert.equal(await viewedRows(await userOf(ids.meera)), 0);
  assert.equal(await deniedRows("out_of_scope"), before + 1);
  // The other head, for Riya.
  assert.equal((await revealStudentPassword(hodB(), ids.riya)).status, "refused");
});

test("6. a head cannot reveal another college's student", { skip: SKIP }, async () => {
  const outcome = await revealStudentPassword(hodA(), ids.elsewhere);
  assert.equal(outcome.status === "refused" && outcome.reason, "out_of_scope");
  assert.equal(await viewedRows(await userOf(ids.elsewhere)), 0);
});

test("7. department faculty, teachers, a platform account and an account manager of another college cannot reveal", { skip: SKIP }, async () => {
  const cases: [string, SessionUser, string][] = [
    ["department faculty", actor("pr-it-df", "DEPARTMENT_FACULTY", A), "not_permitted"],
    ["a teacher", actor(TA, "FACULTY", A), "not_permitted"],
    ["a class teacher", actor("pr-it-ct", "CLASS_TEACHER", A), "not_permitted"],
    ["a platform account", actor("pr-it-platform", "PLATFORM_SUPER_ADMIN", null), "not_permitted"],
    ["another college's administrator", bAdmin(), "out_of_scope"],
  ];
  for (const [who, as, reason] of cases) {
    const outcome = await revealStudentPassword(as, ids.riya);
    assert.equal(outcome.status === "refused" && outcome.reason, reason, who);
  }
  assert.equal(await viewedRows(await userOf(ids.riya)), 1, "only the head's reveal in test 4");
});

test("8. a student cannot reveal — not another's password, and not their own through the staff path", { skip: SKIP }, async () => {
  const { user } = await signIn("riya@pr-it.test", ids.riyaTemp);
  for (const target of [ids.riya, ids.vera]) {
    const outcome = await revealStudentPassword(user, target);
    assert.equal(outcome.status === "refused" && outcome.reason, "not_permitted");
  }
});

test("9. the request carries a student id and nothing else: anything else in it changes nothing", { skip: SKIP }, async () => {
  for (const forged of [
    { studentId: ids.meera, departmentId: ids.me, institutionId: A, roles: ["COLLEGE_ADMIN"] },
    [ids.riya],
    null,
    "",
    "  ",
    "x".repeat(65),
  ]) {
    const outcome = await revealStudentPassword(hodA(), forged);
    assert.equal(outcome.status, "refused", JSON.stringify(forged));
  }
});

test("10. the administrator reveals any student of their own college — and one who has left the head's department", { skip: SKIP }, async () => {
  assert.equal(await revealed(admin(), ids.riya), ids.riyaTemp);
  const goneTemp = await revealed(admin(), ids.gone);
  assert.equal(await verifyPassword(goneTemp, await hashOf(await userOf(ids.gone))), true);
  const outcome = await revealStudentPassword(hodA(), ids.gone);
  assert.equal(outcome.status === "refused" && outcome.reason, "out_of_scope", "no longer in a current section of the department");
});

test("11. a student with no account, a staff account on a student record, a disabled login and an archived student are refused", { skip: SKIP }, async () => {
  assert.equal((await revealStudentPassword(admin(), "pr-it-nologin")).status === "refused", true);
  const linked = await revealStudentPassword(admin(), "pr-it-linked");
  assert.equal(linked.status === "refused" && linked.reason, "not_student_account");

  await setStudentLoginEnabled(admin(), ids.riya, false);
  for (const who of [admin(), hodA()]) {
    const outcome = await revealStudentPassword(who, ids.riya);
    assert.equal(outcome.status === "refused" && outcome.reason, "account_disabled");
  }
  await setStudentLoginEnabled(admin(), ids.riya, true);

  await updateStudent(admin(), { studentId: ids.riya, status: "INACTIVE" });
  const archived = await revealStudentPassword(admin(), ids.riya);
  assert.equal(archived.status === "refused" && archived.reason, "not_on_roll");
  await updateStudent(admin(), { studentId: ids.riya, status: "ACTIVE" });
  assert.equal(await revealed(admin(), ids.riya), ids.riyaTemp, "back on roll, back to normal");
});

test("12. no reveal without its audit row: if the row cannot be written, the password is not returned", { skip: SKIP }, async () => {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION pr_it_refuse_view_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'student.password_viewed' AND NEW."institutionId" = '${A}' THEN
        RAISE EXCEPTION 'audit refused for this test';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER pr_it_refuse_view_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION pr_it_refuse_view_audit()`,
  );
  try {
    await assert.rejects(() => revealStudentPassword(admin(), ids.riya));
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pr_it_refuse_view_audit ON "AuditLog"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pr_it_refuse_view_audit()`);
  }
});

// ---------------------------------------------------------------------------
// Always the current password
// ---------------------------------------------------------------------------

test("13. the student changes their password: staff see the new one, the old one neither signs in nor is shown", { skip: SKIP }, async () => {
  const userId = await userOf(ids.riya);
  const before = await recoverableRow(userId);
  await studentChanges("riya@pr-it.test", ids.riyaTemp, "Password-B-riya");
  const after = await recoverableRow(userId);
  assert.notDeepEqual(after?.ciphertext, before?.ciphertext, "the copy was replaced");
  assert.equal(await prisma.recoverableStudentPassword.count({ where: { userId } }), 1, "no history is kept");
  for (const who of [hodA(), admin()]) assert.equal(await revealed(who, ids.riya), "Password-B-riya");
  assert.deepEqual(await loginService("riya@pr-it.test", ids.riyaTemp), { ok: false, reason: "invalid_credentials" });
  await signIn("riya@pr-it.test", "Password-B-riya");
});

test("14. a reset: the new temporary password is what staff see; the student's own no longer signs in", { skip: SKIP }, async () => {
  const issued = await college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: ids.riya });
  passwords.push(issued.password);
  assert.equal(await revealed(admin(), ids.riya), issued.password);
  assert.deepEqual(await loginService("riya@pr-it.test", "Password-B-riya"), { ok: false, reason: "invalid_credentials" });
  const { user } = await signIn("riya@pr-it.test", issued.password);
  assert.equal(user.mustChangePassword, true, "and it must be replaced");
  ids.riyaTemp2 = issued.password;
});

test("15. the student replaces the reset password: staff now see that one, never an earlier one", { skip: SKIP }, async () => {
  await studentChanges("riya@pr-it.test", ids.riyaTemp2, "Password-D-riya");
  const shown = await revealed(hodA(), ids.riya);
  assert.equal(shown, "Password-D-riya");
  for (const earlier of [ids.riyaTemp, "Password-B-riya", ids.riyaTemp2]) assert.notEqual(shown, earlier);
  await signIn("riya@pr-it.test", "Password-D-riya");
});

test("16. an administrator's reset from the student's record replaces the recoverable copy too", { skip: SKIP }, async () => {
  const issued = await resetStudentLoginPassword(admin(), ids.riya);
  passwords.push(issued.password);
  assert.equal(await revealed(hodA(), ids.riya), issued.password);
  assert.equal(await verifyPassword(issued.password, await hashOf(await userOf(ids.riya))), true);
  ids.riyaTemp3 = issued.password;
});

test("17. concurrent resets and changes never leave the hash and the recoverable copy naming different passwords", { skip: SKIP }, async () => {
  const userId = await userOf(ids.riya);
  let current = ids.riyaTemp3;
  for (let round = 0; round < 6; round += 1) {
    const { user, token } = await signIn("riya@pr-it.test", current);
    const next = `Race-${round}-${randomBytes(4).toString("hex")}`;
    passwords.push(next);
    const [change, reset] = await Promise.allSettled([
      changeOwnPasswordService(user.userId, token, { current, next, confirm: next }),
      round % 2 === 0
        ? resetStudentLoginPassword(admin(), ids.riya)
        : college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: ids.riya }),
    ]);
    assert.equal(reset.status, "fulfilled", String(reset.status === "rejected" && reset.reason));
    assert.equal(change.status, "fulfilled", String(change.status === "rejected" && change.reason));
    if (reset.status === "fulfilled") passwords.push(reset.value.password);
    current = await revealed(admin(), ids.riya);
    assert.equal(await verifyPassword(current, await hashOf(userId)), true, `round ${round}: the copy is not the password that signs in`);
    assert.equal(await prisma.recoverableStudentPassword.count({ where: { userId } }), 1);
  }
});

// ---------------------------------------------------------------------------
// Accounts from before, staff accounts, and a missing key
// ---------------------------------------------------------------------------

test("18. an account from before has nothing to reveal — it still signs in — and a reset makes it recoverable", { skip: SKIP }, async () => {
  const detail = await college.getDepartmentStudent(hodA(), ids.cse, ids.vera);
  assert.equal(detail?.login.passwordRecoverable, false);
  assert.equal((await getStudentLogin(admin(), ids.vera))?.passwordRecoverable, false);
  assert.deepEqual(await revealStudentPassword(hodA(), ids.vera), { status: "unavailable" });
  await signIn("vera@pr-it.test", "vera-own-password-1");
  const issued = await college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: ids.vera });
  passwords.push(issued.password);
  assert.equal((await college.getDepartmentStudent(hodA(), ids.cse, ids.vera))?.login.passwordRecoverable, true);
  assert.equal(await revealed(hodA(), ids.vera), issued.password);
});

test("19. a copy moved onto another account does not open there (bound to its account)", { skip: SKIP }, async () => {
  const riyaRow = await recoverableRow(await userOf(ids.riya));
  const veraUser = await userOf(ids.vera);
  const veraRow = await recoverableRow(veraUser);
  await prisma.recoverableStudentPassword.update({
    where: { userId: veraUser },
    data: { ciphertext: riyaRow!.ciphertext, nonce: riyaRow!.nonce, authTag: riyaRow!.authTag, keyVersion: riyaRow!.keyVersion },
  });
  try {
    assert.deepEqual(await revealStudentPassword(admin(), ids.vera), { status: "unavailable" }, "not Riya's password");
  } finally {
    await prisma.recoverableStudentPassword.update({
      where: { userId: veraUser },
      data: { ciphertext: veraRow!.ciphertext, nonce: veraRow!.nonce, authTag: veraRow!.authTag, keyVersion: veraRow!.keyVersion },
    });
  }
});

test("20. under a different key a stored copy reads as unavailable, and opens again with the right one", { skip: SKIP }, async () => {
  process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    assert.deepEqual(await revealStudentPassword(admin(), ids.riya), { status: "unavailable" });
  } finally {
    process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = KEY;
  }
  const shown = await revealed(admin(), ids.riya);
  assert.equal(await verifyPassword(shown, await hashOf(await userOf(ids.riya))), true);
});

test("21. production without the key fails closed: no account, reset or change happens, and nothing is revealed", { skip: SKIP }, async () => {
  const riyaUser = await userOf(ids.riya);
  const hashBefore = await hashOf(riyaUser);
  const rowBefore = await recoverableRow(riyaUser);
  const current = await revealed(admin(), ids.riya);
  const { user, token } = await signIn("riya@pr-it.test", current);
  const students = await prisma.student.count({ where: { institutionId: A } });
  const previousEnv = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.STUDENT_PASSWORD_ENCRYPTION_KEY;
  try {
    await assert.rejects(
      () => college.createDepartmentStudent(hodA(), { departmentId: ids.cse, sectionId: ids.phyA }, newStudent("CSE190", "Nokey", "nokey@pr-it.test")),
      (error: Error) => error instanceof StudentError && /encryption key is not configured/.test(error.message),
    );
    await assert.rejects(() => resetStudentLoginPassword(admin(), ids.riya), StudentError);
    const change = await changeOwnPasswordService(user.userId, token, { current, next: "No-key-change-1", confirm: "No-key-change-1" });
    assert.equal(change.ok, false);
    const reveal = await revealStudentPassword(admin(), ids.riya);
    assert.equal(reveal.status === "refused" && reveal.reason, "not_configured");
  } finally {
    if (previousEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: previousEnv });
    process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = KEY;
  }
  assert.equal(await prisma.student.count({ where: { institutionId: A } }), students, "no student was created");
  assert.equal(await prisma.user.count({ where: { email: "nokey@pr-it.test" } }), 0, "nor an account");
  assert.equal(await hashOf(riyaUser), hashBefore, "no password changed");
  assert.deepEqual((await recoverableRow(riyaUser))?.ciphertext, rowBefore?.ciphertext);
});

test("22. staff passwords are never recoverable: a head's own change and a head-created teacher keep no copy", { skip: SKIP }, async () => {
  const { user, token } = await signIn(`${HEAD_A}@pr-it.test`, HEAD_A_PASSWORD);
  const changed = await changeOwnPasswordService(user.userId, token, {
    current: HEAD_A_PASSWORD,
    next: "head-a-new-password-2",
    confirm: "head-a-new-password-2",
  });
  assert.equal(changed.ok, true);
  passwords.push("head-a-new-password-2");
  const invited = await college.addDepartmentFaculty(hodA(), { departmentId: ids.cse, name: "Faculty X", email: "faculty.x@pr-it.test" });
  passwords.push(invited.password);
  assert.equal(await prisma.recoverableStudentPassword.count({ where: { userId: { in: [HEAD_A, invited.member.id, ADMIN, TA] } } }), 0);
  const staffWithCopies = await prisma.recoverableStudentPassword.count({
    where: { user: { institutionId: { in: INSTITUTIONS }, roleAssignments: { some: { role: { key: { not: "STUDENT" } } } } } },
  });
  assert.equal(staffWithCopies, 0, "every copy belongs to a student account");
});

// ---------------------------------------------------------------------------
// Where the password never is
// ---------------------------------------------------------------------------

test("23. no page, list or ordinary response carries the password — only whether one can be revealed", { skip: SKIP }, async () => {
  const current = await revealed(admin(), ids.riya);
  const shown = JSON.stringify([
    await college.getDepartmentStudent(hodA(), ids.cse, ids.riya),
    await college.getDepartmentStudent(admin(), ids.cse, ids.riya),
    await college.getDepartmentStudents(hodA(), ids.cse),
    await college.searchStudentsForDepartment(hodA(), ids.cse, "Riya"),
    await getStudentLogin(admin(), ids.riya),
    await listStudentsForRequest(admin(), EMPTY_STUDENT_FILTERS),
  ]);
  for (const secret of [current, ...passwords]) assert.ok(!shown.includes(secret), "a password in an ordinary response");
  assert.ok(!shown.includes("scrypt$"), "a hash in an ordinary response");
  const row = await recoverableRow(await userOf(ids.riya));
  for (const part of [row!.ciphertext, row!.nonce, row!.authTag]) {
    for (const form of [Buffer.from(part).toString("hex"), Buffer.from(part).toString("base64")]) {
      assert.ok(!shown.includes(form), "ciphertext in an ordinary response");
    }
  }
});

test("24. no audit row carries a password, a hash, ciphertext or the key; no password or key reached a log", { skip: SKIP }, async () => {
  const { lines } = await logsOf(async () => {
    const issued = await resetStudentLoginPassword(admin(), ids.riya);
    passwords.push(issued.password);
    await revealStudentPassword(hodA(), ids.riya);
    await revealStudentPassword(hodA(), ids.meera);
    await studentChanges("riya@pr-it.test", issued.password, "Password-E-riya");
  });
  const rows = await prisma.auditLog.findMany({ where: { institutionId: { in: INSTITUTIONS } } });
  const audit = JSON.stringify(rows);
  const row = await recoverableRow(await userOf(ids.riya));
  const log = lines.join("\n");
  for (const secret of [...passwords, KEY, Buffer.from(KEY, "base64").toString("hex"), Buffer.from(row!.ciphertext).toString("hex"), Buffer.from(row!.ciphertext).toString("base64")]) {
    assert.ok(!audit.includes(secret), "a secret in the audit log");
    assert.ok(!log.includes(secret), "a secret in a log line");
  }
  assert.ok(!audit.includes("scrypt$"), "a hash in the audit log");
  assert.ok(rows.some((entry) => entry.action === "student.password_viewed"));
  assert.ok(rows.some((entry) => entry.action === "student.password_view_denied"));
  for (const password of passwords) assert.deepEqual(await tablesHolding(password), [], "a password stored in the clear");
});
