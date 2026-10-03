import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDING_DIMENSION,
  type DetectEmbedResponse,
  type EnrollResponse,
  type ModelInfoResponse,
} from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import {
  changeOwnPasswordService,
  getSessionUserByRawToken,
  loginService,
  loginWithStudentIdService,
} from "@/modules/auth-tenancy/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { startOrResumeCaptureSession } from "@/modules/attendance-capture/service";
import { generateAttendanceCandidates } from "@/modules/attendance-review/service";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { ForbiddenError } from "@/modules/authorization/types";
import * as college from "@/modules/college-setup/service";
import { enrollFaceForStudentRequest } from "@/modules/face-enrollment/service";
import { enrollOwnFaceFromCameraRequest, startOwnFaceCaptureRequest } from "@/modules/face-enrollment/self-enrollment";
import { runRecognitionForSession } from "@/modules/recognition-engine/service";
import { setStudentStatusForRequest } from "@/modules/students/directory-service";
import { provisionStudentLogin } from "@/modules/students/login-provisioning";
import { pairKey } from "./policy.ts";
import {
  decideTwinConfirmation,
  declareKnownTwinPair,
  knownTwinPairsInClass,
  listKnownTwinPairs,
  listTwinConfirmations,
  twinBlockStates,
  withdrawKnownTwinPair,
} from "./service.ts";
import { PAIR_ENTITY_TYPE } from "./types.ts";

/**
 * Known twins and lookalikes marked in advance, against the real database:
 * the declaration in the audit log, the real enrollment check reading it on
 * the staff and the student path, the real review queue, and real
 * recognition runs reading it for their class — with only face-ai replaced.
 *
 * The stand-in model is production-eligible with an identity calibration, so
 * a confident match is written PRESENT exactly as in production: "no
 * automatic Present" below is the real rule, not a stand-in's caution. A
 * "face" is an axis; two students given the same axis are identical twins
 * to the recogniser.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "kt-it-";
const SCHOOL = `${P}school`;
const SCHOOL2 = `${P}school-2`;
const COLLEGE = `${P}college`;
const INSTITUTIONS = [SCHOOL, SCHOOL2, COLLEGE];
const C7A = `${P}7a`;
const C7B = `${P}7b`;
const C7R = `${P}7r`;
const C7S = `${P}7s`;
const OTHER_CLASS = `${P}2-1a`;
const ids: Record<string, string> = {};
const users: Record<string, SessionUser> = {};

function actor(userId: string, roleKey: string, institutionId: string, permissions?: PermissionKey[]): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey);
  return {
    userId,
    email: `${userId}@kt-it.test`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [
      {
        key: roleKey,
        name: role?.name ?? roleKey,
        institutionId,
        campusId: null,
        permissions: permissions ?? ([...(role?.permissions ?? [])] as PermissionKey[]),
      },
    ],
  };
}
const principal = () => actor(`${P}principal`, "SCHOOL_ADMIN", SCHOOL);
const asha = () => actor(`${P}asha`, "CLASS_TEACHER", SCHOOL);
const ben = () => actor(`${P}ben`, "CLASS_TEACHER", SCHOOL);
const farah = () => actor(`${P}farah`, "FACULTY", SCHOOL);
const director = () => actor(`${P}director`, "COLLEGE_ADMIN", COLLEGE);
const hari = () => actor(`${P}hari`, "HOD", COLLEGE);
const lena = () => actor(`${P}lena`, "HOD", COLLEGE);
const dina = () => actor(`${P}dina`, "DEPARTMENT_FACULTY", COLLEGE);
const desk = (twins: boolean) =>
  actor(`${P}desk-${twins ? "twins" : "plain"}`, `RECEPTIONIST__${P}desk`, SCHOOL, [
    "student.read",
    "cohort.read",
    "faceEmbedding.enroll",
    ...(twins ? (["twinConfirmation.decide"] as PermissionKey[]) : []),
  ]);

// ---------------------------------------------------------------------------
// face-ai, replaced
// ---------------------------------------------------------------------------

const MODEL: ModelInfoResponse = {
  modelName: "kt-it-model",
  modelVersion: "1+pp1",
  weightsVersion: "1+pp1",
  preprocessingVersion: "1",
  embeddingDim: EMBEDDING_DIMENSION,
  embeddingNormalized: true,
  runtime: "test",
  commercialUse: "permitted",
  productionEligible: true,
  contractVersion: "v1",
  calibration: {
    id: "kt-it-identity",
    knots: [
      { raw: -1, calibrated: -1 },
      { raw: 1, calibrated: 1 },
    ],
    rawAmbiguityMargin: 0.05,
  },
};

const unit = (weights: Record<number, number>): number[] => {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  let norm = 0;
  for (const [i, w] of Object.entries(weights)) {
    v[Number(i)] = w;
    norm += w * w;
  }
  return v.map((x) => x / Math.sqrt(norm));
};
const faceSample = (face: number, sample: number) => unit({ [face]: 1, [60 + sample]: 0.15 });
const faceProbe = (face: number) => unit({ [face]: 1, [100]: 0.15 });

function faceAi(face: number, sample: number) {
  const reply: EnrollResponse = {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: faceSample(face, sample),
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    weightsVersion: MODEL.weightsVersion,
    preprocessingVersion: MODEL.preprocessingVersion,
    embeddingDim: EMBEDDING_DIMENSION,
    aligned: true,
  };
  return { faceModelInfo: async () => MODEL, faceEnroll: async () => reply };
}

/** A photograph the model would refuse: the normal quality gate, unchanged by any declaration. */
function blurryFaceAi() {
  const reply = {
    accepted: false,
    assessment: { reason: "blurry", qualityScore: 0.2, faceCount: 1 },
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  } as unknown as EnrollResponse;
  return { faceModelInfo: async () => MODEL, faceEnroll: async () => reply };
}

