import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hashPassword } from "@/modules/auth-tenancy/password";
import { changeOwnPasswordService, getSessionUserByRawToken, loginService } from "@/modules/auth-tenancy/service";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { assignRole } from "@/modules/authorization/role-management";
import { ForbiddenError } from "@/modules/authorization/types";
import { listApiKeys } from "@/modules/api-credentials/service";
import { searchAuditLogs } from "@/modules/audit/search";
import { startOrResumeCaptureSession } from "@/modules/attendance-capture/service";
import { getOverview } from "@/modules/attendance-reporting/service";
import { applyReviewDecision, generateAttendanceCandidates, getAttendanceReviewBoard } from "@/modules/attendance-review/service";
import { enrollFaceForStudentRequest } from "@/modules/face-enrollment/service";
import {
  deactivateFaculty,
  getFacultyDirectory,
  inviteFaculty,
  reactivateFaculty,
  resetFacultyPassword,
} from "@/modules/faculty/directory-service";
import { deleteStudentFaceData } from "@/modules/privacy/service";
import { mayWatchRegister } from "@/modules/realtime/stream-access";
import { revealStudentPassword } from "@/modules/student-password-reveal/service";
import {
  assignStudentToClassForRequest,
  createStudentForRequest,
  getStudentForRequest,
  setStudentStatusForRequest,
} from "@/modules/students/directory-service";
import { provisionStudentLogin } from "@/modules/students/login-provisioning";
import { canReviewTwinConfirmations } from "@/modules/twin-confirmation/service";
import type { EnrollResponse, ModelInfoResponse } from "@attendance/shared-types";
import { defaultAccess, permissionsFor, receptionistRoleKey } from "./catalog.ts";
import {
  createReceptionist,
  getReceptionist,
  listReceptionists,
  resetReceptionistPassword,
  setReceptionistAccess,
  setReceptionistActive,
  updateReceptionist,
} from "./service.ts";
import { ReceptionistError } from "./types.ts";

/**
 * School receptionists, against the real database, with real sessions.
 *
 * Every actor here signs in through `loginService` and is re-read from their
 * session for each step (`me()`), exactly as a request does — so "the
 * principal turned it off" is proved against the session the receptionist
 * already holds, not a fresh one. Only face-ai is replaced, by a stand-in.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "rcp-";
const S1 = `${P}school-1`;
const S2 = `${P}school-2`;
const C1 = `${P}college-1`;
const INSTITUTIONS = [S1, S2, C1];
const KEY = randomBytes(32).toString("base64");
const previousKey = process.env.STUDENT_PASSWORD_ENCRYPTION_KEY;
const PASSWORD = "Rcp-test-password-1";

const ids = {
  principal1: `${P}principal-1`,
  principal2: `${P}principal-2`,
  collegeAdmin: `${P}college-admin`,
  teacher1: `${P}teacher-1`,
  class1: `${P}s1-8a`,
  class1b: `${P}s1-8b`,
  class2: `${P}s2-8a`,
  student1: `${P}s1-student`,
  student2: `${P}s2-student`,
};

const MODEL: ModelInfoResponse = {
  modelName: "rcp-model",
  modelVersion: "1+pp1",
  weightsVersion: "1+pp1",
  preprocessingVersion: "1",
  embeddingDim: 128,
  embeddingNormalized: true,
  runtime: "test",
  commercialUse: "permitted",
  productionEligible: true,
  contractVersion: "v1",
  calibration: { id: "rcp-identity", knots: [{ raw: -1, calibrated: -1 }, { raw: 1, calibrated: 1 }], rawAmbiguityMargin: 0.05 },
};

/** One face per number; each sample leans slightly off it, so samples of one face match each other. */
function faceAi(face: number, sample = 0) {
  const v = new Array<number>(128).fill(0);
  v[face] = 1;
  v[100 + sample] = 0.15;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  const response: EnrollResponse = {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: v,
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    embeddingDim: 128,
    weightsVersion: MODEL.weightsVersion,
    preprocessingVersion: MODEL.preprocessingVersion,
    aligned: true,
  };
  return { faceModelInfo: async () => MODEL, faceEnroll: async () => response };
}

