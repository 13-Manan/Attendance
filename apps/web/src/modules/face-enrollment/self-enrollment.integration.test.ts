import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDING_DIMENSION,
  type DetectEmbedResponse,
  type EnrollResponse,
  type ModelInfoResponse,
} from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import { updateSelfEnrollmentPolicy } from "@/modules/admin-settings/service";
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
import { runRecognitionForSession } from "@/modules/recognition-engine/service";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import { createStudentForRequest } from "@/modules/students/directory-service";
import { provisionStudentLogin } from "@/modules/students/login-provisioning";
import { deriveSelfCaptureKey, issueSelfCaptureToken, SELF_CAPTURE_TOKEN_TTL_MS } from "./self-capture.ts";
import {
  enrollOwnFaceFromCameraRequest,
  getOwnFaceEnrollmentOverview,
  startOwnFaceCaptureRequest,
  type SelfEnrollmentDeps,
} from "./self-enrollment.ts";

/**
 * Student self-enrollment against the real database, school and college.
 *
 * The whole lifecycle the feature exists for, with nothing faked but face-ai:
 * staff create the student and their login with no face; the student signs
 * in for real (`loginService` / `loginWithStudentIdService`, then the session
 * lookup every page uses) and replaces the temporary password; opens a camera
 * session; enrolls five guided samples through the unchanged enrollment core;
 * and the class's recognition run — pgvector, eligibility, scoring — marks
 * them present.
 *
 * And the parts only a database can show: the per-student advisory lock under
 * real concurrency (a double submit, a race for the last slot), the sample and
 * its audit row committing together or not at all, and a refused request
 * changing no row anywhere.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "selfenrol-it-";
const COLLEGE = `${P}college`;
const OTHER = `${P}other`;
const SCHOOL = `${P}school`;
const INSTITUTIONS = [COLLEGE, OTHER, SCHOOL];
const ADMIN = `${P}admin`;
const HEAD = `${P}head`;
const TEACHER = `${P}teacher`;
const OTHER_ADMIN = `${P}other-admin`;
const OTHER_TEACHER = `${P}other-teacher`;
const PRINCIPAL = `${P}principal`;
const SCHOOL_TEACHER = `${P}school-teacher`;
const SCHOOL_CLASS = `${P}class-7a`;

const ids: Record<string, string> = {};

function actor(userId: string, roleKey: string, institutionId: string): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@selfenrol.test`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}
const admin = () => actor(ADMIN, "COLLEGE_ADMIN", COLLEGE);
const hod = () => actor(HEAD, "HOD", COLLEGE);
const principal = () => actor(PRINCIPAL, "SCHOOL_ADMIN", SCHOOL);

// ---------------------------------------------------------------------------
// face-ai, replaced — and nothing else
// ---------------------------------------------------------------------------

const MODEL: ModelInfoResponse = {
  modelName: "selfenrol-it-model",
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

// One "face" is an axis; its samples lean slightly off it in different
// directions — five distinct templates that all match the face.
const unit = (weights: Record<number, number>): number[] => {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  let norm = 0;
  for (const [i, w] of Object.entries(weights)) {
    v[Number(i)] = w;
    norm += w * w;
  }
  return v.map((x) => x / Math.sqrt(norm));
};
const faceProbe = (face: number) => unit({ [face]: 1 });
const faceSample = (face: number, sample: number) => unit({ [face]: 1, [40 + sample]: 0.15 });

function faceAi(face: number, sample: number, options: { delayMs?: number; reply?: EnrollResponse } = {}): SelfEnrollmentDeps {
  const reply: EnrollResponse = options.reply ?? {
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
  return {
    faceModelInfo: async () => MODEL,
    faceEnroll: async () => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return reply;
    },
  };
}

/** A JPEG header as a canvas writes one; face-ai is replaced, so only its shape matters. */
function jpeg(width = 1280, height = 720, salt = 0): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, ...new Array<number>(400).fill(salt & 0xff), 0xff, 0xd9]).toString("base64");
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(300).fill(0)]).toString("base64");