function jpeg(): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, ...new Array<number>(400).fill(0x33), 0xff, 0xd9]).toString("base64");
}

/** One staff sample of `face` for a student. */
function staffEnrollOnce(who: SessionUser, studentId: string, face: number, sample = 0) {
  return enrollFaceForStudentRequest(who, { studentId, imageBase64: "AAAA", captureSource: "CAMERA" }, faceAi(face, sample));
}

/** Several samples, each expected to be stored. */
async function staffEnroll(who: SessionUser, studentId: string, face: number, samples = 3) {
  for (let sample = 0; sample < samples; sample++) {
    const result = await staffEnrollOnce(who, studentId, face, sample);
    assert.equal(result.ok, true, `${studentId} sample ${sample}: ${result.ok ? "" : result.reason}`);
  }
}

const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? "ok" : result.reason);
const conflictsOf = (studentId: string) =>
  prisma.auditLog.count({
    where: { action: "face_enrollment.refused", entityId: studentId, afterJson: { path: ["refusal"], equals: "duplicate_identity" } },
  });
const pairRows = (a: string, b: string) =>
  prisma.auditLog.findMany({
    where: { entityType: PAIR_ENTITY_TYPE, entityId: pairKey(a, b) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const activeSamples = (studentId: string) => prisma.faceEmbedding.count({ where: { studentId, isActive: true } });
const pendingPairs = async (who: SessionUser = principal()) => (await listTwinConfirmations(who)).pending.map((item) => item.pair);

// ---------------------------------------------------------------------------
// The schools and the college
// ---------------------------------------------------------------------------

async function cleanup() {
  const where = { institutionId: { in: INSTITUTIONS } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: where } });
  await prisma.recoverableStudentPassword.deleteMany({ where: { user: where } });
  await prisma.attendanceCorrection.deleteMany({ where: { attendanceRecord: where } });
  await prisma.attendanceRecord.deleteMany({ where });
  await prisma.sessionImage.deleteMany({ where: { session: where } });
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
  for (const kind of ["SECTION", "COURSE", "SEMESTER", "DEPARTMENT", "GRADE"] as const) {
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
      email: `${id}@kt-it.test`,
      name: id,
      passwordHash: "x",
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

async function student(key: string, institutionId: string, cohortId: string) {
  const row = await prisma.student.create({
    data: { id: `${P}${key}`, institutionId, studentCode: `${key.toUpperCase()}`, firstName: key[0].toUpperCase() + key.slice(1), lastName: "Kt" },
  });
  await prisma.enrollment.create({ data: { institutionId, studentId: row.id, cohortId } });
  ids[key] = row.id;
}

/** A school student who signs in with their student ID — for the student's own camera path. */
async function withLogin(key: string) {
  const issued = await provisionStudentLogin(principal(), ids[key], {});
  const first = await loginWithStudentIdService(SCHOOL, key.toUpperCase(), issued.password);
  assert.ok(first.ok);
  const chosen = `${key}-chose-this-1`;
  const changed = await changeOwnPasswordService(first.user.userId, first.rawToken, { current: issued.password, next: chosen, confirm: chosen });
  assert.equal(changed.ok, true);
  users[key] = (await getSessionUserByRawToken(first.rawToken))!;
}

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: SCHOOL, name: "Known Twin School", type: "SCHOOL", settings: { faceEnrollmentPolicy: { selfEnrollmentEnabled: true } } },
      { id: SCHOOL2, name: "Other School", type: "SCHOOL" },
      { id: COLLEGE, name: "Known Twin College", type: "COLLEGE", settings: { attendanceMode: "SUBJECT_WISE" } },
    ],
  });
  for (const id of INSTITUTIONS) {
    await prisma.academicSession.create({
      data: { id: `${id}-now`, institutionId: id, name: "2026-27", startDate: new Date("2026-06-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    });
  }

  for (const [id, role] of [["principal", "SCHOOL_ADMIN"], ["asha", "CLASS_TEACHER"], ["ben", "CLASS_TEACHER"], ["farah", "FACULTY"]] as const) {
    await staff(`${P}${id}`, SCHOOL, role);
  }
  await prisma.academicUnit.create({ data: { id: `${P}grade-7`, institutionId: SCHOOL, kind: "GRADE", name: "Grade 7" } });
  for (const [cohortId, name] of [[C7A, "7A"], [C7B, "7B"], [C7R, "7R"], [C7S, "7S"]]) {
    await prisma.cohort.create({ data: { id: cohortId, institutionId: SCHOOL, academicUnitId: `${P}grade-7`, academicSessionId: `${SCHOOL}-now`, name } });
  }
  await prisma.cohortFaculty.createMany({
    data: [
      { cohortId: C7A, userId: `${P}asha`, role: "PRIMARY" },
      { cohortId: C7A, userId: `${P}farah`, role: "PRIMARY" },
      { cohortId: C7B, userId: `${P}ben`, role: "PRIMARY" },
    ],
  });
  // 7A: a pair per scenario. 7B: one student, for a pair across classes.
  for (const key of ["a1", "b1", "a2", "b2", "a3", "b3", "a4", "b4", "a5", "b5", "a6", "b6", "a7", "b7", "c8", "d8", "k1", "k2", "s1", "s2"]) {
    await student(key, SCHOOL, C7A);
  }
  await student("h1", SCHOOL, C7B);
  // 7R: twin r1 enrolled, twin r2 never enrolled, classmate u1. 7S: the same, undeclared.
  for (const key of ["r1", "r2", "u1"]) await student(key, SCHOOL, C7R);
  for (const key of ["q1", "q2", "u2"]) await student(key, SCHOOL, C7S);

  await prisma.academicUnit.create({ data: { id: `${P}grade-2`, institutionId: SCHOOL2, kind: "GRADE", name: "Grade 2" } });
  await prisma.cohort.create({ data: { id: OTHER_CLASS, institutionId: SCHOOL2, academicUnitId: `${P}grade-2`, academicSessionId: `${SCHOOL2}-now`, name: "2-1A" } });
  await student("x2", SCHOOL2, OTHER_CLASS);

  await withLogin("s1");

  // The college: Computer Science (head Hari) and Mechanical (head Lena).
  await staff(`${P}director`, COLLEGE, "COLLEGE_ADMIN");
  await staff(`${P}hari`, COLLEGE, "FACULTY");
  await staff(`${P}lena`, COLLEGE, "FACULTY");
  await staff(`${P}dina`, COLLEGE, "DEPARTMENT_FACULTY");
  ids.cse = (await college.createDepartment(director(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.me = (await college.createDepartment(director(), { name: "Mechanical", code: "ME" })).departmentId;
  await college.assignDepartmentHead(director(), { departmentId: ids.cse, userId: `${P}hari` });
  await college.assignDepartmentHead(director(), { departmentId: ids.me, userId: `${P}lena` });
  for (const [dept, head, code, name] of [["cse", hari, "CSE101", "Programming"], ["me", lena, "MEC101", "Mechanics"]] as const) {
    const semester = (await college.createSemester(head(), { departmentId: ids[dept], number: 1 })).semesterId;
    await college.setCurrentSemester(head(), { departmentId: ids[dept], semesterId: semester });
    const course = (await college.createCourse(head(), { semesterId: semester, code, name })).courseId;
    [ids[`${dept}Section`]] = (
      await college.addCourseSections(head(), {
        departmentId: ids[dept],
        semesterId: semester,
        courseId: course,
        sessionId: `${COLLEGE}-now`,
        sections: [{ name: "A" }],
      })
    ).sectionIds;
  }
  for (const [key, dept, head, code] of [["aman", "cse", hari, "CSE01"], ["arun", "cse", hari, "CSE02"], ["meera", "me", lena, "ME01"]] as const) {
    const email = `${key}@kt-it.test`;
    const admitted = await college.createDepartmentStudent(
      head(),
      { departmentId: ids[dept], sectionId: ids[`${dept}Section`] },
      { studentCode: code, firstName: key, lastName: "Kt", email, phone: "", campusId: "", admissionNumber: "", admissionDate: "" },
    );
    ids[key] = admitted.studentId;
    const first = await loginService(email, admitted.password);
    assert.ok(first.ok);
  }
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Enrollment, in every order
// ---------------------------------------------------------------------------

test("CASE 1: declared, then A enrolls, then B with the same face — no conflict, no queue, one decision", { skip: SKIP }, async () => {
  const declared = await declareKnownTwinPair(principal(), { studentIds: [ids.a1, ids.b1] });
  assert.equal(declared.changed, true);
  assert.ok((await listKnownTwinPairs(principal())).pairs.some((p) => p.pair === pairKey(ids.a1, ids.b1)), "shown as known");

  await staffEnroll(principal(), ids.a1, 11);
  await staffEnroll(principal(), ids.b1, 11);

  assert.equal(await conflictsOf(ids.a1), 0);
  assert.equal(await conflictsOf(ids.b1), 0);
  assert.ok(!(await pendingPairs()).includes(pairKey(ids.a1, ids.b1)), "nothing for staff to confirm");
  assert.equal((await pairRows(ids.a1, ids.b1)).length, 1, "the one declaration, no second decision");
  // The existing record of which enrollments relied on a confirmation, naming the declaration.
  const relied = await prisma.auditLog.findMany({
    where: { action: "face_enrollment.distinct_person_confirmed", afterJson: { path: ["studentId"], equals: ids.b1 } },
  });
  assert.ok(relied.length > 0);
  const declaration = (await pairRows(ids.a1, ids.b1))[0];
  assert.ok(relied.every((row) => (row.afterJson as Record<string, unknown>).confirmationRecordId === declaration.id));
});

test("CASE 2: declared by the class teacher, then B enrolls first and A second", { skip: SKIP }, async () => {
  assert.equal((await declareKnownTwinPair(asha(), { studentIds: [ids.b2, ids.a2] })).changed, true);
  await staffEnroll(principal(), ids.b2, 12);
  await staffEnroll(principal(), ids.a2, 12);
  assert.equal((await conflictsOf(ids.a2)) + (await conflictsOf(ids.b2)), 0);
});

test("CASE 3 and 4: one twin already enrolled before the declaration — the other then enrolls, either way round", { skip: SKIP }, async () => {
  await staffEnroll(principal(), ids.a3, 13);
  await declareKnownTwinPair(principal(), { studentIds: [ids.a3, ids.b3] });
  await staffEnroll(principal(), ids.b3, 13);

  await staffEnroll(principal(), ids.b4, 14);
  await declareKnownTwinPair(principal(), { studentIds: [ids.a4, ids.b4] });
  await staffEnroll(principal(), ids.a4, 14);

  for (const key of ["a3", "b3", "a4", "b4"]) assert.equal(await conflictsOf(ids[key]), 0, key);
});

test("CASE 5: both already enrolled, then declared — recorded once, both stay enrolled, each adds their own samples", { skip: SKIP }, async () => {
  await staffEnroll(principal(), ids.a5, 15);
  await staffEnroll(principal(), ids.b5, 16);
  assert.equal((await declareKnownTwinPair(principal(), { studentIds: [ids.a5, ids.b5] })).changed, true);
  assert.ok((await listKnownTwinPairs(principal())).pairs.some((p) => p.pair === pairKey(ids.a5, ids.b5)));
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.a5, 15, 4)), "ok");
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.b5, 16, 4)), "ok");
  assert.equal((await pairRows(ids.a5, ids.b5)).length, 1);
});

test("a declaration does not mean 'accept any face': A's face is still refused as a sample of B, who already has their own", { skip: SKIP }, async () => {
  // The duplicate check is waived for this pair; the student's own-sample check is not.
  const before = await activeSamples(ids.b5);
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.b5, 15, 5)), "does_not_match_student");
  assert.equal(await activeSamples(ids.b5), before);
});