async function cleanup() {
  const institutions = { in: INSTITUTIONS };
  const users = await prisma.user.findMany({ where: { institutionId: institutions }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await prisma.attendanceCorrection.deleteMany({ where: { attendanceRecord: { institutionId: institutions } } });
  await prisma.attendanceRecord.deleteMany({ where: { institutionId: institutions } });
  await prisma.attendanceSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.faceEmbedding.deleteMany({ where: { institutionId: institutions } });
  await prisma.recoverableStudentPassword.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.enrollment.deleteMany({ where: { institutionId: institutions } });
  await prisma.student.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: { institutionId: institutions } } });
  await prisma.cohort.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicUnit.deleteMany({ where: { institutionId: institutions } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRoleAssignment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.role.deleteMany({ where: { institutionId: institutions } });
  await prisma.auditLog.deleteMany({ where: { institutionId: institutions } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.institution.deleteMany({ where: { id: institutions } });
}

async function staff(id: string, institutionId: string, roleKey: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await prisma.user.create({
    data: {
      id,
      institutionId,
      email: `${id}@rcp.test`,
      name: id,
      passwordHash: await hashPassword(PASSWORD),
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

/** Signs in, and returns the session as each later request would read it. */
async function signIn(email: string, password: string): Promise<{ token: string; me: () => Promise<SessionUser> }> {
  const result = await loginService(email, password);
  if (!result.ok) throw new Error(`sign-in refused for ${email}: ${result.reason}`);
  return {
    token: result.rawToken,
    me: async () => {
      const user = await getSessionUserByRawToken(result.rawToken);
      if (!user) throw new Error("session no longer usable");
      return user;
    },
  };
}

let principal1: () => Promise<SessionUser>;
let principal2: () => Promise<SessionUser>;
let collegeAdmin: () => Promise<SessionUser>;
let teacher1: () => Promise<SessionUser>;

before(async () => {
  if (SKIP) return;
  process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = KEY;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: S1, name: "Receptionist School", type: "SCHOOL" },
      { id: S2, name: "Other School", type: "SCHOOL" },
      { id: C1, name: "Some College", type: "COLLEGE" },
    ],
  });
  for (const school of [S1, S2]) {
    await prisma.academicSession.create({
      data: { id: `${school}-year`, institutionId: school, name: "2026-27", startDate: new Date("2026-04-01Z"), endDate: new Date("2027-03-31Z"), isCurrent: true },
    });
    await prisma.academicUnit.create({ data: { id: `${school}-grade`, institutionId: school, kind: "GRADE", name: "Grade 8" } });
  }
  const cohort = (id: string, institutionId: string, name: string) =>
    prisma.cohort.create({ data: { id, institutionId, academicUnitId: `${institutionId}-grade`, academicSessionId: `${institutionId}-year`, name } });
  await cohort(ids.class1, S1, "8A");
  await cohort(ids.class1b, S1, "8B");
  await cohort(ids.class2, S2, "8A");

  await staff(ids.principal1, S1, "SCHOOL_ADMIN");
  await staff(ids.principal2, S2, "SCHOOL_ADMIN");
  await staff(ids.collegeAdmin, C1, "COLLEGE_ADMIN");
  await staff(ids.teacher1, S1, "CLASS_TEACHER");
  await prisma.cohortFaculty.create({ data: { cohortId: ids.class1, userId: ids.teacher1 } });

  for (const [id, institutionId, cohortId] of [
    [ids.student1, S1, ids.class1],
    [ids.student2, S2, ids.class2],
  ] as const) {
    await prisma.student.create({ data: { id, institutionId, studentCode: id, firstName: "Asha", lastName: id } });
    await prisma.enrollment.create({ data: { institutionId, studentId: id, cohortId } });
  }

  principal1 = (await signIn(`${ids.principal1}@rcp.test`, PASSWORD)).me;
  principal2 = (await signIn(`${ids.principal2}@rcp.test`, PASSWORD)).me;
  collegeAdmin = (await signIn(`${ids.collegeAdmin}@rcp.test`, PASSWORD)).me;
  teacher1 = (await signIn(`${ids.teacher1}@rcp.test`, PASSWORD)).me;
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  if (previousKey === undefined) delete process.env.STUDENT_PASSWORD_ENCRYPTION_KEY;
  else process.env.STUDENT_PASSWORD_ENCRYPTION_KEY = previousKey;
  await prisma.$disconnect();
});

let made = 0;
/** A receptionist, signed in and past their first password change. */
async function receptionist(access?: string[]) {
  const email = `${P}desk-${++made}@rcp.test`;
  const created = await createReceptionist(await principal1(), { name: `Desk ${made}`, email, phone: "+91 98765 43210" });
  if (access) await setReceptionistAccess(await principal1(), created.receptionist.id, access);
  const first = await signIn(email, created.password);
  const changed = await changeOwnPasswordService(created.receptionist.id, first.token, {
    current: created.password,
    next: PASSWORD,
    confirm: PASSWORD,
  });
  assert.equal(changed.ok, true, "first password change");
  return { id: created.receptionist.id, email, session: first, me: first.me };
}

const refused = (reason?: string) => (error: unknown) =>
  error instanceof ForbiddenError && (reason === undefined || error.reason === reason);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

test("the principal creates a receptionist: one account in their school, its own role, the everyday access, a temporary password never stored readable", { skip: SKIP }, async () => {
  const created = await createReceptionist(await principal1(), {
    name: "Meera Front Desk",
    email: "  Meera.Desk@RCP.test ",
    phone: "+91 90000 11111",
  });
  assert.ok(created.password.length >= 16);
  assert.deepEqual(created.receptionist.access, defaultAccess());
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: created.receptionist.id },
    include: { roleAssignments: { include: { role: { include: { permissions: true } } } } },
  });
  assert.deepEqual([user.institutionId, user.email, user.status, user.mustChangePassword], [S1, "meera.desk@rcp.test", "ACTIVE", true]);
  assert.ok(user.passwordHash?.startsWith("scrypt$") && !user.passwordHash.includes(created.password));
  assert.equal(user.roleAssignments.length, 1, "exactly one role");
  const role = user.roleAssignments[0].role;
  assert.deepEqual([role.key, role.institutionId, role.isSystem], [receptionistRoleKey(user.id), S1, false]);
  assert.deepEqual(role.permissions.map((p) => p.permission).sort(), permissionsFor(defaultAccess()));
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: user.id, action: "receptionist.created" } });
  assert.equal(audit.actorUserId, ids.principal1);
  const written = JSON.stringify(audit);
  assert.ok(!written.includes(created.password) && !written.includes("scrypt$"), "no password, no hash in the audit row");
  const listed = await listReceptionists(await principal1());
  assert.ok(listed.some((r) => r.id === user.id && r.phone === "+91 90000 11111"));
});

