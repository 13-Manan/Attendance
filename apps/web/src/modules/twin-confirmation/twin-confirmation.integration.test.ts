import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_DIMENSION, type EnrollResponse, type ModelInfoResponse } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import {
  changeOwnPasswordService,
  getSessionUserByRawToken,
  loginService,
  loginWithStudentIdService,
} from "@/modules/auth-tenancy/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { ForbiddenError } from "@/modules/authorization/types";
import * as college from "@/modules/college-setup/service";
import { CollegeSetupError } from "@/modules/college-setup/types";
import { enrollFaceForStudentRequest } from "@/modules/face-enrollment/service";
import { enrollOwnFaceFromCameraRequest, startOwnFaceCaptureRequest } from "@/modules/face-enrollment/self-enrollment";
import { findCandidateEmbeddingsWithVectorsForCohort } from "@/modules/recognition-results/repository";
import { EMPTY_STUDENT_FILTERS } from "@/modules/students/directory-filters";
import { listStudentsForRequest } from "@/modules/students/directory-service";
import { provisionStudentLogin } from "@/modules/students/login-provisioning";
import { verificationFor } from "@/modules/students/verification-service";
import { pairKey } from "./policy.ts";
import { decideTwinConfirmation, listTwinConfirmations, twinBlockStates } from "./service.ts";
import { PAIR_ENTITY_TYPE, TwinConfirmationError } from "./types.ts";

/**
 * Twin / lookalike confirmations and student verification against the real
 * database: the conflict the enrollment check records, the queue built from
 * it, who may decide what (with real class-teacher links and real departments),
 * the decision stored in the audit log, the student's retry through the real
 * camera path and its lock, and the verification filters as SQL.
 *
 * Only face-ai is replaced: a "face" is an axis, so a face enrolled under one
 * student and captured again for another lands in the duplicate band, the way
 * a twin's would.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "twin-it-";
const SCHOOL = `${P}school`;
const COLLEGE = `${P}college`;
const INSTITUTIONS = [SCHOOL, COLLEGE];
const C7A = `${P}7a`;
const C7B = `${P}7b`;
const ids: Record<string, string> = {};
const users: Record<string, SessionUser> = {};

function actor(userId: string, roleKey: string, institutionId: string): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@twin-it.test`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
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
const operators = () => [actor(`${P}otto`, "ATTENDANCE_OPERATOR", SCHOOL), actor(`${P}olga`, "ATTENDANCE_OPERATOR", COLLEGE)];

// ---------------------------------------------------------------------------
// face-ai, replaced
// ---------------------------------------------------------------------------

const MODEL: ModelInfoResponse = {
  modelName: "twin-it-model",
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
const runningModel = async () => ({ modelName: MODEL.modelName, modelVersion: MODEL.modelVersion });

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

function jpeg(): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, ...new Array<number>(400).fill(0x33), 0xff, 0xd9]).toString("base64");
}

/** A student's own enrollment from the portal: a camera session, then one capture. */
async function selfEnroll(user: SessionUser, face: number, sample: number, extra: Record<string, unknown> = {}) {
  const deps = faceAi(face, sample);
  const started = await startOwnFaceCaptureRequest(user, deps);
  assert.ok(started.ok, started.ok ? "" : started.message);
  return enrollOwnFaceFromCameraRequest(
    user,
    { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: started.captureToken, ...extra } as never,
    deps,
  );
}

/** Staff enrollment, as the principal or the director does it. */
async function staffEnroll(who: SessionUser, studentId: string, face: number) {
  for (let sample = 0; sample < 2; sample++) {
    const result = await enrollFaceForStudentRequest(
      who,
      { studentId, imageBase64: "AAAA", captureSource: "CAMERA" },
      faceAi(face, sample),
    );
    assert.equal(result.ok, true, result.ok ? "" : result.message);
  }
}

const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? "ok" : result.reason);
const pairsOf = (list: { pending: Array<{ pair: string }>; decided: Array<{ pair: string }> }) =>
  [...list.pending, ...list.decided].map((item) => item.pair);