test("a declaration waives nothing about the photograph: a blurry capture of a declared twin is still refused", { skip: SKIP }, async () => {
  const before = await activeSamples(ids.a5);
  const result = await enrollFaceForStudentRequest(principal(), { studentId: ids.a5, imageBase64: "AAAA", captureSource: "CAMERA" }, blurryFaceAi());
  assert.equal(reasonOf(result), "blurry");
  assert.equal(await activeSamples(ids.a5), before);
});

test("a declared twin enrolling themselves from the portal: enrolled, and told nothing about the other student", { skip: SKIP }, async () => {
  await staffEnroll(principal(), ids.s2, 17);
  await declareKnownTwinPair(principal(), { studentIds: [ids.s1, ids.s2] });
  const deps = faceAi(17, 1);
  const started = await startOwnFaceCaptureRequest(users.s1, deps);
  assert.ok(started.ok);
  const result = await enrollOwnFaceFromCameraRequest(users.s1, { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: started.captureToken }, deps);
  assert.equal(reasonOf(result), "ok");
  assert.doesNotMatch(result.message ?? "", /S2|twin|lookalike/i);
  assert.equal(await conflictsOf(ids.s1), 0);
});

// ---------------------------------------------------------------------------
// Removing a declaration, and discovery as it always was
// ---------------------------------------------------------------------------