test("an address already in use — in this school or any other — is refused", { skip: SKIP }, async () => {
  for (const email of [`${ids.teacher1}@rcp.test`, `${ids.principal2}@rcp.test`, "meera.desk@rcp.test"]) {
    await assert.rejects(
      async () => createReceptionist(await principal1(), { name: "Copy", email }),
      (e: unknown) => e instanceof ReceptionistError && /already uses/.test(e.message),
      email,
    );
  }
});

test("sign-in works; the temporary password must be replaced first; then only the new one works", { skip: SKIP }, async () => {
  const email = `${P}first-day@rcp.test`;
  const created = await createReceptionist(await principal1(), { name: "First Day", email });
  const first = await signIn(email, created.password);
  assert.equal((await first.me()).mustChangePassword, true, "the temporary password must be replaced");
  const changed = await changeOwnPasswordService(created.receptionist.id, first.token, { current: created.password, next: PASSWORD, confirm: PASSWORD });
  assert.equal(changed.ok, true);
  assert.equal((await first.me()).mustChangePassword, false);
  assert.equal((await loginService(email, created.password)).ok, false, "the temporary one stopped working");
  assert.equal((await loginService(email, PASSWORD)).ok, true);
});

test("switched off: refused at sign-in and signed out everywhere at once; switched on: back in", { skip: SKIP }, async () => {
  const r = await receptionist();
  await setReceptionistActive(await principal1(), r.id, false);
  assert.equal(await getSessionUserByRawToken(r.session.token), null, "the open session ended");
  const attempt = await loginService(r.email, PASSWORD);
  assert.deepEqual(attempt.ok ? "signed in" : attempt.reason, "account_inactive");
  await setReceptionistActive(await principal1(), r.id, true);
  assert.equal((await loginService(r.email, PASSWORD)).ok, true);
  const actions = await prisma.auditLog.findMany({ where: { entityId: r.id, action: { in: ["receptionist.disabled", "receptionist.enabled"] } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(actions.map((a) => a.action), ["receptionist.disabled", "receptionist.enabled"]);
});

test("a reset issues a new temporary password, ends every session, and forces a change at next sign-in", { skip: SKIP }, async () => {
  const r = await receptionist();
  const issued = await resetReceptionistPassword(await principal1(), r.id);
  assert.equal(issued.email, r.email);
  assert.equal(await getSessionUserByRawToken(r.session.token), null);
  assert.equal((await loginService(r.email, PASSWORD)).ok, false, "the old password stopped working");
  const again = await signIn(r.email, issued.password);
  assert.equal((await again.me()).mustChangePassword, true);
  const row = await prisma.auditLog.findFirstOrThrow({ where: { entityId: r.id, action: "receptionist.password_reset" } });
  assert.ok(!JSON.stringify(row).includes(issued.password));
});

test("the principal edits the name and phone; the email stays what they sign in with", { skip: SKIP }, async () => {
  const r = await receptionist();
  const updated = await updateReceptionist(await principal1(), r.id, { name: "Desk Renamed", phone: "" });
  assert.deepEqual([updated.name, updated.phone, updated.email], ["Desk Renamed", null, r.email]);
  assert.equal((await getReceptionist(await principal1(), r.id)).phone, null);
});

// ---------------------------------------------------------------------------
// Permissions: what each switch opens, on the server, and when it changes
// ---------------------------------------------------------------------------

test("each switch opens its own feature on the server, and switching it off closes it on the receptionist's next request", { skip: SKIP }, async () => {
  const r = await receptionist();
  // Student directory.
  assert.equal((await getStudentForRequest(await r.me(), ids.student1)).id, ids.student1);
  // Portal login, then seeing its password.
  await provisionStudentLogin(await r.me(), ids.student1, { email: `${P}asha@rcp.test` });
  const shown = await revealStudentPassword(await r.me(), ids.student1);
  assert.equal(shown.status, "revealed");

  await setReceptionistAccess(await principal1(), r.id, defaultAccess().filter((id) => id !== "students.passwords"));
  // The same session — no new sign-in — is refused now.
  const hidden = await revealStudentPassword(await r.me(), ids.student1);
  assert.notEqual(hidden.status, "revealed");

  await setReceptionistAccess(await principal1(), r.id, ["students.directory"]);
  await assert.rejects(async () => assignStudentToClassForRequest(await r.me(), { studentId: ids.student1, cohortId: ids.class1b }), refused("enrollment.manage"));
  await assert.rejects(async () => setStudentStatusForRequest(await r.me(), ids.student1, "INACTIVE"), refused());
  await assert.rejects(async () =>
    createStudentForRequest(await r.me(), { studentCode: `${P}new`, firstName: "N", lastName: "S", email: "", phone: "", campusId: "", admissionNumber: "", admissionDate: "" }),
    refused("student.create"),
  );
  await assert.rejects(async () => startOrResumeCaptureSession(await r.me(), { cohortId: ids.class1 }), refused());

  await setReceptionistAccess(await principal1(), r.id, []);
  await assert.rejects(async () => getStudentForRequest(await r.me(), ids.student1), refused("student.read"));
});

test("with the student switches on, a receptionist admits, edits, places and archives students", { skip: SKIP }, async () => {
  const r = await receptionist();
  const admitted = await createStudentForRequest(await r.me(), {
    studentCode: `${P}admit-1`,
    firstName: "Ravi",
    lastName: "New",
    email: "",
    phone: "",
    campusId: "",
    admissionNumber: "",
    admissionDate: "",
    cohortId: ids.class1,
  });
  await assignStudentToClassForRequest(await r.me(), { studentId: admitted.id, cohortId: ids.class1b });
  await setStudentStatusForRequest(await r.me(), admitted.id, "INACTIVE");
  const row = await prisma.student.findUniqueOrThrow({ where: { id: admitted.id } });
  assert.deepEqual([row.institutionId, row.status], [S1, "INACTIVE"]);
  const audit = await prisma.auditLog.count({ where: { entityId: admitted.id, actorUserId: r.id } });
  assert.ok(audit >= 2, "the existing student events record the receptionist as the actor");
});

// ---------------------------------------------------------------------------
// Faces and twins
// ---------------------------------------------------------------------------

test("with face enrollment a receptionist enrols a student — camera or upload — through the same service; without it, refused; erasure stays the principal's", { skip: SKIP }, async () => {
  const r = await receptionist();
  const camera = await enrollFaceForStudentRequest(await r.me(), { studentId: ids.student1, imageBase64: "AAAA", captureSource: "CAMERA" }, faceAi(10, 0));
  assert.equal(camera.ok, true, camera.ok ? "" : camera.reason);
  // A staff member may upload a photograph; only a student's own enrolment is camera-only.
  const upload = await enrollFaceForStudentRequest(await r.me(), { studentId: ids.student1, imageBase64: "AAAB", captureSource: "UPLOAD" }, faceAi(10, 1));
  assert.equal(upload.ok, true, upload.ok ? "" : upload.reason);
  await assert.rejects(async () => deleteStudentFaceData(await r.me(), ids.student1), refused("faceEmbedding.manage"));
  // Another school's student: refused, whether as a thrown denial or a returned refusal.
  const elsewhere = await enrollFaceForStudentRequest(await r.me(), { studentId: ids.student2, imageBase64: "AAAC", captureSource: "CAMERA" }, faceAi(12)).catch(
    (e: unknown) => (e instanceof ForbiddenError ? ({ ok: false, reason: "cross_institution" } as const) : Promise.reject(e)),
  );
  assert.equal(elsewhere.ok, false, "another school's student");
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: ids.student2 } }), 0);

  await setReceptionistAccess(await principal1(), r.id, defaultAccess().filter((id) => id !== "students.faces"));
  await assert.rejects(async () =>
    enrollFaceForStudentRequest(await r.me(), { studentId: ids.student1, imageBase64: "AAAD", captureSource: "CAMERA" }, faceAi(10, 2)),
    refused("faceEmbedding.manage"),
  );
});