const decisionRows = () => prisma.auditLog.count({ where: { institutionId: { in: INSTITUTIONS }, entityType: PAIR_ENTITY_TYPE } });

// ---------------------------------------------------------------------------
// The school and the college
// ---------------------------------------------------------------------------

async function cleanup() {
  const where = { institutionId: { in: INSTITUTIONS } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: where } });
  await prisma.recoverableStudentPassword.deleteMany({ where: { user: where } });
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
      email: `${id}@twin-it.test`,
      name: id,
      passwordHash: "x",
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

async function schoolStudent(key: string, code: string, cohortId: string, withLogin: boolean) {
  const student = await prisma.student.create({
    data: { id: `${P}${key}`, institutionId: SCHOOL, studentCode: code, firstName: key[0].toUpperCase() + key.slice(1), lastName: "Twin" },
  });
  await prisma.enrollment.create({ data: { institutionId: SCHOOL, studentId: student.id, cohortId } });
  ids[key] = student.id;
  if (!withLogin) return;
  const issued = await provisionStudentLogin(principal(), student.id, {});
  const first = await loginWithStudentIdService(SCHOOL, code, issued.password);
  assert.ok(first.ok);
  const chosen = `${key}-chose-this-1`;
  const changed = await changeOwnPasswordService(first.user.userId, first.rawToken, { current: issued.password, next: chosen, confirm: chosen });
  assert.equal(changed.ok, true);
  users[key] = (await getSessionUserByRawToken(first.rawToken))!;
}