// ---------------------------------------------------------------------------
// The institutions
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
      email: `${id}@selfenrol.test`,
      name: id,
      passwordHash: "x",
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

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

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: COLLEGE, name: "Self Enrollment College", type: "COLLEGE", settings: { attendanceMode: "SUBJECT_WISE" } },
      { id: OTHER, name: "Another College", type: "COLLEGE", settings: { attendanceMode: "SUBJECT_WISE" } },
      { id: SCHOOL, name: "Self Enrollment School", type: "SCHOOL", settings: {} },
    ],
  });
  for (const id of INSTITUTIONS) {
    await prisma.academicSession.create({
      data: { id: `${id}-now`, institutionId: id, name: "2026-27", startDate: new Date("2026-06-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    });
  }
  await staff(ADMIN, COLLEGE, "COLLEGE_ADMIN");
  await staff(HEAD, COLLEGE, "FACULTY");
  await staff(TEACHER, COLLEGE, "FACULTY");
  await staff(OTHER_ADMIN, OTHER, "COLLEGE_ADMIN");
  await staff(OTHER_TEACHER, OTHER, "FACULTY");
  await staff(PRINCIPAL, SCHOOL, "SCHOOL_ADMIN");
  await staff(SCHOOL_TEACHER, SCHOOL, "FACULTY");

  // The college: a department, its head, a current semester, a course and a section.
  ids.cse = (await college.createDepartment(admin(), { name: "Computer Science", code: "CSE" })).departmentId;
  await prisma.user.update({ where: { id: TEACHER }, data: { departmentId: ids.cse } });
  await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: HEAD });
  ids.sem = (await college.createSemester(hod(), { departmentId: ids.cse, number: 3 })).semesterId;
  await college.setCurrentSemester(hod(), { departmentId: ids.cse, semesterId: ids.sem });
  ids.course = (await college.createCourse(hod(), { semesterId: ids.sem, code: "DSA301", name: "Data Structures" })).courseId;
  [ids.section] = (
    await college.addCourseSections(hod(), {
      departmentId: ids.cse,
      semesterId: ids.sem,
      courseId: ids.course,
      sessionId: `${COLLEGE}-now`,
      sections: [{ name: "A", teacherId: TEACHER }],
    })
  ).sectionIds;

  // Another college, with a section of its own.
  const otherAdmin = actor(OTHER_ADMIN, "COLLEGE_ADMIN", OTHER);
  ids.otherCse = (await college.createDepartment(otherAdmin, { name: "Computer Science", code: "CSE" })).departmentId;
  await prisma.user.update({ where: { id: OTHER_TEACHER }, data: { departmentId: ids.otherCse } });
  ids.otherSem = (await college.createSemester(otherAdmin, { departmentId: ids.otherCse, number: 1 })).semesterId;
  ids.otherCourse = (await college.createCourse(otherAdmin, { semesterId: ids.otherSem, code: "CSE101", name: "Programming" })).courseId;
  [ids.otherSection] = (
    await college.addCourseSections(otherAdmin, {
      departmentId: ids.otherCse,
      semesterId: ids.otherSem,
      courseId: ids.otherCourse,
      sessionId: `${OTHER}-now`,
      sections: [{ name: "A", teacherId: OTHER_TEACHER }],
    })
  ).sectionIds;

  // The school: a grade and a class.
  await prisma.academicUnit.create({ data: { id: `${SCHOOL}-grade-7`, institutionId: SCHOOL, kind: "GRADE", name: "Grade 7" } });
  await prisma.cohort.create({
    data: { id: SCHOOL_CLASS, institutionId: SCHOOL, academicUnitId: `${SCHOOL}-grade-7`, academicSessionId: `${SCHOOL}-now`, name: "7A" },
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Signs in with the password staff issued, replaces it, and returns the session every page would see. */
async function signInAndReplacePassword(
  signIn: () => ReturnType<typeof loginService>,
  temporary: string,
  chosen: string,
): Promise<SessionUser> {
  const first = await signIn();
  assert.ok(first.ok, first.ok ? "" : `sign-in refused: ${first.reason}`);
  assert.equal(first.user.mustChangePassword, true, "a temporary password must be replaced first");
  const changed = await changeOwnPasswordService(first.user.userId, first.rawToken, { current: temporary, next: chosen, confirm: chosen });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const user = await getSessionUserByRawToken(first.rawToken);
  assert.ok(user, "the session resolves");
  assert.equal(user.mustChangePassword, false);
  return user;
}

/** An HOD admits a student with their login and no face; the student signs in. */
async function admitCollegeStudent(code: string, first: string, last: string): Promise<{ studentId: string; user: SessionUser }> {
  const email = `${first}.${last}@selfenrol.test`.toLowerCase();
  const admitted = await college.createDepartmentStudent(hod(), { departmentId: ids.cse, sectionId: ids.section }, newStudent(code, first, last, email));
  const user = await signInAndReplacePassword(() => loginService(email, admitted.password), admitted.password, `${code}-chose-this-1`);
  return { studentId: admitted.studentId, user };
}

async function enrollOnce(
  user: SessionUser,
  face: number,
  sample: number,
  options: { delayMs?: number; token?: string; salt?: number; reply?: EnrollResponse } = {},
) {
  const deps = faceAi(face, sample, options);
  const token =
    options.token ??
    (await (async () => {
      const started = await startOwnFaceCaptureRequest(user, deps);
      assert.equal(started.ok, true, started.ok ? "" : started.message);
      return started.ok ? started.captureToken : "";
    })());
  return enrollOwnFaceFromCameraRequest(
    user,
    { imageBase64: jpeg(1280, 720, options.salt ?? sample), captureSource: "CAMERA", captureToken: token },
    deps,
  );
}

async function enrollGuidedSet(user: SessionUser, face: number) {
  for (let sample = 0; sample < 5; sample++) {
    const result = await enrollOnce(user, face, sample);
    assert.equal(result.ok, true, `sample ${sample + 1}: ${result.ok ? "" : `${result.reason} — ${result.message}`}`);
  }
}

const activeSamples = (studentId: string) => prisma.faceEmbedding.count({ where: { studentId, isActive: true } });
const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? "ok" : result.reason);

async function recognise(
  teacher: SessionUser,
  session: { institutionId: string; cohortId: string; cohortSubjectId?: string | null; facultyId: string },
  face: number,
): Promise<RecognitionRunSummary> {
  const sessionId = `${P}session-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.attendanceSession.create({
    data: {
      id: sessionId,
      institutionId: session.institutionId,
      cohortId: session.cohortId,
      cohortSubjectId: session.cohortSubjectId ?? null,
      facultyId: session.facultyId,
      sessionDate: new Date("2026-09-30T00:00:00Z"),
      status: "OPEN",
    },
  });
  const detect = {
    faces: [
      {
        sequenceNumber: 1,
        boundingBox: { x: 0, y: 0, width: 120, height: 120 },
        embedding: faceProbe(face),
        detectionConfidence: 0.99,
        qualityScore: 0.9,
      },
    ],
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  } as DetectEmbedResponse;
  return runRecognitionForSession(
    teacher,
    { sessionId, images: [{ sequenceNumber: 1, imageBase64: "x".repeat(64) }] },
    {
      requireCohortAccess: async () => {},
      requireCohortSubjectAccess: async () => {},
      fetchModelInfo: async () => MODEL,
      detectEmbed: async () => detect,
    },
  );
}

// ---------------------------------------------------------------------------
// The lifecycle, college and school
// ---------------------------------------------------------------------------

test("14 (college). an HOD admits a student with no face; they sign in, enroll their own face from the camera, and recognition marks them present", { skip: SKIP }, async () => {
  const email = "asha.rao@selfenrol.test";
  const admitted = await college.createDepartmentStudent(
    hod(),
    { departmentId: ids.cse, sectionId: ids.section },
    newStudent("CSE201", "Asha", "Rao", email),
  );
  ids.asha = admitted.studentId;
  assert.equal(await activeSamples(admitted.studentId), 0, "admitted with no face");

  const user = await signInAndReplacePassword(() => loginService(email, admitted.password), admitted.password, "asha-chose-this-1");
  ids.ashaUser = user.userId;
  const before = await getOwnFaceEnrollmentOverview(user, faceAi(3, 0));
  assert.deepEqual([before.status.status, before.selfEnrollmentEnabled, before.enrolledOn], ["NOT_ENROLLED", true, null]);

  await enrollGuidedSet(user, 3);

  const rows = await prisma.faceEmbedding.findMany({ where: { studentId: admitted.studentId, isActive: true } });
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.deepEqual(
      [row.institutionId, row.channel, row.captureSource, row.enrolledByUserId, row.modelName, row.modelVersion, row.sourceImageUrl],
      [COLLEGE, "SELF", "CAMERA", user.userId, MODEL.modelName, MODEL.modelVersion, null],
    );
  }
  const created = await prisma.auditLog.count({ where: { action: "face_enrollment.created", actorUserId: user.userId, institutionId: COLLEGE } });
  assert.equal(created, 5, "each sample audited, by the student");

  const after = await getOwnFaceEnrollmentOverview(user, faceAi(3, 0));
  assert.deepEqual([after.status.status, after.status.usableSamples, after.status.remainingSlots], ["ENROLLED", 5, 0]);
  assert.ok(after.enrolledOn instanceof Date);

  // The section's subject class: the ordinary recognition run, which knows
  // nothing about how the templates were enrolled.
  const cohortSubject = await prisma.cohortSubject.findFirstOrThrow({ where: { cohortId: ids.section } });
  const summary = await recognise(
    actor(TEACHER, "FACULTY", COLLEGE),
    { institutionId: COLLEGE, cohortId: ids.section, cohortSubjectId: cohortSubject.id, facultyId: TEACHER },
    3,
  );
  const mine = summary.perStudent.find((s) => s.studentId === admitted.studentId);
  assert.equal(mine?.advisoryResult, "PRESENT", JSON.stringify(summary.perStudent));
});

test("14 (school). a principal adds a student and login with no face; once the school turns self-enrollment on, the student enrolls and the class register recognizes them", { skip: SKIP }, async () => {
  const created = await createStudentForRequest(principal(), { ...newStudent("7A-001", "Kabir", "Das", ""), cohortId: SCHOOL_CLASS });
  ids.kabir = created.id;
  const login = await provisionStudentLogin(principal(), created.id, {});
  assert.equal(await activeSamples(created.id), 0, "added with no face");

  const user = await signInAndReplacePassword(
    () => loginWithStudentIdService(SCHOOL, "7A-001", login.password),
    login.password,
    "kabir-chose-this-1",
  );

  // A school's default: staff enrol faces. The student is told so, and no
  // camera session is opened.
  const closed = await startOwnFaceCaptureRequest(user, faceAi(5, 0));
  assert.equal(closed.ok ? "ok" : closed.reason, "self_enrollment_disabled");

  await updateSelfEnrollmentPolicy(principal(), { selfEnrollmentEnabled: true });
  await enrollGuidedSet(user, 5);

  const rows = await prisma.faceEmbedding.findMany({ where: { studentId: created.id, isActive: true } });
  assert.deepEqual(
    [rows.length, new Set(rows.map((r) => `${r.institutionId}/${r.channel}/${r.captureSource}`))],
    [5, new Set([`${SCHOOL}/SELF/CAMERA`])],
  );

  const summary = await recognise(
    actor(SCHOOL_TEACHER, "FACULTY", SCHOOL),
    { institutionId: SCHOOL, cohortId: SCHOOL_CLASS, facultyId: SCHOOL_TEACHER },
    5,
  );
  assert.equal(summary.perStudent.find((s) => s.studentId === created.id)?.advisoryResult, "PRESENT", JSON.stringify(summary.perStudent));
});

// ---------------------------------------------------------------------------
// Concurrency, against the real lock
// ---------------------------------------------------------------------------

test("20. a double submit stores one template; the retry after it is 'already saved', not a second copy", { skip: SKIP }, async () => {
  const { studentId, user } = await admitCollegeStudent("CSE202", "Dev", "Mehta");
  const started = await startOwnFaceCaptureRequest(user, faceAi(7, 0));
  assert.ok(started.ok);
  const token = started.captureToken;

  const results = await Promise.all([
    enrollOnce(user, 7, 0, { delayMs: 400, token, salt: 1 }),
    enrollOnce(user, 7, 0, { delayMs: 400, token, salt: 1 }),
  ]);
  assert.deepEqual(results.map(reasonOf).sort(), ["enrollment_in_progress", "ok"]);
  assert.equal(await activeSamples(studentId), 1);

  // The browser gave up waiting and sends the same photograph again.
  const retry = await enrollOnce(user, 7, 0, { token, salt: 1 });
  assert.equal(reasonOf(retry), "already_enrolled");
  assert.equal(await activeSamples(studentId), 1);

  // Four tabs at once: one stored, three told to wait.
  const four = await Promise.all([1, 2, 3, 4].map((sample) => enrollOnce(user, 7, sample, { delayMs: 300, token, salt: 10 + sample })));
  assert.deepEqual(four.map(reasonOf).sort(), ["enrollment_in_progress", "enrollment_in_progress", "enrollment_in_progress", "ok"]);
  assert.equal(await activeSamples(studentId), 2);
});

test("the lock is per student: two students enrolling at the same moment both succeed", { skip: SKIP }, async () => {
  const one = await admitCollegeStudent("CSE203", "Isha", "Nair");
  const two = await admitCollegeStudent("CSE204", "Omar", "Khan");
  const results = await Promise.all([
    enrollOnce(one.user, 11, 0, { delayMs: 300 }),
    enrollOnce(two.user, 12, 0, { delayMs: 300 }),
  ]);
  assert.deepEqual(results.map(reasonOf), ["ok", "ok"]);
  assert.deepEqual([await activeSamples(one.studentId), await activeSamples(two.studentId)], [1, 1]);
});

test("the cap holds under a race: four samples and two photographs at once end at five, never six", { skip: SKIP }, async () => {
  const { studentId, user } = await admitCollegeStudent("CSE205", "Rhea", "Paul");
  for (let sample = 0; sample < 4; sample++) {
    assert.equal(reasonOf(await enrollOnce(user, 14, sample)), "ok");
  }
  const race = await Promise.all([enrollOnce(user, 14, 4, { delayMs: 300 }), enrollOnce(user, 14, 5, { delayMs: 300 })]);
  assert.deepEqual(race.map(reasonOf).sort(), ["enrollment_in_progress", "ok"]);
  assert.equal(await activeSamples(studentId), 5);
  const sixth = await startOwnFaceCaptureRequest(user, faceAi(14, 6));
  assert.equal(sixth.ok ? "ok" : sixth.reason, "sample_limit");
});

test("a sample and its audit row commit together: a failure part-way writes neither, and frees the lock", { skip: SKIP }, async () => {
  const { studentId, user } = await admitCollegeStudent("CSE206", "Tara", "Bose");
  const started = await startOwnFaceCaptureRequest(user, faceAi(16, 0));
  assert.ok(started.ok);
  const auditsBefore = await prisma.auditLog.count({ where: { actorUserId: user.userId, action: { startsWith: "face_enrollment." } } });
  await assert.rejects(
    () =>
      enrollOwnFaceFromCameraRequest(
        user,
        { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: started.captureToken },
        {
          ...faceAi(16, 0),
          // The sample is written through the lock's transaction; the audit
          // row after it fails, so the transaction — and the sample — go.
          recordAuditLog: async () => {
            throw new Error("audit log unavailable");
          },
        },
      ),
    /face_enrollment_failed/,
  );
  assert.equal(await activeSamples(studentId), 0, "no sample without its audit row");
  assert.equal(
    await prisma.auditLog.count({ where: { actorUserId: user.userId, action: { startsWith: "face_enrollment." } } }),
    auditsBefore,
  );
  assert.equal(reasonOf(await enrollOnce(user, 16, 0, { token: started.captureToken })), "ok", "the lock was released");
  assert.equal(await activeSamples(studentId), 1);
});

test("19. a photograph the quality gates refuse leaves nothing usable, and the next one is accepted", { skip: SKIP }, async () => {
  const { studentId, user } = await admitCollegeStudent("CSE207", "Neel", "Sahu");
  const blurred: EnrollResponse = {
    accepted: false,
    assessment: { reason: "blurred", qualityScore: 0.2, faceCount: 1 },
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  };
  const refused = await enrollOnce(user, 18, 0, { reply: blurred });
  assert.equal(reasonOf(refused), "blurred");
  assert.match(refused.message, /Hold your device steady/);
  assert.equal(await activeSamples(studentId), 0);
  assert.equal(reasonOf(await enrollOnce(user, 18, 0)), "ok");
});

// ---------------------------------------------------------------------------
// Camera only, and nobody else's record
// ---------------------------------------------------------------------------

test("11/13. upload-style requests against the real database change no row anywhere", { skip: SKIP }, async () => {
  const { studentId, user } = await admitCollegeStudent("CSE208", "Zoya", "Ali");
  const started = await startOwnFaceCaptureRequest(user, faceAi(20, 0));
  assert.ok(started.ok);
  const key = deriveSelfCaptureKey(process.env.AUTH_SECRET);
  const binding = { userId: user.userId, studentId, institutionId: COLLEGE };
  const expired = issueSelfCaptureToken(key, binding, Date.now() - SELF_CAPTURE_TOKEN_TTL_MS - 5_000).token;
  const snapshot = async () =>
    JSON.stringify(
      await Promise.all([
        prisma.faceEmbedding.count({ where: { institutionId: COLLEGE } }),
        prisma.auditLog.count({ where: { institutionId: COLLEGE, action: { startsWith: "face_enrollment." } } }),
      ]),
    );
  const before = await snapshot();
  for (const [label, input] of [
    ["an upload", { imageBase64: jpeg(), captureSource: "UPLOAD", captureToken: started.captureToken }],
    ["a PNG", { imageBase64: PNG, captureSource: "CAMERA", captureToken: started.captureToken }],
    ["a phone photograph at full size", { imageBase64: jpeg(4032, 3024), captureSource: "CAMERA", captureToken: started.captureToken }],
    ["no camera session", { imageBase64: jpeg(), captureSource: "CAMERA" }],
    ["an expired camera session", { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: expired }],
  ] as const) {
    const result = await enrollOwnFaceFromCameraRequest(user, input as never, faceAi(20, 0));
    assert.equal(reasonOf(result), "camera_required", label);
  }
  assert.equal(await snapshot(), before);
});

test("7/8/9/25. a camera session cannot cross to another student, college or school — and each session reaches only its own record", { skip: SKIP }, async () => {
  const mine = await admitCollegeStudent("CSE209", "Lina", "Roy");
  // A student at the other college, signed in for real.
  const otherAdmin = actor(OTHER_ADMIN, "COLLEGE_ADMIN", OTHER);
  const email = "sam.lee@selfenrol.test";
  const admitted = await college.createDepartmentStudent(
    otherAdmin,
    { departmentId: ids.otherCse, sectionId: ids.otherSection },
    newStudent("CSE209", "Sam", "Lee", email),
  );
  const theirs = await signInAndReplacePassword(() => loginService(email, admitted.password), admitted.password, "sam-chose-this-1");

  const theirSession = await startOwnFaceCaptureRequest(theirs, faceAi(22, 0));
  assert.ok(theirSession.ok);
  const across = await enrollOwnFaceFromCameraRequest(
    mine.user,
    { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: theirSession.captureToken },
    faceAi(22, 0),
  );
  assert.equal(reasonOf(across), "camera_required");
  // The school student from the lifecycle test, likewise.
  const schoolStudent = await prisma.student.findUniqueOrThrow({ where: { id: ids.kabir }, select: { userId: true } });
  const schoolKey = deriveSelfCaptureKey(process.env.AUTH_SECRET);
  const schoolToken = issueSelfCaptureToken(schoolKey, { userId: schoolStudent.userId!, studentId: ids.kabir, institutionId: SCHOOL }, Date.now()).token;
  assert.equal(
    reasonOf(await enrollOwnFaceFromCameraRequest(mine.user, { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: schoolToken }, faceAi(22, 0))),
    "camera_required",
  );
  assert.deepEqual([await activeSamples(mine.studentId), await activeSamples(admitted.studentId)], [0, 0]);

  // A session whose institution does not match the record it is linked to is
  // refused outright, whatever it asks for.
  const crossed: SessionUser = { ...mine.user, institutionId: OTHER, roles: mine.user.roles.map((r) => ({ ...r, institutionId: OTHER })) };
  await assert.rejects(() => startOwnFaceCaptureRequest(crossed, faceAi(22, 0)), ForbiddenError);

  // Each session's overview is its own.
  const own = await getOwnFaceEnrollmentOverview(theirs, faceAi(22, 0));
  assert.equal(own.status.status, "NOT_ENROLLED");
});

test("16. staff enrollment is unchanged: the head still enrolls from the department page, uploads included", { skip: SKIP }, async () => {
  const { studentId } = await admitCollegeStudent("CSE210", "Uma", "Iyer");
  const result = await college.enrollDepartmentStudentFace(
    hod(),
    { departmentId: ids.cse, studentId, imageBase64: PNG, captureSource: "UPLOAD" },
    "add",
    faceAi(24, 0),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  const row = await prisma.faceEmbedding.findFirstOrThrow({ where: { studentId, isActive: true } });
  assert.deepEqual([row.channel, row.captureSource, row.enrolledByUserId], ["STAFF", "UPLOAD", HEAD]);
});