test("twin and lookalike decisions are their own switch: enrolling faces does not allow them", { skip: SKIP }, async () => {
  const r = await receptionist();
  assert.equal(await canReviewTwinConfirmations(await r.me()), false, "off by default");
  await setReceptionistAccess(await principal1(), r.id, [...defaultAccess(), "students.twins"]);
  assert.equal(await canReviewTwinConfirmations(await r.me()), true);
});

// ---------------------------------------------------------------------------
// Attendance and reports
// ---------------------------------------------------------------------------

test("with attendance on, a receptionist takes any class's register; reviewing and correcting is its own switch; the class teacher is unchanged", { skip: SKIP }, async () => {
  const r = await receptionist();
  // 8A is the class teacher's class; the receptionist teaches nothing anywhere.
  const started = await startOrResumeCaptureSession(await r.me(), { cohortId: ids.class1 });
  assert.equal(started.session.cohortId, ids.class1);
  await generateAttendanceCandidates(await r.me(), { sessionId: started.session.id, recognition: null });
  const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { sessionId: started.session.id } });
  await applyReviewDecision(await r.me(), { attendanceRecordId: record.id, newResult: "PRESENT" });
  const reviewing = await getAttendanceReviewBoard(await r.me(), started.session.id);
  assert.equal(reviewing.actorCanCorrect && reviewing.actorCanFinalize, true, "the board offers decisions");
  // Reviewing without taking: decisions still go through; a new register is refused.
  await setReceptionistAccess(await principal1(), r.id, defaultAccess().filter((id) => id !== "attendance.take"));
  await applyReviewDecision(await r.me(), { attendanceRecordId: record.id, newResult: "ABSENT" });
  await assert.rejects(async () => startOrResumeCaptureSession(await r.me(), { cohortId: ids.class1 }), refused("attendanceSession.create"));
  // Without reviewing, correcting is refused — and taking is off with it.
  const narrowed = await setReceptionistAccess(
    await principal1(),
    r.id,
    defaultAccess().filter((id) => id !== "attendance.review" && id !== "attendance.take"),
  );
  assert.ok(!narrowed.access.includes("attendance.take") && !narrowed.access.includes("attendance.review"));
  // Records and reports only: the register opens read-only — no decision a refusal would answer.
  const reading = await getAttendanceReviewBoard(await r.me(), started.session.id);
  assert.equal(reading.actorCanCorrect, false);
  assert.equal(reading.actorCanFinalize, false);
  await assert.rejects(
    async () => applyReviewDecision(await r.me(), { attendanceRecordId: record.id, newResult: "PRESENT" }),
    refused("attendanceRecord.correct"),
  );
  // Asked for taking alone, the server switches on what it needs — never a register its taker cannot finish.
  const asked = await setReceptionistAccess(await principal1(), r.id, ["attendance.take"]);
  assert.deepEqual(asked.access, ["attendance.take", "attendance.review", "reports.attendance"]);
  await assert.rejects(async () => startOrResumeCaptureSession(await r.me(), { cohortId: ids.class2 }), refused(), "another school's class");
  // The class teacher still reaches only their own class.
  await assert.rejects(async () => startOrResumeCaptureSession(await teacher1(), { cohortId: ids.class1b }), refused("not_cohort_faculty"));
});