const newStudent = (studentCode: string, firstName: string, email: string) => ({
  studentCode,
  firstName,
  lastName: "Twin",
  email,
  phone: "",
  campusId: "",
  admissionNumber: "",
  admissionDate: "",
});

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: SCHOOL, name: "Twin School", type: "SCHOOL", settings: { faceEnrollmentPolicy: { selfEnrollmentEnabled: true } } },
      { id: COLLEGE, name: "Twin College", type: "COLLEGE", settings: { attendanceMode: "SUBJECT_WISE" } },
    ],
  });
  for (const id of INSTITUTIONS) {
    await prisma.academicSession.create({
      data: { id: `${id}-now`, institutionId: id, name: "2026-27", startDate: new Date("2026-06-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    });
  }

  // The school: 7A (class teacher Asha; Farah teaches it as primary teacher
  // but holds the plain FACULTY role) and 7B (class teacher Ben).
  for (const [id, role] of [["principal", "SCHOOL_ADMIN"], ["asha", "CLASS_TEACHER"], ["ben", "CLASS_TEACHER"], ["farah", "FACULTY"]] as const) {
    await staff(`${P}${id}`, SCHOOL, role);
  }
  await prisma.academicUnit.create({ data: { id: `${P}grade-7`, institutionId: SCHOOL, kind: "GRADE", name: "Grade 7" } });
  for (const [cohortId, name] of [[C7A, "7A"], [C7B, "7B"]]) {
    await prisma.cohort.create({
      data: { id: cohortId, institutionId: SCHOOL, academicUnitId: `${P}grade-7`, academicSessionId: `${SCHOOL}-now`, name },
    });
  }
  await prisma.cohortFaculty.createMany({
    data: [
      { cohortId: C7A, userId: `${P}asha`, role: "PRIMARY" },
      { cohortId: C7A, userId: `${P}farah`, role: "PRIMARY" },
      { cohortId: C7B, userId: `${P}ben`, role: "PRIMARY" },
    ],
  });
  await schoolStudent("riya", "7A-01", C7A, true);
  await schoolStudent("diya", "7A-02", C7A, false);
  await schoolStudent("tara", "7A-03", C7A, false);
  await schoolStudent("zoya", "7A-04", C7A, true);
  await schoolStudent("kabir", "7B-01", C7B, true);
  await schoolStudent("noor", "7B-02", C7B, true);
  await staffEnroll(principal(), ids.diya, 3);
  await staffEnroll(principal(), ids.tara, 7);
  await staffEnroll(principal(), ids.kabir, 11);

  // The college: Computer Science (head Hari) and Mechanical (head Lena).
  await staff(`${P}director`, COLLEGE, "COLLEGE_ADMIN");
  await staff(`${P}hari`, COLLEGE, "FACULTY");
  await staff(`${P}lena`, COLLEGE, "FACULTY");
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
  const admit = async (key: string, dept: "cse" | "me", head: () => SessionUser, code: string) => {
    const email = `${key}@twin-it.test`;
    const admitted = await college.createDepartmentStudent(
      head(),
      { departmentId: ids[dept], sectionId: ids[`${dept}Section`] },
      newStudent(code, key[0].toUpperCase() + key.slice(1), email),
    );
    ids[key] = admitted.studentId;
    const first = await loginService(email, admitted.password);
    assert.ok(first.ok);
    const chosen = `${key}-chose-this-1`;
    await changeOwnPasswordService(first.user.userId, first.rawToken, { current: admitted.password, next: chosen, confirm: chosen });
    users[key] = (await getSessionUserByRawToken(first.rawToken))!;
  };
  await admit("aman", "cse", hari, "CSE01");
  await admit("arun", "cse", hari, "CSE02");
  await admit("meera", "me", lena, "ME01");
  await staffEnroll(director(), ids.arun, 20);
  await staffEnroll(director(), ids.meera, 25);
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// A school pair, from conflict to enrollment
// ---------------------------------------------------------------------------

test("1. a student whose face matches nobody enrolls themselves", { skip: SKIP }, async () => {
  assert.equal(reasonOf(await selfEnroll(users.zoya, 15, 0)), "ok");
});

test("2. a face that matches an enrolled student is blocked: recorded, the student told whom to ask, and nobody named", { skip: SKIP }, async () => {
  const result = await selfEnroll(users.riya, 3, 1);
  assert.equal(reasonOf(result), "duplicate_identity");
  assert.equal(result.ok === false && result.twinReview, "pending");
  assert.match(result.message, /twin or a lookalike, please contact your Class Teacher or Principal for confirmation/);
  assert.match(result.message, /Riya Twin \(7A-01\)/, "their own name and ID, for the staff they ask");
  assert.doesNotMatch(result.message, /Diya|7A-02/);
  assert.equal(result.ok === false ? result.collidedWith : undefined, undefined, "no other student on the self path");

  const conflict = await prisma.auditLog.findFirstOrThrow({
    where: { institutionId: SCHOOL, action: "face_enrollment.refused", entityId: ids.riya },
    select: { afterJson: true, actorUserId: true },
  });
  const after = conflict.afterJson as Record<string, unknown>;
  assert.deepEqual([after.refusal, after.collidedWithStudentId, after.channel], ["duplicate_identity", ids.diya, "SELF"]);
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: ids.riya } }), 0);
  assert.deepEqual([...(await twinBlockStates(SCHOOL, [ids.riya])).entries()], [[ids.riya, "pending"]]);
});

test("8/9. the pending pair is the principal's and the class teacher's to decide — nobody else's", { skip: SKIP }, async () => {
  const pair = pairKey(ids.riya, ids.diya);
  assert.deepEqual(pairsOf(await listTwinConfirmations(principal())), [pair]);
  assert.deepEqual(pairsOf(await listTwinConfirmations(asha())), [pair]);
  assert.deepEqual(pairsOf(await listTwinConfirmations(ben())), [], "7B's class teacher");
  await assert.rejects(() => listTwinConfirmations(farah()), ForbiddenError, "a primary teacher without the Class Teacher role");
  await assert.rejects(() => listTwinConfirmations(users.riya), ForbiddenError, "the student");
});

