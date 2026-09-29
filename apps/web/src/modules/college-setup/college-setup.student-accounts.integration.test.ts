import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDING_DIMENSION,
  type EnrollResponse,
  type ModelInfoResponse,
} from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import { getStudentDashboard } from "@/modules/attendance-analytics/service";
import { hashPassword, verifyPassword } from "@/modules/auth-tenancy/password";
import { PASSWORD_CHANGE_PATH, afterSignInPath } from "@/modules/auth-tenancy/redirect";
import {
  changeOwnPasswordService,
  getSessionUserByRawToken,
  loginService,
  loginWithStudentIdService,
} from "@/modules/auth-tenancy/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { inviteFaculty } from "@/modules/faculty/directory-service";
import { StudentError } from "@/modules/students/directory-types";
import {
  getStudentLogin,
  provisionStudentLogin,
  resetStudentLoginPassword,
  setStudentLoginEnabled,
} from "@/modules/students/login-provisioning";
import * as college from "./service.ts";
import { CollegeSetupError } from "./types.ts";

/**
 * A head of department admits a student together with their Student Portal
 * login, hands over a temporary password shown once, and can later issue a
 * new one — and nobody, head or administrator, can ever read a password.
 *
 * What is tested is what the database ends up holding and what each person
 * can then do with it: the rows written (all of them, or none), the one role
 * the account gets, the hash that is all that is stored, the student signing
 * in for real (`loginService`, then the session lookup every page uses),
 * the temporary password replaced, a reset, and every way a head might reach
 * past their own department or college. Only face-ai is replaced.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const A = "sa-it-inst";
const B = "sa-it-other";
const INSTITUTIONS = [A, B];
const NOW = "sa-it-now";
const B_NOW = "sa-it-b-now";
const ADMIN = "sa-it-admin";
const HEAD_A = "sa-it-head-a";
const HEAD_B = "sa-it-head-b";
const TA = "sa-it-teacher-a";
const TB = "sa-it-teacher-b";
const B_ADMIN = "sa-it-b-admin";
const B_TEACHER = "sa-it-b-teacher";
/** Computer Science, Physics A, no login, an email on the record. */
const AMAN = "sa-it-aman";
/** Mechanical, Mechanics A, no login. */
const MEERA = "sa-it-meera";
/** The other college. */
const ELSEWHERE = "sa-it-elsewhere";
/** Computer Science, a login from before temporary passwords had to be replaced. */
const VETERAN = "sa-it-veteran";
/** Computer Science, a record linked to a teacher's account by something other than this code. */
const LINKED = "sa-it-linked";