test("an open register stream is asked again: it outlasts neither the access nor the account", { skip: SKIP }, async () => {
  const r = await receptionist();
  const register = { institutionId: S1, cohortId: ids.class1 };
  assert.equal(await mayWatchRegister(r.session.token, register), true);
  assert.equal(await mayWatchRegister(r.session.token, { institutionId: S2, cohortId: ids.class2 }), false, "another school's register");
  assert.equal(await mayWatchRegister(undefined, register), false, "no session");

  await setReceptionistAccess(await principal1(), r.id, ["students.directory"]);
  assert.equal(await mayWatchRegister(r.session.token, register), false, "records switched off, same session");
  await setReceptionistAccess(await principal1(), r.id, defaultAccess());
  assert.equal(await mayWatchRegister(r.session.token, register), true);
  await setReceptionistActive(await principal1(), r.id, false);
  assert.equal(await mayWatchRegister(r.session.token, register), false, "account switched off");

  // A class teacher's stream is unchanged: their own class, and not another.
  const teacher = await signIn(`${ids.teacher1}@rcp.test`, PASSWORD);
  assert.equal(await mayWatchRegister(teacher.token, register), true);
  assert.equal(await mayWatchRegister(teacher.token, { institutionId: S1, cohortId: ids.class1b }), false);
});