test("3/4/5/6/7. the student — and an unauthorized teacher — cannot confirm, forge a confirmation or change the pair", { skip: SKIP }, async () => {
  const pair = pairKey(ids.riya, ids.diya);
  for (const who of [users.riya, users.zoya, farah()]) {
    await assert.rejects(() => decideTwinConfirmation(who, { pair, decision: "confirmed" }), ForbiddenError);
  }
  await assert.rejects(
    () => decideTwinConfirmation(ben(), { pair, decision: "confirmed" }),
    TwinConfirmationError,
    "a class teacher of another class",
  );
  // The old "different people" field, sent with a real capture: not heard.
  const smuggled = await selfEnroll(users.riya, 3, 2, { confirmDistinctFromStudentId: ids.diya, confirmed: true });
  assert.equal(reasonOf(smuggled), "duplicate_identity");
  // A pair that never collided cannot be confirmed into existence.
  await assert.rejects(
    () => decideTwinConfirmation(principal(), { pair: pairKey(ids.zoya, ids.diya), decision: "confirmed" }),
    TwinConfirmationError,
  );
  assert.equal(await decisionRows(), 0, "no decision was recorded");
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: ids.riya } }), 0);
});

test("15. 'Not confirmed' keeps the student blocked, with the administrator message", { skip: SKIP }, async () => {
  const done = await decideTwinConfirmation(asha(), { pair: pairKey(ids.riya, ids.diya), decision: "rejected" });
  assert.deepEqual(done, { state: "rejected", changed: true });
  const retry = await selfEnroll(users.riya, 3, 3);
  assert.equal(reasonOf(retry), "duplicate_identity");
  assert.equal(retry.ok === false && retry.twinReview, "not_confirmed");
  assert.match(retry.message, /could not be enrolled because it appears to match another enrolled student\. Please contact your school's administrator\./);
  const row = await prisma.auditLog.findFirstOrThrow({
    where: { institutionId: SCHOOL, action: "face_twin_confirmation.rejected" },
    select: { actorUserId: true, entityId: true, afterJson: true },
  });
  assert.deepEqual([row.actorUserId, row.entityId], [`${P}asha`, pairKey(ids.riya, ids.diya)]);
  assert.equal((row.afterJson as Record<string, unknown>).reviewerScope, "class_teacher");
  assert.equal(JSON.stringify(row.afterJson).includes("0."), false, "no score in the decision");
});

test("12. once the class teacher confirms, the student retries and is enrolled — the decision named on the sample", { skip: SKIP }, async () => {
  await decideTwinConfirmation(asha(), { pair: pairKey(ids.riya, ids.diya), decision: "confirmed" });
  const retry = await selfEnroll(users.riya, 3, 4);
  assert.equal(reasonOf(retry), "ok", retry.message);
  const sample = await prisma.faceEmbedding.findFirstOrThrow({ where: { studentId: ids.riya, isActive: true } });
  assert.deepEqual([sample.channel, sample.captureSource], ["SELF", "CAMERA"]);
  const relied = await prisma.auditLog.findFirstOrThrow({
    where: { institutionId: SCHOOL, action: "face_enrollment.distinct_person_confirmed" },
    select: { actorUserId: true, afterJson: true },
  });
  const payload = relied.afterJson as Record<string, unknown>;
  assert.deepEqual(
    [relied.actorUserId, payload.studentId, payload.distinctFromStudentId, payload.confirmedByUserId],
    [users.riya.userId, ids.riya, ids.diya, `${P}asha`],
  );
});

test("13/14/17. the confirmation is for that pair only — every other match is still refused", { skip: SKIP }, async () => {
  const withTara = await selfEnroll(users.riya, 7, 1);
  assert.deepEqual([reasonOf(withTara), withTara.ok === false && withTara.twinReview], ["duplicate_identity", "pending"]);
  // Zoya's face is Diya's — and now Riya's too: the twins' confirmation
  // waives nothing for a third student.
  const zoyaAsDiya = await selfEnroll(users.zoya, 3, 5);
  assert.equal(reasonOf(zoyaAsDiya), "duplicate_identity", "the twins are still protected from everybody else");
  const queue = pairsOf(await listTwinConfirmations(principal()));
  assert.ok(queue.includes(pairKey(ids.riya, ids.tara)));
  assert.ok(
    queue.includes(pairKey(ids.zoya, ids.diya)) || queue.includes(pairKey(ids.zoya, ids.riya)),
    "Zoya's conflict is in the queue, against whichever twin matched closer",
  );
});

test("8/9 (real links). a class teacher cannot decide a pair across classes; the principal can", { skip: SKIP }, async () => {
  assert.equal(reasonOf(await selfEnroll(users.riya, 11, 1)), "duplicate_identity", "Riya's face matches Kabir's (7B)");
  const pair = pairKey(ids.riya, ids.kabir);
  assert.equal(pairsOf(await listTwinConfirmations(asha())).includes(pair), false);
  await assert.rejects(() => decideTwinConfirmation(asha(), { pair, decision: "confirmed" }), TwinConfirmationError);
  await assert.rejects(() => decideTwinConfirmation(ben(), { pair, decision: "confirmed" }), TwinConfirmationError);
  assert.equal((await decideTwinConfirmation(principal(), { pair, decision: "confirmed" })).state, "confirmed");
});

test("a confirmation can be revoked: the next sample of that pair is refused again", { skip: SKIP }, async () => {
  const pair = pairKey(ids.riya, ids.diya);
  await decideTwinConfirmation(principal(), { pair, decision: "rejected" });
  const next = await selfEnroll(users.riya, 3, 6);
  assert.deepEqual([reasonOf(next), next.ok === false && next.twinReview], ["duplicate_identity", "not_confirmed"]);
  // The sample enrolled while it stood is kept: revoking stops new ones.
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: ids.riya, isActive: true } }), 1);
});