test("CASE 6: declared, then removed — the pair is unknown again, and discovery works exactly as before", { skip: SKIP }, async () => {
  await declareKnownTwinPair(principal(), { studentIds: [ids.a6, ids.b6] });
  assert.deepEqual(await withdrawKnownTwinPair(asha(), { pair: pairKey(ids.a6, ids.b6) }), { changed: true });
  assert.ok(!(await listKnownTwinPairs(principal())).pairs.some((p) => p.pair === pairKey(ids.a6, ids.b6)));

  await staffEnroll(principal(), ids.a6, 18);
  const blocked = await staffEnrollOnce(principal(), ids.b6, 18);
  assert.equal(reasonOf(blocked), "duplicate_identity");
  assert.equal(blocked.ok ? null : blocked.twinReview, "pending");
  assert.ok((await pendingPairs()).includes(pairKey(ids.a6, ids.b6)), "the ordinary confirmation appears");
  assert.equal((await twinBlockStates(SCHOOL, [ids.b6])).get(ids.b6), "pending");

  await decideTwinConfirmation(asha(), { pair: pairKey(ids.a6, ids.b6), decision: "confirmed" });
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.b6, 18, 1)), "ok");
});

test("removing a declaration deletes no face sample and no register — only the pair's standing changes", { skip: SKIP }, async () => {
  const [a, b] = [await activeSamples(ids.a5), await activeSamples(ids.b5)];
  const registers = await prisma.attendanceRecord.count({ where: { studentId: { in: [ids.a5, ids.b5] } } });
  await withdrawKnownTwinPair(principal(), { pair: pairKey(ids.a5, ids.b5) });
  assert.deepEqual([await activeSamples(ids.a5), await activeSamples(ids.b5)], [a, b]);
  assert.equal(await prisma.attendanceRecord.count({ where: { studentId: { in: [ids.a5, ids.b5] } } }), registers);
  assert.equal(await prisma.student.count({ where: { id: { in: [ids.a5, ids.b5] }, status: "ACTIVE" } }), 2);
});