function actor(userId: string, roleKey: string, institutionId: string): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@sa-it.test`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId: null, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}

const admin = () => actor(ADMIN, "COLLEGE_ADMIN", A);
const hodA = () => actor(HEAD_A, "HOD", A);
const hodB = () => actor(HEAD_B, "HOD", A);
const refused = (pattern: RegExp) => (error: Error) =>
  (error instanceof CollegeSetupError || error instanceof StudentError) && pattern.test(error.message);
const forbidden = (error: Error) => error instanceof ForbiddenError;

const ids: Record<string, string> = {};
/** Every password this file issues or chooses — none of them may be found stored anywhere. */
const passwords: string[] = [];

const newStudent = (studentCode: string, firstName: string, lastName: string, email: string) => ({
  studentCode,
  firstName,
  lastName,
  email,
  phone: "",
  campusId: "",
  admissionNumber: "",
  admissionDate: "",
});
const physicsA = () => ({ departmentId: ids.cse, sectionId: ids.phyA });

// ---------------------------------------------------------------------------
// face-ai, replaced
// ---------------------------------------------------------------------------

const MODEL: ModelInfoResponse = {
  modelName: "sa-it-model",
  modelVersion: "1+pp1",
  weightsVersion: "1",
  preprocessingVersion: "1",
  embeddingDim: EMBEDDING_DIMENSION,
  embeddingNormalized: true,
  runtime: "test",
  commercialUse: "not-applicable",
  productionEligible: false,
  contractVersion: "v1",
};

function faceAi(face: number) {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[face] = 1;
  v[40] = 0.15;
  const norm = Math.hypot(...v);
  const reply: EnrollResponse = {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: v.map((x) => x / norm),
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    weightsVersion: MODEL.weightsVersion,
    preprocessingVersion: MODEL.preprocessingVersion,
    embeddingDim: EMBEDDING_DIMENSION,
    aligned: true,
  };
  return { faceModelInfo: async () => MODEL, faceEnroll: async () => reply };
}

// ---------------------------------------------------------------------------
// The college
// ---------------------------------------------------------------------------

async function cleanup() {
  const where = { institutionId: { in: INSTITUTIONS } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: where } });
  await prisma.attendanceRecord.deleteMany({ where });
  await prisma.attendanceSession.deleteMany({ where });
  await prisma.faceEmbedding.deleteMany({ where });
  await prisma.studentSubjectEnrollment.deleteMany({ where: { student: where } });
  await prisma.cohortSubject.deleteMany({ where: { cohort: where } });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: where } });
  await prisma.enrollment.deleteMany({ where });
  await prisma.student.deleteMany({ where });
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

async function staff(id: string, institutionId: string, roleKey: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await prisma.user.create({
    data: {
      id,
      institutionId,
      email: `${id}@sa-it.test`,
      name: id,
      passwordHash: "x",
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

async function student(id: string, institutionId: string, code: string, firstName: string, lastName: string, email?: string) {
  await prisma.student.create({ data: { id, institutionId, studentCode: code, firstName, lastName, email: email ?? null } });
}

/** A row count that must not change when a request is refused. */
const counts = async () =>
  JSON.stringify(
    await Promise.all([
      prisma.student.count({ where: { institutionId: { in: INSTITUTIONS } } }),
      prisma.user.count({ where: { institutionId: { in: INSTITUTIONS } } }),
      prisma.enrollment.count({ where: { institutionId: { in: INSTITUTIONS } } }),
      prisma.userRoleAssignment.count({ where: { user: { institutionId: { in: INSTITUTIONS } } } }),
    ]),
  );

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

async function signIn(email: string, password: string): Promise<{ user: SessionUser; token: string }> {
  const result = await loginService(email, password);
  assert.equal(result.ok, true, result.ok ? "" : `sign-in refused: ${result.reason}`);
  const token = result.ok ? result.rawToken : "";
  const user = await getSessionUserByRawToken(token);
  assert.ok(user, "the session resolves");
  return { user, token };
}

const accountOf = async (studentId: string) => {
  const row = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: {
      userId: true,
      user: {
        select: {
          id: true,
          email: true,
          institutionId: true,
          status: true,
          passwordHash: true,
          mustChangePassword: true,
          roleAssignments: { select: { institutionId: true, role: { select: { key: true } } } },
        },
      },
    },
  });
  return row.user;
};

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  const settings = { attendanceMode: "SUBJECT_WISE" };
  await prisma.institution.createMany({
    data: [
      { id: A, name: "Student Accounts College", type: "COLLEGE", settings },
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
  for (const id of [HEAD_A, HEAD_B, TA, TB]) await staff(id, A, "FACULTY");
  await staff(B_ADMIN, B, "COLLEGE_ADMIN");
  await staff(B_TEACHER, B, "FACULTY");

  ids.cse = (await college.createDepartment(admin(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.me = (await college.createDepartment(admin(), { name: "Mechanical", code: "ME" })).departmentId;
  await prisma.user.update({ where: { id: TA }, data: { departmentId: ids.cse } });
  await prisma.user.update({ where: { id: TB }, data: { departmentId: ids.me } });
  await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: HEAD_A });
  await college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: HEAD_B });

  ids.s4 = (await college.createSemester(hodA(), { departmentId: ids.cse, number: 4 })).semesterId;
  await college.setCurrentSemester(hodA(), { departmentId: ids.cse, semesterId: ids.s4 });
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

  const bAdmin = actor(B_ADMIN, "COLLEGE_ADMIN", B);
  ids.bCse = (await college.createDepartment(bAdmin, { name: "Computer Science", code: "CSE" })).departmentId;
  ids.bS1 = (await college.createSemester(bAdmin, { departmentId: ids.bCse, number: 1 })).semesterId;
  ids.bCourse = (await college.createCourse(bAdmin, { semesterId: ids.bS1, code: "CSE101", name: "Programming" })).courseId;
  await prisma.user.update({ where: { id: B_TEACHER }, data: { departmentId: ids.bCse } });
  [ids.bSection] = (
    await college.addCourseSections(bAdmin, {
      departmentId: ids.bCse,
      semesterId: ids.bS1,
      courseId: ids.bCourse,
      sessionId: B_NOW,
      sections: [{ name: "A", teacherId: B_TEACHER }],
    })
  ).sectionIds;

  await student(AMAN, A, "CSE001", "Aman", "Kumar", "aman.kumar@sa-it.test");
  await student(MEERA, A, "ME001", "Meera", "Iyer");
  await student(ELSEWHERE, B, "CSE001", "Aman", "Elsewhere");
  await student(VETERAN, A, "CSE002", "Vera", "Nair");
  await student(LINKED, A, "CSE003", "Linked", "Record");
  const sectionOf = (sectionId: string, courseId = ids.phy, semesterId = ids.s4, departmentId = ids.cse) => ({
    departmentId,
    semesterId,
    courseId,
    sectionId,
  });
  for (const id of [AMAN, VETERAN, LINKED]) await college.addStudentToSection(hodA(), sectionOf(ids.phyA), id);
  await college.addStudentToSection(hodB(), sectionOf(ids.mecA, ids.mec, ids.meS1, ids.me), MEERA);
  await college.addStudentToSection(bAdmin, sectionOf(ids.bSection, ids.bCourse, ids.bS1, ids.bCse), ELSEWHERE);

  // A login from before this change: its password is the student's own,
  // nothing asks for it to be replaced — the migration's default — and no
  // recoverable copy of it was ever kept.
  const veteran = await provisionStudentLogin(admin(), VETERAN, { email: "vera.nair@sa-it.test" });
  passwords.push(veteran.password, "veterans-own-password-1");
  await prisma.user.update({
    where: { id: veteran.account.userId },
    data: { passwordHash: await hashPassword("veterans-own-password-1"), mustChangePassword: false },
  });
  await prisma.recoverableStudentPassword.deleteMany({ where: { userId: veteran.account.userId } });
  // A record pointing at a teacher's account — not something this code ever writes.
  await prisma.student.update({ where: { id: LINKED }, data: { userId: TA } });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Admitting a student with their login
// ---------------------------------------------------------------------------

test("1. a head admits a student with their login: the record, the section, one STUDENT account, the link and the audit rows", { skip: SKIP }, async () => {
  const admitted = await college.createDepartmentStudent(
    hodA(),
    physicsA(),
    newStudent("CSE101", "Riya", "Sen", " Riya.Sen@SA-IT.test "),
  );
  ids.riya = admitted.studentId;
  ids.riyaTemporary = admitted.password;
  passwords.push(admitted.password);
  assert.deepEqual(
    [admitted.name, admitted.studentCode, admitted.email, admitted.departmentId],
    ["Riya Sen", "CSE101", "riya.sen@sa-it.test", ids.cse],
    "the address is normalised",
  );
  assert.ok(admitted.password.length >= 16, "a long temporary password");

  const record = await prisma.student.findUniqueOrThrow({ where: { id: admitted.studentId } });
  assert.deepEqual([record.institutionId, record.studentCode, record.email, record.status], [A, "CSE101", "riya.sen@sa-it.test", "ACTIVE"]);
  const placement = await prisma.enrollment.findUniqueOrThrow({
    where: { studentId_cohortId: { studentId: admitted.studentId, cohortId: ids.phyA } },
  });
  assert.equal(placement.status, "ACTIVE");

  const account = await accountOf(admitted.studentId);
  assert.ok(account);
  assert.deepEqual(
    [account.email, account.institutionId, account.status, account.mustChangePassword],
    ["riya.sen@sa-it.test", A, "ACTIVE", true],
  );
  assert.deepEqual(
    account.roleAssignments.map((assignment) => [assignment.role.key, assignment.institutionId]),
    [["STUDENT", A]],
    "exactly the STUDENT role, in the head's college",
  );
  ids.riyaUser = account.id;

  const audit = await prisma.auditLog.findMany({
    where: { institutionId: A, actorUserId: HEAD_A, OR: [{ entityId: admitted.studentId }, { entityId: account.id }, { entityId: placement.id }] },
    select: { action: true, afterJson: true },
  });
  assert.deepEqual(audit.map((row) => row.action).sort(), ["enrollment.created", "student.created", "user.created"]);
  const created = audit.find((row) => row.action === "user.created")!.afterJson as Record<string, unknown>;
  assert.deepEqual(
    [created.roleKey, created.studentId, created.email, created.passwordChangeRequired],
    ["STUDENT", admitted.studentId, "riya.sen@sa-it.test", true],
  );
});

test("2. only a scrypt hash of the temporary password is stored — the password itself is in no row of any table", { skip: SKIP }, async () => {
  const account = await accountOf(ids.riya);
  const password = ids.riyaTemporary;
  assert.ok(account?.passwordHash?.startsWith("scrypt$"), "a scrypt hash");
  assert.notEqual(account?.passwordHash, password);
  assert.equal(await verifyPassword(password, account!.passwordHash!), true, "and it is this password's hash");
  assert.deepEqual(await tablesHolding(password), [], "the plaintext is nowhere in the database");
});

test("3. the department page shows the account, and never a password or a hash", { skip: SKIP }, async () => {
  const detail = await college.getDepartmentStudent(hodA(), ids.cse, ids.riya);
  assert.ok(detail);
  assert.deepEqual(
    [detail.login.state, detail.login.email, detail.login.mustChangePassword, detail.login.lastPasswordChange?.by, detail.login.canManage],
    ["enabled", "riya.sen@sa-it.test", true, "staff", true],
  );
  const shown = JSON.stringify([detail, await getStudentLogin(admin(), ids.riya), await college.getDepartmentStudents(hodA(), ids.cse)]);
  for (const password of passwords) assert.ok(!shown.includes(password), "a password reached a page");
  assert.ok(!shown.includes("scrypt$"), "a hash reached a page");
});

test("4. the college email is required, and must look like one; a refusal creates nothing", { skip: SKIP }, async () => {
  const before = await counts();
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE102", "No", "Email", "")),
    refused(/college email/),
  );
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE102", "Bad", "Email", "not-an-email")),
    refused(/does not look like an email address/),
  );
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE102", "Stand", "In", "x@students.invalid")),
    refused(/does not look like an email address/),
  );
  assert.equal(await counts(), before, "nobody half-created");
});

test("5. an address that is already an account's — staff or student — is refused, and nothing is half-created", { skip: SKIP }, async () => {
  const before = await counts();
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE103", "Takes", "Teachers", `${TA}@sa-it.test`)),
    refused(/already uses/),
  );
  // A student's sign-in address — not on any student's record — whatever its case.
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE103", "Takes", "Veras", "VERA.NAIR@sa-it.test")),
    refused(/already uses vera\.nair@sa-it\.test/),
  );
  // Riya's is both her record's email and her account's: refused as the same person admitted twice.
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE103", "Takes", "Riyas", "RIYA.SEN@sa-it.test")),
    refused(/Another student already has this email/),
  );
  assert.equal(await counts(), before);
});

test("6. an email another student already has is refused: that is the same person admitted twice", { skip: SKIP }, async () => {
  const before = await counts();
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE104", "Aman", "Again", "aman.kumar@sa-it.test")),
    refused(/Another student already has this email.*Add existing student/),
  );
  assert.equal(await counts(), before);
});

test("7. a student ID already in use is refused by the student service's own check, and nothing is created", { skip: SKIP }, async () => {
  const before = await counts();
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE101", "Other", "Riya", "other.riya@sa-it.test")),
    refused(/already belongs to Riya Sen/),
  );
  assert.equal(await counts(), before);
  assert.equal(await prisma.user.count({ where: { email: "other.riya@sa-it.test" } }), 0, "no account either");
});

test("8. two admissions racing for one address: exactly one wins, and the other leaves no student, placement or account behind", { skip: SKIP }, async () => {
  const email = "race@sa-it.test";
  const results = await Promise.allSettled([
    college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE110", "Race", "One", email)),
    college.createDepartmentStudent(hodA(), physicsA(), newStudent("CSE111", "Race", "Two", email)),
  ]);
  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected");
  assert.deepEqual([won.length, lost.length], [1, 1]);
  const reason = (lost[0] as PromiseRejectedResult).reason as Error;
  assert.ok(reason instanceof StudentError && /already uses race@sa-it.test/.test(reason.message), reason.message);
  const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof college.createDepartmentStudent>>>).value;
  passwords.push(winner.password);
  const loserCode = winner.studentCode === "CSE110" ? "CSE111" : "CSE110";
  assert.equal(await prisma.student.count({ where: { institutionId: A, studentCode: loserCode } }), 0, "no student without the login they were admitted with");
  assert.equal(await prisma.user.count({ where: { email } }), 1, "one account");
  assert.equal(
    await prisma.enrollment.count({ where: { cohortId: ids.phyA, student: { studentCode: { in: ["CSE110", "CSE111"] } } } }),
    1,
    "one placement",
  );
  assert.equal(
    await prisma.auditLog.count({ where: { institutionId: A, action: "student.created", afterJson: { path: ["studentCode"], equals: loserCode } } }),
    0,
    "no audit row for a student who was never created",
  );
});

// ---------------------------------------------------------------------------
// The student's first sign-in
// ---------------------------------------------------------------------------

test("9. the student signs in with the college email and the temporary password — a session good only for choosing a password", { skip: SKIP }, async () => {
  const temporary = ids.riyaTemporary;
  const result = await loginService("riya.sen@sa-it.test", temporary);
  assert.ok(result.ok);
  assert.equal(result.user.mustChangePassword, true);
  assert.equal(afterSignInPath(result.user.mustChangePassword, "/portal"), PASSWORD_CHANGE_PATH, "sent to the password change");
  const session = await getSessionUserByRawToken(result.rawToken);
  assert.equal(session?.mustChangePassword, true, "every request sees the flag");
  ids.riyaToken = result.rawToken;

  // The student ID works the same way, on the college's student link.
  const byId = await loginWithStudentIdService(A, "CSE101", temporary);
  assert.ok(byId.ok);
  assert.equal(byId.user.mustChangePassword, true);
});

test("10. choosing a password: not the temporary one again; then only the new one works, and the flag is cleared", { skip: SKIP }, async () => {
  const temporary = ids.riyaTemporary;
  const own = "riya-chose-this-1";
  const keep = await changeOwnPasswordService(ids.riyaUser, ids.riyaToken, { current: temporary, next: temporary, confirm: temporary });
  assert.deepEqual(keep, { ok: false, error: "Choose a password different from the current one." });
  const wrong = await changeOwnPasswordService(ids.riyaUser, ids.riyaToken, { current: "not-it", next: own, confirm: own });
  assert.deepEqual(wrong, { ok: false, error: "The current password is not correct." });

  const changed = await changeOwnPasswordService(ids.riyaUser, ids.riyaToken, { current: temporary, next: own, confirm: own });
  assert.deepEqual(changed, { ok: true, otherSessionsEnded: 1 }, "the student-ID sign-in from test 9 is signed out");
  passwords.push(own);

  const session = await getSessionUserByRawToken(ids.riyaToken);
  assert.equal(session?.mustChangePassword, false, "this device goes on into the portal");
  assert.equal(afterSignInPath(session?.mustChangePassword, "/portal"), "/portal");
  assert.deepEqual(await loginService("riya.sen@sa-it.test", temporary), { ok: false, reason: "invalid_credentials" }, "the temporary password stops working");
  const again = await signIn("riya.sen@sa-it.test", own);
  assert.equal(again.user.mustChangePassword, false);

  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: ids.riyaUser, action: "user.updated", afterJson: { path: ["passwordChanged"], equals: true } },
  });
  assert.equal(audit.actorUserId, ids.riyaUser);
  assert.deepEqual(
    [(audit.afterJson as Record<string, unknown>).changedBy, (audit.afterJson as Record<string, unknown>).replacedIssuedPassword],
    ["self", true],
  );

  const detail = await college.getDepartmentStudent(hodA(), ids.cse, ids.riya);
  assert.deepEqual([detail?.login.mustChangePassword, detail?.login.lastPasswordChange?.by], [false, "student"]);
});

test("11. the password the student chose is in no page, no list and no table — only the audited reveal returns it", { skip: SKIP }, async () => {
  const own = "riya-chose-this-1";
  const shown = JSON.stringify([
    await college.getDepartmentStudent(hodA(), ids.cse, ids.riya),
    await college.getDepartmentStudents(hodA(), ids.cse),
    await college.getDepartmentStudent(admin(), ids.cse, ids.riya),
    await getStudentLogin(admin(), ids.riya),
  ]);
  assert.ok(!shown.includes(own));
  assert.ok(!shown.includes("scrypt$"));
  assert.deepEqual(await tablesHolding(own), []);
});

test("12. the student's own portal shows them, and only them", { skip: SKIP }, async () => {
  const { user } = await signIn("riya.sen@sa-it.test", "riya-chose-this-1");
  const dashboard = await getStudentDashboard(user);
  assert.equal(dashboard?.fullName, "Riya Sen");
  assert.equal(dashboard?.studentCode, "CSE101");
  assert.deepEqual(dashboard?.enrollments.map((enrollment) => enrollment.cohortId), [ids.phyA]);
  assert.equal(hasPermission(user, "attendanceRecord.read"), false, "a student account reads nobody else's attendance");
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

test("13. the head resets it: a new temporary password, once; the old one and every session stop; the change is asked for again", { skip: SKIP }, async () => {
  const own = "riya-chose-this-1";
  const { token } = await signIn("riya.sen@sa-it.test", own);
  const issued = await college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: ids.riya });
  passwords.push(issued.password);
  assert.deepEqual([issued.name, issued.loginId], ["Riya Sen", "CSE101"]);
  assert.ok(issued.password.length >= 16);
  assert.notEqual(issued.password, own);

  assert.equal(await getSessionUserByRawToken(token), null, "signed out everywhere");
  assert.deepEqual(await loginService("riya.sen@sa-it.test", own), { ok: false, reason: "invalid_credentials" }, "the old password is rejected");
  const fresh = await signIn("riya.sen@sa-it.test", issued.password);
  assert.equal(fresh.user.mustChangePassword, true, "the new one is accepted — and must be replaced");

  const audit = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: ids.riyaUser, action: "user.updated", afterJson: { path: ["passwordReset"], equals: true } },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(audit.actorUserId, HEAD_A, "recorded as the head's doing");
  const detail = await college.getDepartmentStudent(hodA(), ids.cse, ids.riya);
  assert.deepEqual([detail?.login.mustChangePassword, detail?.login.lastPasswordChange?.by], [true, "staff"]);
  assert.deepEqual(await tablesHolding(issued.password), []);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("14. a head cannot reset, or create a login for, another department's student", { skip: SKIP }, async () => {
  const before = await counts();
  await assert.rejects(
    () => college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: MEERA }),
    refused(/not in any of this department's sections/),
  );
  await assert.rejects(
    () => college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.me, studentId: MEERA }),
    refused(/not part of this college/),
  );
  await assert.rejects(
    () => college.createDepartmentStudentLogin(hodA(), { departmentId: ids.me, studentId: MEERA, email: "meera@sa-it.test" }),
    refused(/not part of this college/),
  );
  await assert.rejects(
    () => college.createDepartmentStudentLogin(hodA(), { departmentId: ids.cse, studentId: MEERA, email: "meera@sa-it.test" }),
    refused(/not in any of this department's sections/),
  );
  // Nor can the other head reach Computer Science's.
  await assert.rejects(
    () => college.resetDepartmentStudentPassword(hodB(), { departmentId: ids.cse, studentId: ids.riya }),
    refused(/not part of this college/),
  );
  assert.equal(await counts(), before);
  assert.equal(await prisma.user.count({ where: { email: "meera@sa-it.test" } }), 0);
});

test("15. a head cannot reach another college's student or section", { skip: SKIP }, async () => {
  const before = await counts();
  await assert.rejects(
    () => college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: ELSEWHERE }),
    refused(/not in any of this department's sections/),
  );
  await assert.rejects(
    () => college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.bCse, studentId: ELSEWHERE }),
    refused(/not part of this college/),
  );
  await assert.rejects(
    () => college.createDepartmentStudentLogin(hodA(), { departmentId: ids.bCse, studentId: ELSEWHERE, email: "elsewhere@sa-it.test" }),
    refused(/not part of this college/),
  );
  await assert.rejects(
    () => college.createDepartmentStudent(hodA(), { departmentId: ids.bCse, sectionId: ids.bSection }, newStudent("CSE120", "Far", "Away", "far@sa-it.test")),
    refused(/not part of this college/),
  );
  assert.equal(await counts(), before);
});

test("16. tampered requests are refused: another department's section, another college's section, an empty one", { skip: SKIP }, async () => {
  const before = await counts();
  const attempt = (departmentId: string, sectionId: string) =>
    college.createDepartmentStudent(hodA(), { departmentId, sectionId }, newStudent("CSE121", "Tam", "Pered", "tampered@sa-it.test"));
  await assert.rejects(() => attempt(ids.cse, ids.mecA), refused(/not part of this department/));
  await assert.rejects(() => attempt(ids.me, ids.mecA), refused(/not part of this college/));
  await assert.rejects(() => attempt(ids.cse, ids.bSection), refused(/not part of this department/));
  await assert.rejects(() => attempt(ids.cse, ""), refused(/Choose one of the department's sections/));
  await assert.rejects(() => attempt("", ids.phyA), refused(/not part of this college/));
  assert.equal(await counts(), before);
});

test("17. a head cannot choose the role or the college: extra fields are ignored, and the account is one STUDENT role here", { skip: SKIP }, async () => {
  const forged = {
    ...newStudent("CSE122", "Forged", "Fields", "forged@sa-it.test"),
    institutionId: B,
    roleKey: "COLLEGE_ADMIN",
    roleId: "anything",
    userId: ADMIN,
    status: "INACTIVE",
  };
  const admitted = await college.createDepartmentStudent(hodA(), physicsA(), forged as never);
  passwords.push(admitted.password);
  const account = await accountOf(admitted.studentId);
  assert.deepEqual(
    [account?.institutionId, account?.roleAssignments.map((assignment) => assignment.role.key)],
    [A, ["STUDENT"]],
  );
  const record = await prisma.student.findUniqueOrThrow({ where: { id: admitted.studentId } });
  assert.deepEqual([record.institutionId, record.status], [A, "ACTIVE"]);
  assert.notEqual(record.userId, ADMIN);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ADMIN } })).passwordHash, "x", "no other account was touched");
});

test("18. the lent permission never outlives the call: the head still has no account management of their own", { skip: SKIP }, async () => {
  assert.equal(hasPermission(hodA(), "user.invite"), false);
  await assert.rejects(() => provisionStudentLogin(hodA(), AMAN, { email: "aman.kumar@sa-it.test" }), forbidden);
  await assert.rejects(() => resetStudentLoginPassword(hodA(), ids.riya), forbidden);
  await assert.rejects(() => setStudentLoginEnabled(hodA(), ids.riya, false), forbidden, "switching a login off stays with administrators");
  await assert.rejects(
    () => inviteFaculty(hodA(), { name: "Sneaky", email: "sneaky@sa-it.test", roleKey: "COLLEGE_ADMIN", departmentId: null } as never),
    forbidden,
  );
  assert.equal(await prisma.user.count({ where: { email: "sneaky@sa-it.test" } }), 0);
});

// ---------------------------------------------------------------------------
// Existing students
// ---------------------------------------------------------------------------

test("19. a department student without a login is given one, with their college email; one who has a login never gets a second", { skip: SKIP }, async () => {
  const before = await accountOf(ids.riya);
  await assert.rejects(
    () => college.createDepartmentStudentLogin(hodA(), { departmentId: ids.cse, studentId: ids.riya, email: "second@sa-it.test" }),
    refused(/already has a login/),
  );
  assert.deepEqual(await accountOf(ids.riya), before, "the existing account is untouched");
  assert.equal(await prisma.user.count({ where: { email: "second@sa-it.test" } }), 0);

  await assert.rejects(
    () => college.createDepartmentStudentLogin(hodA(), { departmentId: ids.cse, studentId: AMAN, email: "  " }),
    refused(/college email/),
  );
  const created = await college.createDepartmentStudentLogin(hodA(), { departmentId: ids.cse, studentId: AMAN, email: "aman.kumar@sa-it.test" });
  passwords.push(created.password);
  assert.deepEqual([created.name, created.loginId, created.email], ["Aman Kumar", "CSE001", "aman.kumar@sa-it.test"]);
  const account = await accountOf(AMAN);
  assert.deepEqual(
    [account?.mustChangePassword, account?.roleAssignments.map((assignment) => assignment.role.key)],
    [true, ["STUDENT"]],
  );
  await assert.rejects(
    () => college.createDepartmentStudentLogin(hodA(), { departmentId: ids.cse, studentId: AMAN, email: "aman.second@sa-it.test" }),
    refused(/already has a login/),
  );
  const signedIn = await signIn("aman.kumar@sa-it.test", created.password);
  assert.equal(signedIn.user.mustChangePassword, true);
});

test("20. an account from before this change is not asked to change its password", { skip: SKIP }, async () => {
  const { user } = await signIn("vera.nair@sa-it.test", "veterans-own-password-1");
  assert.equal(user.mustChangePassword, false);
  assert.equal(afterSignInPath(user.mustChangePassword, "/portal"), "/portal");
  const detail = await college.getDepartmentStudent(hodA(), ids.cse, VETERAN);
  assert.deepEqual([detail?.login.state, detail?.login.mustChangePassword], ["enabled", false]);
});

test("21. a record linked to a staff account cannot be used to reset or switch that account from a student's screen", { skip: SKIP }, async () => {
  const teacher = await prisma.user.findUniqueOrThrow({ where: { id: TA }, select: { passwordHash: true, status: true, mustChangePassword: true } });
  await assert.rejects(
    () => college.resetDepartmentStudentPassword(hodA(), { departmentId: ids.cse, studentId: LINKED }),
    refused(/not a student account/),
  );
  await assert.rejects(() => resetStudentLoginPassword(admin(), LINKED), refused(/not a student account/));
  await assert.rejects(() => setStudentLoginEnabled(admin(), LINKED, false), refused(/not a student account/));
  assert.deepEqual(
    await prisma.user.findUniqueOrThrow({ where: { id: TA }, select: { passwordHash: true, status: true, mustChangePassword: true } }),
    teacher,
  );
});

// ---------------------------------------------------------------------------
// The administrator's tools, face enrolment, the section
// ---------------------------------------------------------------------------

test("22. the administrator's tools work as before — and a password they issue is temporary too", { skip: SKIP }, async () => {
  // The Director admits from the department page the same way.
  const admitted = await college.createDepartmentStudent(admin(), physicsA(), newStudent("CSE130", "Dir", "Ector", "dir.ector@sa-it.test"));
  passwords.push(admitted.password);
  assert.equal((await accountOf(admitted.studentId))?.mustChangePassword, true);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: admitted.studentId, action: "student.created" } });
  assert.equal(audit.actorUserId, ADMIN);

  // Reset from the student's record.
  const { token } = await signIn("dir.ector@sa-it.test", admitted.password);
  const issued = await resetStudentLoginPassword(admin(), admitted.studentId);
  passwords.push(issued.password);
  assert.equal(await getSessionUserByRawToken(token), null);
  assert.equal((await signIn("dir.ector@sa-it.test", issued.password)).user.mustChangePassword, true);

  // Disable and enable.
  await setStudentLoginEnabled(admin(), admitted.studentId, false);
  assert.deepEqual(await loginService("dir.ector@sa-it.test", issued.password), { ok: false, reason: "account_inactive" });
  await setStudentLoginEnabled(admin(), admitted.studentId, true);
  await signIn("dir.ector@sa-it.test", issued.password);
  const actions = (
    await prisma.auditLog.findMany({ where: { entityId: (await accountOf(admitted.studentId))!.id }, orderBy: { createdAt: "asc" } })
  ).map((row) => row.action);
  assert.deepEqual(
    actions.filter((action) => action.startsWith("user.")),
    ["user.created", "user.updated", "user.deactivated", "user.reactivated"],
  );
});

test("23. the new student's face is enrolled from the department through the usual service", { skip: SKIP }, async () => {
  const image = Buffer.from("sa-it: a photograph of a face").toString("base64");
  const result = await college.enrollDepartmentStudentFace(
    hodA(),
    { departmentId: ids.cse, studentId: ids.riya, imageBase64: image, captureSource: "CAMERA" },
    "add",
    faceAi(7),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  const face = await college.getDepartmentStudent(hodA(), ids.cse, ids.riya);
  assert.deepEqual([face?.face.enrolled, face?.face.activeSamples], [true, 1]);
});

test("24. the new student is on their section's roster, where registers and recognition read it", { skip: SKIP }, async () => {
  const section = await college.getCourseSectionDetail(hodA(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyA });
  const codes = section?.students.map((row) => row.studentCode) ?? [];
  for (const code of ["CSE101", "CSE001"]) assert.ok(codes.includes(code), `${code} on the roster`);
});

test("25. no audit row carries a password or a hash; no row anywhere holds a password", { skip: SKIP }, async () => {
  const rows = await prisma.auditLog.findMany({ where: { institutionId: { in: INSTITUTIONS } } });
  assert.ok(rows.length > 0);
  const text = JSON.stringify(rows);
  for (const password of passwords) assert.ok(!text.includes(password), "a password reached the audit log");
  assert.ok(!text.includes("scrypt$"), "a hash reached the audit log");
  for (const password of passwords) assert.deepEqual(await tablesHolding(password), [], "a password is stored somewhere");
});