// ---------------------------------------------------------------------------
// A college pair
// ---------------------------------------------------------------------------

test("10/11. the head decides within the department; another head and cross-department pairs are refused; the director decides any", { skip: SKIP }, async () => {
  assert.equal(reasonOf(await selfEnroll(users.aman, 20, 1)), "duplicate_identity", "Aman's face matches Arun's");
  const inside = pairKey(ids.aman, ids.arun);
  assert.deepEqual(pairsOf(await listTwinConfirmations(hari(), { departmentId: ids.cse })), [inside]);
  // Another head's department: refused by college-setup's own scope check,
  // with the message every department page shows for it.
  await assert.rejects(() => listTwinConfirmations(lena(), { departmentId: ids.cse }), CollegeSetupError);
  await assert.rejects(() => listTwinConfirmations(hari()), ForbiddenError, "a head has no college-wide page");
  await decideTwinConfirmation(hari(), { pair: inside, decision: "confirmed" }, { departmentId: ids.cse });
  assert.equal(reasonOf(await selfEnroll(users.aman, 20, 2)), "ok", "retried after the head confirmed");

  assert.equal(reasonOf(await selfEnroll(users.aman, 25, 1)), "duplicate_identity", "Aman's face matches Meera's (Mechanical)");
  const across = pairKey(ids.aman, ids.meera);
  await assert.rejects(
    () => decideTwinConfirmation(hari(), { pair: across, decision: "confirmed" }, { departmentId: ids.cse }),
    TwinConfirmationError,
  );
  await assert.rejects(
    () => decideTwinConfirmation(lena(), { pair: across, decision: "confirmed" }, { departmentId: ids.me }),
    TwinConfirmationError,
  );
  assert.equal((await decideTwinConfirmation(director(), { pair: across, decision: "rejected" })).state, "rejected");
  const row = await prisma.auditLog.findFirstOrThrow({
    where: { institutionId: COLLEGE, action: "face_twin_confirmation.confirmed" },
    select: { afterJson: true },
  });
  assert.deepEqual(
    [(row.afterJson as Record<string, unknown>).reviewerScope, (row.afterJson as Record<string, unknown>).departmentId],
    ["department", ids.cse],
  );
});