test("CASE 7: discovered and confirmed in a review first — declaring later keeps the one confirmation", { skip: SKIP }, async () => {
  await staffEnroll(principal(), ids.a7, 19);
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.b7, 19)), "duplicate_identity");
  await decideTwinConfirmation(asha(), { pair: pairKey(ids.a7, ids.b7), decision: "confirmed" });
  const rows = (await pairRows(ids.a7, ids.b7)).length;

  const declared = await declareKnownTwinPair(principal(), { studentIds: [ids.b7, ids.a7] });
  assert.deepEqual([declared.changed, declared.source], [false, "review"]);
  assert.equal((await pairRows(ids.a7, ids.b7)).length, rows, "no duplicate decision");
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.b7, 19, 1)), "ok");
});

test("discovery and 'Not confirmed' are untouched, and a rejected pair cannot be declared known twins", { skip: SKIP }, async () => {
  await staffEnroll(principal(), ids.c8, 20);
  assert.equal(reasonOf(await staffEnrollOnce(principal(), ids.d8, 20)), "duplicate_identity");
  assert.ok((await pendingPairs(asha())).includes(pairKey(ids.c8, ids.d8)));
  await decideTwinConfirmation(asha(), { pair: pairKey(ids.c8, ids.d8), decision: "rejected" });
  const refused = await staffEnrollOnce(principal(), ids.d8, 20, 1);
  assert.equal(refused.ok ? null : refused.twinReview, "not_confirmed");

  const rows = (await pairRows(ids.c8, ids.d8)).length;
  await assert.rejects(declareKnownTwinPair(principal(), { studentIds: [ids.c8, ids.d8] }), /not confirmed/);
  assert.equal((await pairRows(ids.c8, ids.d8)).length, rows);
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

async function recognise(cohortId: string, faces: number[]) {
  const { session } = await startOrResumeCaptureSession(principal(), { cohortId });
  const detect = {
    faces: faces.map((face, i) => ({
      sequenceNumber: 1,
      boundingBox: { x: i * 200, y: 0, width: 120, height: 120 },
      embedding: faceProbe(face),
      detectionConfidence: 0.99,
      qualityScore: 0.9,
    })),
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  } as DetectEmbedResponse;
  const recognition = await runRecognitionForSession(
    principal(),
    { sessionId: session.id, images: [{ sequenceNumber: 1, imageBase64: "x".repeat(64) }] },
    // Only face-ai is replaced: candidates, eligibility and the declared twins are read from the database.
    { fetchModelInfo: async () => MODEL, detectEmbed: async () => detect },
  );
  return { session, recognition, status: (studentId: string) => recognition.perStudent.find((s) => s.studentId === studentId)?.advisoryResult };
}

test("attendance: the enrolled twin of a declared pair is never marked present on a face match; undeclared, the same photograph would", { skip: SKIP }, async () => {
  // 7R and 7S are the same situation — twin 1 enrolled, twin 2 not — except
  // that 7R's twins are declared.
  await staffEnroll(principal(), ids.r1, 30, 5);
  await staffEnroll(principal(), ids.u1, 31, 5);
  await staffEnroll(principal(), ids.q1, 32, 5);
  await staffEnroll(principal(), ids.u2, 33, 5);
  await declareKnownTwinPair(principal(), { studentIds: [ids.r1, ids.r2] });
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, C7R), [[ids.r1, ids.r2].sort() as [string, string]]);

  const declared = await recognise(C7R, [30, 31]);
  const undeclared = await recognise(C7S, [32, 33]);
  assert.equal(declared.status(ids.r1), "NEEDS_REVIEW");
  assert.equal(declared.status(ids.u1), "PRESENT", "a classmate is unaffected");
  assert.equal(undeclared.status(ids.q1), "PRESENT", "without a declaration, today's behaviour");

  // The register, as the teacher's Process step writes it.
  await generateAttendanceCandidates(principal(), { sessionId: declared.session.id, recognition: declared.recognition });
  await generateAttendanceCandidates(principal(), { sessionId: undeclared.session.id, recognition: undeclared.recognition });
  const result = async (sessionId: string, studentId: string) =>
    (await prisma.attendanceRecord.findUniqueOrThrow({ where: { sessionId_studentId: { sessionId, studentId } } })).finalResult;
  assert.equal(await result(declared.session.id, ids.r1), "NEEDS_REVIEW");
  assert.equal(await result(declared.session.id, ids.r2), "NEEDS_REVIEW", "the unenrolled twin is never marked absent either");
  assert.equal(await result(declared.session.id, ids.u1), "PRESENT");
  assert.equal(await result(undeclared.session.id, ids.q1), "PRESENT");
});