test("reports are school-wide for a receptionist with records and reports, and closed without them", { skip: SKIP }, async () => {
  const r = await receptionist();
  const window = { from: new Date("2026-04-01Z"), to: new Date("2027-04-01Z") };
  const overview = await getOverview(await r.me(), window);
  assert.equal(overview.scope, "institution");
  await setReceptionistAccess(await principal1(), r.id, ["students.directory"]);
  await assert.rejects(async () => getOverview(await r.me(), window), refused("attendanceRecord.read"));
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

test("the staff list is readable by default, without when anyone signed in; managing teachers is off until granted", { skip: SKIP }, async () => {
  const r = await receptionist();
  const directory = await getFacultyDirectory(await r.me());
  assert.equal(directory.showsSignIns, false);
  assert.ok(directory.members.every((m) => m.lastLoginAt === null));
  assert.ok(directory.members.some((m) => m.id === ids.principal1));
  assert.ok(!directory.members.some((m) => m.id === r.id), "receptionists are not on the staff list");
  await assert.rejects(async () =>
    inviteFaculty(await r.me(), { name: "T", email: `${P}t-x@rcp.test`, roleKey: "FACULTY" }),
    refused("user.invite"),
  );
});

test("with teacher management, a receptionist manages teacher accounts within their own access — never the principal's", { skip: SKIP }, async () => {
  const r = await receptionist([...defaultAccess(), "faculty.manage"]);
  const invited = await inviteFaculty(await r.me(), { name: "New Teacher", email: `${P}new-teacher@rcp.test`, roleKey: "CLASS_TEACHER" });
  assert.ok(invited.password.length >= 12);
  const teacherId = invited.member.id;
  await resetFacultyPassword(await r.me(), teacherId);
  await deactivateFaculty(await r.me(), teacherId);
  await reactivateFaculty(await r.me(), teacherId);

  await assert.rejects(async () => resetFacultyPassword(await r.me(), ids.principal1), /principal|teacher accounts only/);
  await assert.rejects(async () => deactivateFaculty(await r.me(), ids.principal1), /principal|teacher accounts only/);
  await assert.rejects(async () => resetFacultyPassword(await r.me(), ids.principal2), /could not|does not belong/);

  // Without "Edit and archive students", a class teacher's sign-in would carry
  // more than the receptionist holds: refused; a subject teacher still fine.
  await setReceptionistAccess(await principal1(), r.id, [...defaultAccess(), "faculty.manage"].filter((id) => id !== "students.edit"));
  await assert.rejects(async () =>
    inviteFaculty(await r.me(), { name: "CT", email: `${P}ct-2@rcp.test`, roleKey: "CLASS_TEACHER" }),
    /your own account cannot/,
  );
  await inviteFaculty(await r.me(), { name: "FT", email: `${P}ft-2@rcp.test`, roleKey: "FACULTY" });
});

// ---------------------------------------------------------------------------
// Escalation and isolation
// ---------------------------------------------------------------------------

test("a receptionist can never manage receptionists, grant access, or change their own — even with every switch on", { skip: SKIP }, async () => {
  const everything = ["students.directory", "students.add", "students.edit", "students.placement", "students.logins", "students.passwords", "students.faces", "students.twins", "attendance.take", "attendance.review", "reports.attendance", "academic.classes", "faculty.view", "faculty.manage", "admin.settings.view", "admin.settings.manage", "admin.audit"];
  const r = await receptionist(everything);
  const me = await r.me();
  await assert.rejects(() => createReceptionist(me, { name: "Sneaky", email: `${P}sneaky@rcp.test` }), refused("role.assign"));
  await assert.rejects(() => setReceptionistAccess(me, r.id, everything), refused("role.assign"));
  await assert.rejects(() => setReceptionistActive(me, r.id, true), refused("role.assign"));
  await assert.rejects(() => resetReceptionistPassword(me, r.id), refused("role.assign"));
  await assert.rejects(() => listReceptionists(me), refused("role.assign"));
  const admin = await prisma.role.findFirstOrThrow({ where: { key: "SCHOOL_ADMIN", institutionId: null } });
  await assert.rejects(() => assignRole(me, { targetUserId: r.id, roleId: admin.id, institutionId: S1 }), refused("role.assign"));
  const keys = (await r.me()).roles.flatMap((role) => role.permissions);
  for (const key of ["role.assign", "user.update", "user.invite", "user.deactivate", "faceEmbedding.manage", "platform.institution.create"]) {
    assert.ok(!keys.includes(key as never), `${key} was granted`);
  }
});

test("a principal cannot hand out what is never grantable, even by naming it in the request", { skip: SKIP }, async () => {
  const r = await receptionist();
  const saved = await setReceptionistAccess(await principal1(), r.id, ["role.assign", "user.update", "made.up", "admin.audit"]);
  assert.deepEqual(saved.access, ["admin.audit"]);
  const keys = (await r.me()).roles.flatMap((role) => role.permissions).sort();
  assert.deepEqual(keys, ["auditLog.read"]);
});

test("another school's principal can neither see nor touch this school's receptionists", { skip: SKIP }, async () => {
  const r = await receptionist();
  const other = await principal2();
  assert.ok(!(await listReceptionists(other)).some((x) => x.id === r.id));
  for (const attempt of [
    () => getReceptionist(other, r.id),
    () => setReceptionistAccess(other, r.id, []),
    () => setReceptionistActive(other, r.id, false),
    () => resetReceptionistPassword(other, r.id),
    () => updateReceptionist(other, r.id, { name: "Hijack" }),
  ]) {
    await assert.rejects(attempt, (e: unknown) => e instanceof ReceptionistError && /could not be found/.test(e.message));
  }
  assert.equal((await loginService(r.email, PASSWORD)).ok, true, "untouched");
});

test("a receptionist reaches nothing of another school: students, staff, faces, attendance", { skip: SKIP }, async () => {
  const r = await receptionist();
  await assert.rejects(async () => getStudentForRequest(await r.me(), ids.student2), Error);
  const staffIds = (await getFacultyDirectory(await r.me())).members.map((m) => m.id);
  assert.ok(!staffIds.includes(ids.principal2));
  await assert.rejects(async () => startOrResumeCaptureSession(await r.me(), { cohortId: ids.class2 }), refused());
});

test("settings, API keys and the audit log stay closed by default, and open only when switched on", { skip: SKIP }, async () => {
  const r = await receptionist();
  await assert.rejects(async () => listApiKeys(await r.me()), refused("institution.read"));
  await assert.rejects(async () => searchAuditLogs(await r.me(), {}), refused("auditLog.read"));
  await setReceptionistAccess(await principal1(), r.id, [...defaultAccess(), "admin.settings.view", "admin.audit"]);
  assert.ok(Array.isArray(await listApiKeys(await r.me())));
  const found = await searchAuditLogs(await r.me(), {});
  assert.ok(found.total > 0, "the school's own log");
});

test("receptionists are for schools: a college administrator is told so", { skip: SKIP }, async () => {
  await assert.rejects(
    async () => createReceptionist(await collegeAdmin(), { name: "C", email: `${P}college-desk@rcp.test` }),
    (e: unknown) => e instanceof ReceptionistError && /for schools/.test(e.message),
  );
  await assert.rejects(async () => listReceptionists(await teacher1()), refused("role.assign"));
});
