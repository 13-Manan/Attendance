import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { SYSTEM_ROLES } from "@/modules/authorization/permissions";
import { getStudentDashboard } from "@/modules/attendance-analytics/service";
import { getRollup, normalizeFilters } from "@/modules/attendance-reporting/service";
import {
  getStudentLogin,
  provisionStudentLogin,
  resetStudentLoginPassword,
  setStudentLoginEnabled,
} from "@/modules/students/login-provisioning";
import { updateStudent } from "@/modules/students/service";
import { hashPassword } from "./password";
import {
  changeOwnPasswordService,
  getSessionUserByRawToken,
  loginService,
  loginWithStudentIdService,
  logoutService,
} from "./service";
import { STUDENT_LOGIN_THROTTLE, placeholderLoginEmail } from "./student-login-policy";

/**
 * Student accounts against the real database: signing in with a student ID,
 * several devices at once, a password changed or reset, a login disabled, a
 * student archived — and, throughout, that one student's account reaches that
 * student and nobody else.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 *
 * A school and a college each have a student coded "013", on purpose: a
 * student ID only means something within its institution.
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "stulogin-";
const SCHOOL = `${P}school`;
const COLLEGE = `${P}college`;
const id = (name: string) => `${P}${name}`;

const S = {
  a: id("s-a"), // 013, no email
  b: id("s-b"), // 014, with an email
  x: id("s-x"), // AB13, for case
  r: id("s-r"), // 015, archived and restored
  p: id("s-p"), // 016, password change and reset
  t: id("s-t"), // 017, throttled
  q: id("s-q"), // 018, archived, no login
  d: id("s-d"), // college 013
  e: id("s-e"), // college 020
};
const STAFF_EMAIL = `${P}staff@test.local`;
const STAFF_PASSWORD = "staff-password-1";

const password: Record<string, string> = {};

function admin(institutionId: string): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === "SCHOOL_ADMIN");
  assert.ok(role);
  return {
    userId: `${institutionId}-admin`,
    email: `${institutionId}-admin@test.local`,
    name: "Principal",
    institutionId,
    campusId: null,
    roles: [{ key: role.key, name: role.name, institutionId, campusId: null, permissions: role.permissions }],
  };
}
const SCHOOL_ADMIN = admin(SCHOOL);
const COLLEGE_ADMIN = admin(COLLEGE);

async function cleanup() {
  const institutions = { in: [SCHOOL, COLLEGE] };
  await prisma.attendanceRecord.deleteMany({ where: { institutionId: institutions } });
  await prisma.attendanceSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohortSubject.deleteMany({ where: { cohort: { institutionId: institutions } } });
  await prisma.subject.deleteMany({ where: { institutionId: institutions } });
  await prisma.enrollment.deleteMany({ where: { institutionId: institutions } });
  await prisma.student.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohort.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicUnit.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.user.deleteMany({ where: { institutionId: institutions } });
  await prisma.auditLog.deleteMany({ where: { institutionId: institutions } });
  await prisma.institution.deleteMany({ where: { id: institutions } });
}

async function student(institutionId: string, studentId: string, code: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  await prisma.student.create({
    data: { id: studentId, institutionId, studentCode: code, firstName: code, lastName: "Test", status },
  });
}

async function register(
  institutionId: string,
  sessionId: string,
  cohortId: string,
  day: number,
  results: Record<string, "PRESENT" | "ABSENT">,
  options: { status?: "FINALIZED" | "REVIEW"; cohortSubjectId?: string } = {},
) {
  await prisma.attendanceSession.create({
    data: {
      id: sessionId,
      institutionId,
      cohortId,
      cohortSubjectId: options.cohortSubjectId ?? null,
      facultyId: `${institutionId}-teacher`,
      sessionDate: new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`),
      startedAt: new Date(`2026-09-${String(day).padStart(2, "0")}T09:00:00.000Z`),
      status: options.status ?? "FINALIZED",
    },
  });
  await prisma.attendanceRecord.createMany({
    data: Object.entries(results).map(([studentId, result]) => ({
      id: `${sessionId}-${studentId}`,
      institutionId,
      sessionId,
      studentId,
      aiResult: result,
      finalResult: result,
    })),
  });
}

async function login(studentKey: keyof typeof S, institutionId: string, code: string) {
  const result = await loginWithStudentIdService(institutionId, code, password[studentKey]);
  assert.ok(result.ok, `${code} could not sign in: ${result.ok ? "" : result.reason}`);
  return result;
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: SCHOOL, name: "Login School", type: "SCHOOL" },
      { id: COLLEGE, name: "Login College", type: "COLLEGE" },
    ],
  });
  for (const institutionId of [SCHOOL, COLLEGE]) {
    await prisma.user.createMany({
      data: [
        { id: `${institutionId}-admin`, institutionId, email: `${institutionId}-admin@test.local`, name: "Principal", passwordHash: "x" },
        { id: `${institutionId}-teacher`, institutionId, email: `${institutionId}-teacher@test.local`, name: "Teacher", passwordHash: "x" },
      ],
    });
    await prisma.academicSession.create({
      data: {
        id: `${institutionId}-year`,
        institutionId,
        name: "2026-27",
        startDate: new Date("2026-06-01T00:00:00Z"),
        endDate: new Date("2027-05-31T00:00:00Z"),
        isCurrent: true,
      },
    });
    await prisma.academicUnit.create({
      data: { id: `${institutionId}-unit`, institutionId, kind: institutionId === SCHOOL ? "GRADE" : "DEPARTMENT", name: "Unit" },
    });
    await prisma.cohort.create({
      data: {
        id: `${institutionId}-cohort`,
        institutionId,
        academicUnitId: `${institutionId}-unit`,
        academicSessionId: `${institutionId}-year`,
        name: institutionId === SCHOOL ? "8-A" : "CSE-1",
      },
    });
  }
  await prisma.user.create({
    data: {
      id: id("staff"),
      institutionId: SCHOOL,
      email: STAFF_EMAIL,
      name: "Staff",
      passwordHash: await hashPassword(STAFF_PASSWORD),
    },
  });

  await student(SCHOOL, S.a, "013");
  await student(SCHOOL, S.b, "014");
  await student(SCHOOL, S.x, "AB13");
  await student(SCHOOL, S.r, "015");
  await student(SCHOOL, S.p, "016");
  await student(SCHOOL, S.t, "017");
  await student(SCHOOL, S.q, "018", "INACTIVE");
  await student(COLLEGE, S.d, "013");
  await student(COLLEGE, S.e, "020");
  await prisma.enrollment.createMany({
    data: [
      { institutionId: SCHOOL, studentId: S.a, cohortId: `${SCHOOL}-cohort` },
      { institutionId: SCHOOL, studentId: S.b, cohortId: `${SCHOOL}-cohort` },
      { institutionId: COLLEGE, studentId: S.d, cohortId: `${COLLEGE}-cohort` },
      { institutionId: COLLEGE, studentId: S.e, cohortId: `${COLLEGE}-cohort` },
    ],
  });

  // Logins, through the same service the principal's button calls.
  for (const [key, email] of [["a", undefined], ["b", `${P}b@test.local`], ["x", undefined], ["r", undefined], ["p", undefined], ["t", undefined]] as const) {
    password[key] = (await provisionStudentLogin(SCHOOL_ADMIN, S[key], { email })).password;
  }
  for (const key of ["d", "e"] as const) {
    password[key] = (await provisionStudentLogin(COLLEGE_ADMIN, S[key], {})).password;
  }

  // School: four confirmed days and one still in review. A: 3 of 4. B: 2 of 4.
  const cohort = `${SCHOOL}-cohort`;
  await register(SCHOOL, id("day1"), cohort, 10, { [S.a]: "PRESENT", [S.b]: "ABSENT" });
  await register(SCHOOL, id("day2"), cohort, 11, { [S.a]: "PRESENT", [S.b]: "ABSENT" });
  await register(SCHOOL, id("day3"), cohort, 12, { [S.a]: "ABSENT", [S.b]: "PRESENT" });
  await register(SCHOOL, id("day4"), cohort, 13, { [S.a]: "PRESENT", [S.b]: "PRESENT" });
  await register(SCHOOL, id("day5"), cohort, 14, { [S.a]: "PRESENT", [S.b]: "ABSENT" }, { status: "REVIEW" });
  await register(SCHOOL, id("r-day"), cohort, 15, { [S.r]: "PRESENT" });

  // College: Maths 2 of 3 and Physics 1 of 1 for D; E absent throughout.
  await prisma.subject.createMany({
    data: [
      { id: id("maths"), institutionId: COLLEGE, name: "Mathematics", code: "MA1" },
      { id: id("physics"), institutionId: COLLEGE, name: "Physics", code: "PH1" },
    ],
  });
  await prisma.cohortSubject.createMany({
    data: [
      { id: id("cs-maths"), cohortId: `${COLLEGE}-cohort`, subjectId: id("maths") },
      { id: id("cs-physics"), cohortId: `${COLLEGE}-cohort`, subjectId: id("physics") },
    ],
  });
  const ccohort = `${COLLEGE}-cohort`;
  await register(COLLEGE, id("m1"), ccohort, 10, { [S.d]: "PRESENT", [S.e]: "ABSENT" }, { cohortSubjectId: id("cs-maths") });
  await register(COLLEGE, id("m2"), ccohort, 11, { [S.d]: "PRESENT", [S.e]: "ABSENT" }, { cohortSubjectId: id("cs-maths") });
  await register(COLLEGE, id("m3"), ccohort, 12, { [S.d]: "ABSENT", [S.e]: "ABSENT" }, { cohortSubjectId: id("cs-maths") });
  await register(COLLEGE, id("p1"), ccohort, 12, { [S.d]: "PRESENT", [S.e]: "ABSENT" }, { cohortSubjectId: id("cs-physics") });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

test("a student signs in with their student ID, within their school, and reaches only themselves", { skip: SKIP }, async () => {
  const result = await login("a", SCHOOL, "013");
  const sessionUser = await getSessionUserByRawToken(result.ok ? result.rawToken : "");
  assert.ok(sessionUser);
  assert.deepEqual(sessionUser.roles.map((role) => role.key), ["STUDENT"]);
  const dashboard = await getStudentDashboard(sessionUser);
  assert.equal(dashboard?.studentId, S.a);
});

test("the same ID at another institution is another student", { skip: SKIP }, async () => {
  // School student A's password does not open college student D, though both are "013".
  const crossed = await loginWithStudentIdService(COLLEGE, "013", password.a);
  assert.deepEqual(crossed, { ok: false, reason: "invalid_credentials" });
  const d = await login("d", COLLEGE, "013");
  const sessionUser = await getSessionUserByRawToken(d.ok ? d.rawToken : "");
  assert.equal((await getStudentDashboard(sessionUser!))?.studentId, S.d);
});

test("a wrong password and an unknown ID are refused alike", { skip: SKIP }, async () => {
  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "013", "not-the-password"), {
    ok: false,
    reason: "invalid_credentials",
  });
  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "999", password.a), {
    ok: false,
    reason: "invalid_credentials",
  });
});

test("an ID is matched whatever its case", { skip: SKIP }, async () => {
  await login("x", SCHOOL, "ab13");
});

test("a placeholder address is not a way in; a student's real address still is", { skip: SKIP }, async () => {
  assert.deepEqual(await loginService(placeholderLoginEmail(S.a), password.a), {
    ok: false,
    reason: "invalid_credentials",
  });
  assert.ok((await loginService(`${P}b@test.local`, password.b)).ok, "email sign-in for B");
  await login("b", SCHOOL, "014");
});

test("staff sign in with their email exactly as before", { skip: SKIP }, async () => {
  const result = await loginService(STAFF_EMAIL, STAFF_PASSWORD);
  assert.ok(result.ok);
  assert.deepEqual(await loginService(STAFF_EMAIL, "wrong"), { ok: false, reason: "invalid_credentials" });
});

// ---------------------------------------------------------------------------
// Several devices
// ---------------------------------------------------------------------------

test("several devices stay signed in side by side, each seeing the same student", { skip: SKIP }, async () => {
  const phone = await login("a", SCHOOL, "013");
  const laptop = await login("a", SCHOOL, "013");
  const onPhone = await getSessionUserByRawToken(phone.ok ? phone.rawToken : "");
  const onLaptop = await getSessionUserByRawToken(laptop.ok ? laptop.rawToken : "");
  assert.ok(onPhone && onLaptop);
  assert.equal((await getStudentDashboard(onPhone))?.overall.percentage, 75);
  assert.equal((await getStudentDashboard(onLaptop))?.overall.percentage, 75);

  // Signing out one device leaves the other signed in.
  await logoutService(phone.ok ? phone.rawToken : "");
  assert.equal(await getSessionUserByRawToken(phone.ok ? phone.rawToken : ""), null);
  assert.ok(await getSessionUserByRawToken(laptop.ok ? laptop.rawToken : ""));
});

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

test("changing the password keeps this device, signs the others out, and only the new one works", { skip: SKIP }, async () => {
  const here = await login("p", SCHOOL, "016");
  const elsewhere = await login("p", SCHOOL, "016");
  const userId = (await getSessionUserByRawToken(here.ok ? here.rawToken : ""))!.userId;

  assert.deepEqual(
    await changeOwnPasswordService(userId, here.ok ? here.rawToken : "", {
      current: "wrong",
      next: "a-brand-new-one-1",
      confirm: "a-brand-new-one-1",
    }),
    { ok: false, error: "The current password is not correct." },
  );
  const mismatch = await changeOwnPasswordService(userId, here.ok ? here.rawToken : "", {
    current: password.p,
    next: "a-brand-new-one-1",
    confirm: "something-else-1",
  });
  assert.equal(mismatch.ok, false);

  const changed = await changeOwnPasswordService(userId, here.ok ? here.rawToken : "", {
    current: password.p,
    next: "a-brand-new-one-1",
    confirm: "a-brand-new-one-1",
  });
  assert.deepEqual(changed, { ok: true, otherSessionsEnded: 1 });
  assert.ok(await getSessionUserByRawToken(here.ok ? here.rawToken : ""), "this device stays signed in");
  assert.equal(await getSessionUserByRawToken(elsewhere.ok ? elsewhere.rawToken : ""), null, "the other is signed out");

  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "016", password.p), {
    ok: false,
    reason: "invalid_credentials",
  });
  password.p = "a-brand-new-one-1";
  await login("p", SCHOOL, "016");
});

test("an administrator's reset issues a new password once and ends every session", { skip: SKIP }, async () => {
  const before = await login("p", SCHOOL, "016");
  const issued = await resetStudentLoginPassword(SCHOOL_ADMIN, S.p);
  assert.ok(issued.password.length >= 16);
  assert.equal(await getSessionUserByRawToken(before.ok ? before.rawToken : ""), null);
  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "016", password.p), {
    ok: false,
    reason: "invalid_credentials",
  });
  password.p = issued.password;
  await login("p", SCHOOL, "016");

  // What the principal's panel reads: the ID and the state, never a password.
  const account = await getStudentLogin(SCHOOL_ADMIN, S.p);
  assert.equal(account?.loginId, "016");
  assert.equal(account?.email, null);
  assert.ok(account?.lastLoginAt);
  assert.ok(!JSON.stringify(account).includes(issued.password));
  assert.ok(!JSON.stringify(account).includes("scrypt$"));
});

test("repeated failures throttle a student ID, even for the right password", { skip: SKIP }, async () => {
  for (let attempt = 0; attempt < STUDENT_LOGIN_THROTTLE.maxFailures; attempt++) {
    const result = await loginWithStudentIdService(SCHOOL, "017", `guess-${attempt}`);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "017", password.t), {
    ok: false,
    reason: "throttled",
  });
  // Another student's account is unaffected.
  await login("x", SCHOOL, "AB13");
});

// ---------------------------------------------------------------------------
// The account's life
// ---------------------------------------------------------------------------

test("disabling a login ends every session and refuses sign-in; enabling restores it", { skip: SKIP }, async () => {
  const signedIn = await login("b", SCHOOL, "014");
  await setStudentLoginEnabled(SCHOOL_ADMIN, S.b, false);
  assert.equal(await getSessionUserByRawToken(signedIn.ok ? signedIn.rawToken : ""), null);
  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "014", password.b), {
    ok: false,
    reason: "account_inactive",
  });
  assert.equal((await getStudentLogin(SCHOOL_ADMIN, S.b))?.status, "INACTIVE");

  await setStudentLoginEnabled(SCHOOL_ADMIN, S.b, true);
  await login("b", SCHOOL, "014");
});

test("archiving a student ends their sessions and blocks sign-in; history stays; restoring lets them back in", { skip: SKIP }, async () => {
  const signedIn = await login("r", SCHOOL, "015");
  const token = signedIn.ok ? signedIn.rawToken : "";

  await updateStudent(SCHOOL_ADMIN, { studentId: S.r, status: "INACTIVE" });
  assert.equal(await getSessionUserByRawToken(token), null, "the open session stops at once");
  assert.deepEqual(await loginWithStudentIdService(SCHOOL, "015", password.r), {
    ok: false,
    reason: "account_inactive",
  });
  assert.equal(await prisma.attendanceRecord.count({ where: { studentId: S.r } }), 1, "attendance kept");
  assert.equal((await getStudentLogin(SCHOOL_ADMIN, S.r))?.studentOnRoll, false);

  await updateStudent(SCHOOL_ADMIN, { studentId: S.r, status: "ACTIVE" });
  assert.equal(await getSessionUserByRawToken(token), null, "an old session does not wake up");
  await login("r", SCHOOL, "015");
});

test("a login is not created for a student who is not on roll", { skip: SKIP }, async () => {
  await assert.rejects(() => provisionStudentLogin(SCHOOL_ADMIN, S.q, {}), /not on roll/);
  // …nor for another institution's student.
  await assert.rejects(() => provisionStudentLogin(SCHOOL_ADMIN, S.e, {}), /not in this institution/);
});

// ---------------------------------------------------------------------------
// Attendance: the student's own, by the same rules as everyone else's
// ---------------------------------------------------------------------------

test("a school student's figures: finalized days only, their own records only", { skip: SKIP }, async () => {
  const a = await login("a", SCHOOL, "013");
  const b = await login("b", SCHOOL, "014");
  const aUser = await getSessionUserByRawToken(a.ok ? a.rawToken : "");
  const bUser = await getSessionUserByRawToken(b.ok ? b.rawToken : "");
  const aView = await getStudentDashboard(aUser!);
  const bView = await getStudentDashboard(bUser!);
  // The day still in review is in neither numerator nor denominator.
  assert.deepEqual(aView?.overall, { present: 3, absent: 1, total: 4, percentage: 75 });
  assert.deepEqual(bView?.overall, { present: 2, absent: 2, total: 4, percentage: 50 });
  assert.equal(aView?.attendanceMode, "DAILY");
  assert.deepEqual(
    aView?.daily.map((day) => day.result),
    ["PRESENT", "ABSENT", "PRESENT", "PRESENT"],
    "most recent first, and none of B's",
  );
});

test("the portal's percentage is the admin report's percentage", { skip: SKIP }, async () => {
  const a = await login("a", SCHOOL, "013");
  const view = await getStudentDashboard((await getSessionUserByRawToken(a.ok ? a.rawToken : ""))!);
  const filters = normalizeFilters({ from: "2026-09-01", to: "2026-09-30" }, new Date("2026-09-26T12:00:00Z"));
  const report = await getRollup(SCHOOL_ADMIN, "student", filters, { page: 1, pageSize: 50 });
  const row = report.rows.find((candidate) => candidate.key === S.a);
  assert.ok(row, "A is on the report");
  assert.deepEqual(row.rate, view?.overall);
});

test("a college student sees subject-wise attendance, from their own records only", { skip: SKIP }, async () => {
  const d = await login("d", COLLEGE, "013");
  const view = await getStudentDashboard((await getSessionUserByRawToken(d.ok ? d.rawToken : ""))!);
  assert.equal(view?.attendanceMode, "SUBJECT_WISE");
  assert.deepEqual(view?.overall, { present: 3, absent: 1, total: 4, percentage: 75 });
  const bySubject = Object.fromEntries(
    (view?.subjects ?? []).map((subject) => [subject.subjectName, subject.rate]),
  );
  assert.deepEqual(bySubject, {
    Mathematics: { present: 2, absent: 1, total: 3, percentage: 66.7 },
    Physics: { present: 1, absent: 0, total: 1, percentage: 100 },
  });
});

// ---------------------------------------------------------------------------
// Nothing secret is written down
// ---------------------------------------------------------------------------

test("no audit row carries a password, a hash or a session token", { skip: SKIP }, async () => {
  const rows = await prisma.auditLog.findMany({ where: { institutionId: { in: [SCHOOL, COLLEGE] } } });
  assert.ok(rows.length > 0);
  const text = JSON.stringify(rows);
  for (const secret of [...Object.values(password), STAFF_PASSWORD, "a-brand-new-one-1"]) {
    assert.ok(!text.includes(secret), "a password reached the audit log");
  }
  assert.ok(!text.includes("scrypt$"), "a password hash reached the audit log");
  const tokens = await prisma.session.findMany({
    where: { user: { institutionId: { in: [SCHOOL, COLLEGE] } } },
    select: { tokenHash: true },
  });
  for (const { tokenHash } of tokens) {
    assert.ok(!text.includes(tokenHash), "a session token hash reached the audit log");
  }
  // What the changes did write: the facts, without the values.
  const changed = rows.find((row) => JSON.stringify(row.afterJson).includes("passwordChanged"));
  assert.ok(changed, "the password change was audited");
});