test("attendance follows the declaration as it changes: removed, archived and restored — never stale", { skip: SKIP }, async () => {
  const pair = pairKey(ids.r1, ids.r2);
  await withdrawKnownTwinPair(principal(), { pair });
  assert.equal((await recognise(C7R, [30])).status(ids.r1), "PRESENT", "removed: the faces alone decide again");

  await declareKnownTwinPair(principal(), { studentIds: [ids.r1, ids.r2] });
  assert.equal((await recognise(C7R, [30])).status(ids.r1), "NEEDS_REVIEW");

  // The twin leaves: off roll, out of recognition — the declaration no longer applies.
  await setStudentStatusForRequest(principal(), ids.r2, "INACTIVE");
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, C7R), []);
  assert.equal((await recognise(C7R, [30])).status(ids.r1), "PRESENT");
  // A new student record in the class inherits nothing.
  await student("r3", SCHOOL, C7R);
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, C7R), []);

  // Restored: the same student, the same declaration.
  await setStudentStatusForRequest(principal(), ids.r2, "ACTIVE");
  assert.equal((await recognise(C7R, [30])).status(ids.r1), "NEEDS_REVIEW");
});

test("both twins enrolled and in the photograph: one face each, both reviewed", { skip: SKIP }, async () => {
  // a1 and b1 (declared, same face) share 7A. Give the photograph each of their faces.
  const run = await recognise(C7A, [11, 11]);
  const claimed = run.recognition.perFace.map((face) => face.candidateStudentId).filter(Boolean);
  assert.equal(new Set(claimed).size, claimed.length, "no student is given two faces");
  assert.equal(run.status(ids.a1), "NEEDS_REVIEW");
  assert.equal(run.status(ids.b1), "NEEDS_REVIEW");
});