test("7 (college). department faculty and attendance operators cannot see or decide a pair, from any page", { skip: SKIP }, async () => {
  const before = await decisionRows();
  const pair = pairKey(ids.aman, ids.arun);
  for (const [who, context] of [
    [dina(), { departmentId: ids.cse }],
    [dina(), {}],
    [operators()[1], { departmentId: ids.cse }],
    [operators()[1], {}],
    [operators()[0], {}],
  ] as const) {
    await assert.rejects(() => listTwinConfirmations(who, context), ForbiddenError, who.userId);
    for (const decision of ["confirmed", "rejected"] as const) {
      await assert.rejects(() => decideTwinConfirmation(who, { pair, decision }, context), ForbiddenError, who.userId);
    }
  }
  assert.equal(await decisionRows(), before, "nothing was recorded");
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test("19-25. verification comes from the records: the directory's filters and counts agree with each row's checklist", { skip: SKIP }, async () => {
  const deps = { runningFaceModel: runningModel };
  const list = async (verification: "" | "complete" | "incomplete" | "face_pending") =>
    (await listStudentsForRequest(principal(), { ...EMPTY_STUDENT_FILTERS, verification }, deps)).rows
      .map((row) => row.studentCode)
      .sort();
  // Complete: login, class and a usable face. Riya, Zoya and Kabir.
  assert.deepEqual(await list("complete"), ["7A-01", "7A-04", "7B-01"]);
  // Diya and Tara have no login; Noor has no face.
  assert.deepEqual(await list("incomplete"), ["7A-02", "7A-03", "7B-02"]);
  assert.deepEqual(await list("face_pending"), ["7B-02"]);
  assert.equal((await list("")).length, 6, "no filter, everyone");
  const page = await listStudentsForRequest(principal(), EMPTY_STUDENT_FILTERS, deps);
  assert.deepEqual([page.totalAll, page.activeAll, page.incompleteAll], [6, 6, 3]);

  // Search still narrows, and combines with the filter.
  const searched = await listStudentsForRequest(principal(), { ...EMPTY_STUDENT_FILTERS, q: "noor", verification: "incomplete" }, deps);
  assert.deepEqual(searched.rows.map((row) => row.studentCode), ["7B-02"]);

  const checklist = await verificationFor(SCHOOL, [ids.noor, ids.riya, ids.diya], await runningModel());
  assert.deepEqual(
    [checklist.get(ids.noor)?.overall, checklist.get(ids.noor)?.face, checklist.get(ids.riya)?.overall, checklist.get(ids.diya)?.items[0].detail],
    ["incomplete", "pending", "complete", "No student login yet"],
  );
});

test("28/29. the college department list: its own students, the same rules, the same counts", { skip: SKIP }, async () => {
  const view = await college.getDepartmentStudents(hari(), ids.cse, { verification: "complete" }, { runningFaceModel: runningModel });
  assert.deepEqual(view?.students.map((s) => s.studentCode).sort(), ["CSE01", "CSE02"]);
  assert.equal(view?.incompleteStudents, 0);
  const none = await college.getDepartmentStudents(hari(), ids.cse, { verification: "face_pending" }, { runningFaceModel: runningModel });
  assert.deepEqual(none?.students, []);
  assert.equal(
    await college.getDepartmentStudents(lena(), ids.cse, {}, { runningFaceModel: runningModel }),
    null,
    "another department's list is not a head's",
  );
});

// ---------------------------------------------------------------------------
// Off roll
// ---------------------------------------------------------------------------

test("16. a student taken off roll leaves recognition and the queue; the decisions stay on record", { skip: SKIP }, async () => {
  const before = await decisionRows();
  await prisma.student.update({ where: { id: ids.diya }, data: { status: "INACTIVE" } });
  const candidates = await findCandidateEmbeddingsWithVectorsForCohort(C7A, MODEL);
  assert.equal(candidates.some((row) => row.studentId === ids.diya), false, "not a recognition candidate");
  assert.equal(pairsOf(await listTwinConfirmations(principal())).includes(pairKey(ids.riya, ids.diya)), false);
  assert.equal(await decisionRows(), before);
  // Riya's pair with Diya was revoked above — but with Diya off roll there is
  // no collision left for that decision to govern.
  assert.equal(reasonOf(await selfEnroll(users.riya, 3, 8)), "ok");
});