// ---------------------------------------------------------------------------
// Who may declare, with real links
// ---------------------------------------------------------------------------

test("school authority: class teacher inside her class only; a plain teacher, a student and a receptionist without the switch never", { skip: SKIP }, async () => {
  const rows = () => prisma.auditLog.count({ where: { institutionId: SCHOOL, entityType: PAIR_ENTITY_TYPE } });
  const before = await rows();
  await assert.rejects(declareKnownTwinPair(asha(), { studentIds: [ids.k1, ids.h1] }), /can't be marked here/);
  await assert.rejects(declareKnownTwinPair(ben(), { studentIds: [ids.k1, ids.h1] }), /can't be marked here/);
  await assert.rejects(declareKnownTwinPair(farah(), { studentIds: [ids.k1, ids.k2] }), ForbiddenError);
  await assert.rejects(declareKnownTwinPair(users.s1, { studentIds: [ids.s1, ids.k2] }), ForbiddenError);
  await assert.rejects(declareKnownTwinPair(desk(false), { studentIds: [ids.k1, ids.k2] }), ForbiddenError);
  await assert.rejects(withdrawKnownTwinPair(users.s1, { pair: pairKey(ids.a1, ids.b1) }), ForbiddenError);
  assert.equal(await rows(), before, "no refusal wrote anything");
  // The principal decides across classes; a receptionist given twin decisions may too.
  assert.equal((await declareKnownTwinPair(principal(), { studentIds: [ids.k1, ids.h1] })).changed, true);
  assert.equal((await declareKnownTwinPair(desk(true), { studentIds: [ids.k2, ids.h1] })).changed, true);
});

test("another school's student is refused with the same sentence, and nothing is written in either school", { skip: SKIP }, async () => {
  const before = await prisma.auditLog.count({ where: { entityType: PAIR_ENTITY_TYPE, institutionId: { in: [SCHOOL, SCHOOL2] } } });
  await assert.rejects(declareKnownTwinPair(principal(), { studentIds: [ids.a1, ids.x2] }), /can't be marked here/);
  await assert.rejects(declareKnownTwinPair(principal(), { studentIds: [ids.aman, ids.a1] }), /can't be marked here/);
  assert.equal(await prisma.auditLog.count({ where: { entityType: PAIR_ENTITY_TYPE, institutionId: { in: [SCHOOL, SCHOOL2] } } }), before);
});

test("college authority: the head within the department, from its page; another head, department faculty — refused; the director anywhere", { skip: SKIP }, async () => {
  const cse = { departmentId: ids.cse };
  assert.equal((await declareKnownTwinPair(hari(), { studentIds: [ids.aman, ids.arun] }, cse)).changed, true);
  await assert.rejects(declareKnownTwinPair(hari(), { studentIds: [ids.aman, ids.meera] }, cse), /can't be marked here/);
  await assert.rejects(declareKnownTwinPair(lena(), { studentIds: [ids.aman, ids.arun] }, cse));
  await assert.rejects(declareKnownTwinPair(dina(), { studentIds: [ids.aman, ids.arun] }, cse));
  assert.equal((await declareKnownTwinPair(director(), { studentIds: [ids.aman, ids.meera] })).changed, true);
  // Hari sees his department's pair, not the cross-department one.
  const known = await listKnownTwinPairs(hari(), cse);
  assert.deepEqual(known.pairs.map((p) => p.pair), [pairKey(ids.aman, ids.arun)]);
  const row = (await pairRows(ids.aman, ids.arun))[0];
  assert.equal((row.afterJson as Record<string, unknown>).departmentId, ids.cse);
});

// ---------------------------------------------------------------------------
// One pair, at once
// ---------------------------------------------------------------------------

test("five declarations of one pair at once, either way round, by two people: one row", { skip: SKIP }, async () => {
  const results = await Promise.all([
    declareKnownTwinPair(principal(), { studentIds: [ids.k1, ids.k2] }),
    declareKnownTwinPair(asha(), { studentIds: [ids.k2, ids.k1] }),
    declareKnownTwinPair(principal(), { studentIds: [ids.k2, ids.k1] }),
    declareKnownTwinPair(asha(), { studentIds: [ids.k1, ids.k2] }),
    declareKnownTwinPair(principal(), { studentIds: [ids.k1, ids.k2] }),
  ]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.equal((await pairRows(ids.k1, ids.k2)).length, 1);
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test("audit: a declaration and its removal carry ids, the decision and who — never a face, a vector or a score", { skip: SKIP }, async () => {
  const rows = await pairRows(ids.a6, ids.b6);
  const declaration = rows.find((row) => (row.afterJson as Record<string, unknown>).source === "declared")!;
  const removal = rows.find((row) => row.action === "face_twin_confirmation.withdrawn")!;
  assert.equal(declaration.action, "face_twin_confirmation.confirmed");
  assert.equal(declaration.actorUserId, `${P}principal`);
  assert.equal(declaration.institutionId, SCHOOL);
  assert.deepEqual(Object.keys(declaration.afterJson as object).sort(), ["decision", "relationship", "reviewerScope", "source", "studentIds"]);
  assert.deepEqual((declaration.afterJson as Record<string, unknown>).studentIds, [ids.a6, ids.b6].sort());
  assert.equal(removal.actorUserId, `${P}asha`);
  assert.deepEqual(removal.beforeJson, { decision: "confirmed", source: "declared" });
  for (const row of [declaration, removal]) {
    const text = JSON.stringify([row.beforeJson, row.afterJson]);
    assert.doesNotMatch(text, /embedding|similarity|vector|image|score|\d\.\d{3}/i);
  }
});
