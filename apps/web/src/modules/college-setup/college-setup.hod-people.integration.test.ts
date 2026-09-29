import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_DIMENSION, type EnrollResponse, type ModelInfoResponse } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { ForbiddenError } from "@/modules/authorization/types";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { listCapturableCohortsForActor } from "@/modules/attendance-capture/service";
import { enrollFaceForStudentRequest } from "@/modules/face-enrollment/service";
import { getFacultyDirectory, inviteFaculty } from "@/modules/faculty/directory-service";
import { FacultyError } from "@/modules/faculty/directory-types";
import { findCandidateEmbeddingsWithVectorsForCohort } from "@/modules/recognition-results/repository";
import { StudentError } from "@/modules/students/directory-types";
import * as college from "./service.ts";
import { CollegeSetupError, SameCourseConflict } from "./types.ts";

/**
 * A head of department's Faculty and Students pages: adding a teacher to the
 * department and giving them a section, adding existing and new students to
 * the department's sections, moving and removing them, and enrolling a face
 * from the department — against a real Postgres, with a second department, a
 * second college and a school to reach for.
 *
 * Only face-ai is replaced, by a stand-in returning a fixed vector per "face";
 * the enrolment service's own checks — the model contract, the duplicate scan,
 * the sample history — all run for real, as does recognition's candidate read.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const A = "hp-it-inst";
const B = "hp-it-other";
const S = "hp-it-school";
const NOW = "hp-it-now";
const B_NOW = "hp-it-b-now";
const ADMIN = "hp-it-admin";
const HEAD = "hp-it-head";
const TA = "hp-it-teacher-a";
const TB = "hp-it-teacher-b";
const TM = "hp-it-teacher-mech";
const B_ADMIN = "hp-it-b-admin";
const B_TEACHER = "hp-it-b-teacher";
const S_ADMIN = "hp-it-s-admin";
const AMAN = "hp-it-s1";
const RAHUL = "hp-it-s2";
const PRIYA = "hp-it-s3";
const MEERA = "hp-it-mech";
const LEFT = "hp-it-left";
const ELSEWHERE = "hp-it-b1";
const INSTITUTIONS = [A, B, S];

function actor(userId: string, roleKey: string, institutionId: string): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@test.local`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId: null, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}

const admin = () => actor(ADMIN, "COLLEGE_ADMIN", A);
const hod = () => actor(HEAD, "HOD", A);
const teacher = (userId: string) => actor(userId, "FACULTY", A);
const refused = (pattern: RegExp) => (error: Error) => error instanceof CollegeSetupError && pattern.test(error.message);
const forbidden = (error: Error) => error instanceof ForbiddenError;

// ---------------------------------------------------------------------------
// face-ai, replaced
// ---------------------------------------------------------------------------

const MODEL: ModelInfoResponse = {
  modelName: "hp-it-model",
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
const MODEL_REF = { modelName: MODEL.modelName, modelVersion: MODEL.modelVersion };

/** One "face" is an axis; its samples lean slightly off it, so they match it and not each other's faces. */
function faceSample(face: number, sample: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[face] = 1;
  v[40 + sample] = 0.15;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Recognisably a photograph's bytes, so the tests can look for it where it must not be. */
const IMAGE = Buffer.from("hp-it: a photograph of a face, as JPEG bytes would be").toString("base64");

interface FaceAi {
  faceModelInfo: () => Promise<ModelInfoResponse>;
  faceEnroll: (imageBase64: string) => Promise<EnrollResponse>;
  /** Every image face-ai was sent. */
  sent: string[];
}

function faceAi(response: EnrollResponse | number[]): FaceAi {
  const sent: string[] = [];
  const reply: EnrollResponse = Array.isArray(response)
    ? {
        accepted: true,
        assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
        embedding: response,
        modelName: MODEL.modelName,
        modelVersion: MODEL.modelVersion,
        weightsVersion: MODEL.weightsVersion,
        preprocessingVersion: MODEL.preprocessingVersion,
        embeddingDim: EMBEDDING_DIMENSION,
        aligned: true,
      }
    : response;
  return {
    sent,
    faceModelInfo: async () => MODEL,
    faceEnroll: async (imageBase64) => {
      sent.push(imageBase64);
      return reply;
    },
  };
}

const rejected = (reason: "no_face" | "multiple_faces" | "low_quality"): EnrollResponse => ({
  accepted: false,
  assessment: { reason, qualityScore: 0.1, faceCount: reason === "no_face" ? 0 : 2 },
  modelName: MODEL.modelName,
  modelVersion: MODEL.modelVersion,
});

const capture = (studentId: string, departmentId = ids.cse) => ({
  departmentId,
  studentId,
  imageBase64: IMAGE,
  captureSource: "CAMERA" as const,
});

/**
 * Everything written to the console while `run` runs — which is where this
 * application's logs go — without printing it.
 */
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

/** A vector's components, as text — what a template looks like wherever it leaks to. */
const componentsOf = (vector: readonly number[]) => [...new Set(vector.filter((x) => x !== 0).map(String))];

/** No key called `embedding`, and no run of numbers the length of one, anywhere in `value`. */
function assertNoTemplate(value: unknown, where: string) {
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      assert.ok(
        !(node.length >= 16 && node.every((item) => typeof item === "number")),
        `${where}: a list of ${node.length} numbers at ${path}`,
      );
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (node && typeof node === "object" && !(node instanceof Date)) {
      for (const [key, child] of Object.entries(node)) {
        assert.notEqual(key, "embedding", `${where}: an embedding at ${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(value, "$");
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
  await prisma.user.deleteMany({ where });
  await prisma.institution.deleteMany({ where: { id: { in: INSTITUTIONS } } });
}

async function staff(id: string, institutionId: string, roleKey: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await prisma.user.create({
    data: {
      id,
      institutionId,
      email: `${id}@test.local`,
      name: id,
      passwordHash: "x",
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

async function student(id: string, institutionId: string, code: string, firstName: string, lastName: string, admissionNumber?: string) {
  await prisma.student.create({ data: { id, institutionId, studentCode: code, firstName, lastName, admissionNumber } });
}

const ids: Record<string, string> = {};
const physicsA = () => ({ departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyA });
const enrolment = (studentId: string, cohortId: string) =>
  prisma.enrollment.findUnique({ where: { studentId_cohortId: { studentId, cohortId } } });
const teachersOf = (cohortId: string) =>
  prisma.cohortFaculty.findMany({ where: { cohortId }, select: { userId: true, role: true }, orderBy: { userId: "asc" } });
const place = (studentId: string, sectionId: string, moveFrom?: string) =>
  college.addStudentToDepartmentSection(hod(), { departmentId: ids.cse, studentId, sectionId, moveFrom });
const newStudent = (studentCode: string, firstName: string, lastName: string, admissionNumber = "") => ({
  studentCode,
  firstName,
  lastName,
  // A new student is admitted with their Student Portal login, which needs a college email.
  email: `hp-it-${studentCode.toLowerCase()}@test.local`,
  phone: "",
  campusId: "",
  admissionNumber,
  admissionDate: "",
});

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  const settings = { attendanceMode: "SUBJECT_WISE" };
  await prisma.institution.createMany({
    data: [
      { id: A, name: "HOD People College", type: "COLLEGE", settings },
      { id: B, name: "Elsewhere College", type: "COLLEGE", settings },
      { id: S, name: "People School", type: "SCHOOL" },
    ],
  });
  await prisma.academicSession.createMany({
    data: [
      { id: NOW, institutionId: A, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
      { id: B_NOW, institutionId: B, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    ],
  });
  await staff(ADMIN, A, "COLLEGE_ADMIN");
  for (const id of [HEAD, TA, TB, TM]) await staff(id, A, "FACULTY");
  await staff(B_ADMIN, B, "COLLEGE_ADMIN");
  await staff(B_TEACHER, B, "FACULTY");
  await staff(S_ADMIN, S, "SCHOOL_ADMIN");

  // The Director's part: departments, a head, and each department's teachers.
  ids.cse = (await college.createDepartment(admin(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.me = (await college.createDepartment(admin(), { name: "Mechanical", code: "ME" })).departmentId;
  await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: HEAD });
  await prisma.user.updateMany({ where: { id: { in: [TA, TB] } }, data: { departmentId: ids.cse } });
  await prisma.user.update({ where: { id: TM }, data: { departmentId: ids.me } });

  // The head's courses: Physics with sections A and B, Chemistry with B.
  ids.s4 = (await college.createSemester(hod(), { departmentId: ids.cse, number: 4 })).semesterId;
  await college.setCurrentSemester(hod(), { departmentId: ids.cse, semesterId: ids.s4 });
  const inS4 = { departmentId: ids.cse, semesterId: ids.s4, sessionId: NOW };
  ids.phy = (await college.createCourse(hod(), { semesterId: ids.s4, code: "PHY401", name: "Physics" })).courseId;
  ids.che = (await college.createCourse(hod(), { semesterId: ids.s4, code: "CHE402", name: "Chemistry" })).courseId;
  [ids.phyA, ids.phyB] = (
    await college.addCourseSections(hod(), { ...inS4, courseId: ids.phy, sections: [{ name: "A", teacherId: TA }, { name: "B" }] })
  ).sectionIds;
  [ids.cheB] = (await college.addCourseSections(hod(), { ...inS4, courseId: ids.che, sections: [{ name: "B", teacherId: TB }] }))
    .sectionIds;

  // Mechanical's own course.
  ids.meS1 = (await college.createSemester(admin(), { departmentId: ids.me, number: 1 })).semesterId;
  ids.mec = (await college.createCourse(admin(), { departmentId: ids.me, semesterId: ids.meS1, code: "MEC101", name: "Mechanics" })).courseId;
  [ids.mecA] = (
    await college.addCourseSections(admin(), { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sessionId: NOW, sections: [{ name: "A", teacherId: TM }] })
  ).sectionIds;

  // Another college with a department, a section, a teacher and a student of its own.
  const bAdmin = actor(B_ADMIN, "COLLEGE_ADMIN", B);
  ids.bCse = (await college.createDepartment(bAdmin, { name: "Computer Science", code: "CSE" })).departmentId;
  await prisma.user.update({ where: { id: B_TEACHER }, data: { departmentId: ids.bCse } });
  ids.bS1 = (await college.createSemester(bAdmin, { departmentId: ids.bCse, number: 1 })).semesterId;
  ids.bCourse = (await college.createCourse(bAdmin, { departmentId: ids.bCse, semesterId: ids.bS1, code: "CSE101", name: "Programming" })).courseId;
  [ids.bSection] = (
    await college.addCourseSections(bAdmin, { departmentId: ids.bCse, semesterId: ids.bS1, courseId: ids.bCourse, sessionId: B_NOW, sections: [{ name: "A", teacherId: B_TEACHER }] })
  ).sectionIds;

  await student(AMAN, A, "CSE001", "Aman", "Kumar", "ADM-11");
  await student(RAHUL, A, "CSE002", "Rahul", "Singh");
  await student(PRIYA, A, "CSE003", "Priya", "Patel");
  await student(MEERA, A, "ME001", "Meera", "Iyer");
  await student(LEFT, A, "CSE090", "Left", "Early");
  await prisma.student.update({ where: { id: LEFT }, data: { status: "INACTIVE" } });
  await student(ELSEWHERE, B, "CSE001", "Aman", "Elsewhere");

  await college.addStudentToSection(admin(), physicsA(), PRIYA);
  await college.addStudentToSection(admin(), { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sectionId: ids.mecA }, MEERA);
  await college.addStudentToSection(bAdmin, { departmentId: ids.bCse, semesterId: ids.bS1, courseId: ids.bCourse, sectionId: ids.bSection }, ELSEWHERE);
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Faculty
// ---------------------------------------------------------------------------

test("1. the head opens their department's faculty: its members, what each teaches, and who they may manage", { skip: SKIP }, async () => {
  const view = await college.getDepartmentFaculty(hod(), ids.cse);
  assert.ok(view);
  assert.deepEqual(
    view.faculty.map((person) => [person.userId, person.isHead, person.member, person.manageable]),
    [
      [HEAD, true, true, false],
      [TA, false, true, true],
      [TB, false, true, true],
    ],
    "the head first; nobody from Mechanical; the head does not manage their own account here",
  );
  assert.deepEqual(
    view.faculty.map((person) => person.sections.map((section) => section.groupName)),
    [[], ["PHY401-A"], ["CHE402-B"]],
  );
  assert.equal(view.totalAll, 3);

  const filtered = async (filters: Parameters<typeof college.getDepartmentFaculty>[2]) =>
    (await college.getDepartmentFaculty(hod(), ids.cse, filters))?.faculty.map((person) => person.userId);
  assert.deepEqual(await filtered({ assigned: "unassigned" }), [HEAD]);
  assert.deepEqual(await filtered({ assigned: "assigned" }), [TA, TB]);
  assert.deepEqual(await filtered({ q: "teacher-b@test" }), [TB], "by email");
  assert.deepEqual(await filtered({ status: "inactive" }), []);

  const member = await college.getDepartmentFacultyMember(hod(), ids.cse, TA);
  assert.deepEqual(
    member?.sectionChoices.map((choice) => [choice.groupName, choice.teacher?.userId ?? null]),
    [
      ["CHE402-B", TB],
      ["PHY401-A", TA],
      ["PHY401-B", null],
    ],
    "only the department's own sections this session, each with who teaches it",
  );
});

test("2. the head adds a teacher to their department through the Faculty page's account service", { skip: SKIP }, async () => {
  const { value: invited, lines } = await logsOf(() =>
    college.addDepartmentFaculty(hod(), {
      departmentId: ids.cse,
      name: "Arun Kumar",
      email: "hp-it-arun@test.local",
      employeeCode: "FAC-9",
    }),
  );
  ids.arun = invited.member.id;
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: ids.arun },
    select: { institutionId: true, departmentId: true, status: true, passwordHash: true, roleAssignments: { select: { role: { select: { key: true } } } } },
  });
  assert.deepEqual(
    [row.institutionId, row.departmentId, row.status, row.roleAssignments.map((assignment) => assignment.role.key)],
    [A, ids.cse, "ACTIVE", ["DEPARTMENT_FACULTY"]],
    "in this college and this department, with the department's teaching role and nothing more",
  );

  // The password is handed back once; what is kept is a hash of it, and it is nowhere else.
  assert.ok(invited.password.length >= 12);
  assert.ok(row.passwordHash && row.passwordHash !== invited.password && !row.passwordHash.includes(invited.password));
  const audits = await prisma.auditLog.findMany({ where: { institutionId: A, entityId: ids.arun } });
  assert.deepEqual(audits.map((entry) => [entry.action, entry.actorUserId]), [["user.created", HEAD]]);
  assert.ok(!JSON.stringify(audits).includes(invited.password), "the audit row has no password in it");
  assert.ok(!lines.join("\n").includes(invited.password), "nor does anything logged");

  const listed = await college.getDepartmentFaculty(hod(), ids.cse, { q: "FAC-9" });
  assert.deepEqual(
    listed?.faculty.map((person) => [person.name, person.email, person.employeeCode, person.status, person.manageable, person.sections]),
    [["Arun Kumar", "hp-it-arun@test.local", "FAC-9", "ACTIVE", true, []]],
  );

  // The service's own rules still apply: one account per address.
  await assert.rejects(
    () => college.addDepartmentFaculty(hod(), { departmentId: ids.cse, name: "Arun again", email: "HP-IT-ARUN@test.local" }),
    (error: Error) => error instanceof FacultyError && /already uses/.test(error.message),
  );

  // Their name and faculty ID are the head's to correct; their access the head's to stop and restore.
  await college.updateDepartmentFacultyMember(hod(), { departmentId: ids.cse, userId: ids.arun, name: "Arun Kumar", employeeCode: "FAC-10" });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.arun } })).employeeCode, "FAC-10");
  await college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: ids.arun, active: false });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.arun } })).status, "INACTIVE");
  await college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: ids.arun, active: true });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.arun } })).status, "ACTIVE");
  const actions = (await prisma.auditLog.findMany({ where: { institutionId: A, entityId: ids.arun }, orderBy: { createdAt: "asc" } })).map(
    (entry) => entry.action,
  );
  assert.deepEqual(actions, ["user.created", "user.updated", "user.deactivated", "user.reactivated"]);

  // Not their own account, and not a college administrator's that happens to sit in the department.
  await assert.rejects(
    () => college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: HEAD, active: false }),
    refused(/your own account/),
  );
  await prisma.user.update({ where: { id: ADMIN }, data: { departmentId: ids.cse } });
  try {
    await assert.rejects(
      () => college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: ADMIN, active: false }),
      refused(/college administrator/),
    );
    await assert.rejects(
      () => college.updateDepartmentFacultyMember(hod(), { departmentId: ids.cse, userId: ADMIN, name: "Renamed" }),
      refused(/college administrator/),
    );
  } finally {
    await prisma.user.update({ where: { id: ADMIN }, data: { departmentId: null } });
  }
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ADMIN } })).status, "ACTIVE");
});

test("2b. a head enables again only an account they disabled — one the Director disabled stays so", { skip: SKIP }, async () => {
  const member = async () => (await college.getDepartmentFacultyMember(hod(), ids.cse, ids.arun))?.person;
  const status = async () => (await prisma.user.findUniqueOrThrow({ where: { id: ids.arun } })).status;

  // Disabled by the head: theirs to enable again.
  await college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: ids.arun, active: false });
  assert.deepEqual([(await member())?.status, (await member())?.enableable], ["INACTIVE", true]);
  await college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: ids.arun, active: true });
  assert.equal(await status(), "ACTIVE");

  // Disabled by the Director: the head cannot undo it, and the page does not offer it.
  await college.setDepartmentFacultyActive(admin(), { departmentId: ids.cse, userId: ids.arun, active: false });
  assert.deepEqual([(await member())?.status, (await member())?.enableable], ["INACTIVE", false]);
  const listed = await college.getDepartmentFaculty(hod(), ids.cse, { q: "arun" });
  assert.deepEqual(listed?.faculty.map((person) => [person.manageable, person.enableable]), [[true, false]]);
  await assert.rejects(
    () => college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: ids.arun, active: true }),
    refused(/not disabled by you, so only the college administrator can enable it again/),
  );
  assert.equal(await status(), "INACTIVE");
  // Nor after the head disables it "again" on top: the Director's stop is the one that stands.
  assert.equal((await college.getDepartmentFacultyMember(admin(), ids.cse, ids.arun))?.person.enableable, true, "the Director may");
  await college.setDepartmentFacultyActive(admin(), { departmentId: ids.cse, userId: ids.arun, active: true });
  assert.equal(await status(), "ACTIVE");
});

test("3. the head cannot add a teacher to another department, or with the college-wide staff service", { skip: SKIP }, async () => {
  const before = await prisma.user.count({ where: { institutionId: { in: INSTITUTIONS } } });
  const add = (departmentId: string) =>
    college.addDepartmentFaculty(hod(), { departmentId, name: "Sneaky", email: `hp-it-sneaky-${departmentId}@test.local` });
  await assert.rejects(() => add(ids.me), refused(/not part of this college/));
  await assert.rejects(() => add(ids.bCse), refused(/not part of this college/));
  await assert.rejects(() => add(ids.s4), refused(/not part of this college/), "a semester's id is not a department");
  await assert.rejects(() => add(""), refused(/not part of this college/));
  // The head holds no staff permission of their own: the college-wide service refuses them outright.
  await assert.rejects(
    () => inviteFaculty(hod(), { name: "Sneaky", email: "hp-it-sneaky@test.local", departmentId: ids.me, roleKey: "FACULTY" }),
    forbidden,
  );
  await assert.rejects(() => getFacultyDirectory(hod()), forbidden);
  assert.equal(await prisma.user.count({ where: { institutionId: { in: INSTITUTIONS } } }), before, "no account was created");
});

test("4. the head cannot read or change another department's or another college's teachers", { skip: SKIP }, async () => {
  assert.equal(await college.getDepartmentFaculty(hod(), ids.bCse), null);
  assert.equal(await college.getDepartmentFaculty(hod(), ids.me), null);
  assert.equal(await college.getDepartmentFacultyMember(hod(), ids.cse, B_TEACHER), null);
  assert.equal(await college.getDepartmentFacultyMember(hod(), ids.bCse, B_TEACHER), null);
  assert.equal(await college.getDepartmentFacultyMember(hod(), ids.cse, TM), null, "Mechanical's teacher teaches nothing here");
  assert.equal(await college.getDepartmentFacultyMember(hod(), ids.me, TM), null);
  assert.equal(await college.getDepartmentFacultyMember(hod(), ids.cse, AMAN), null, "a student id is nobody's teacher");

  for (const userId of [B_TEACHER, TM, "no-such-user", ""]) {
    await assert.rejects(
      () => college.updateDepartmentFacultyMember(hod(), { departmentId: ids.cse, userId, name: "Renamed" }),
      refused(/not a member of this department/),
    );
    await assert.rejects(
      () => college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId, active: false }),
      refused(/not a member of this department/),
    );
  }
  await assert.rejects(
    () => college.setDepartmentFacultyActive(hod(), { departmentId: ids.me, userId: TM, active: false }),
    refused(/not part of this college/),
  );
  const untouched = await prisma.user.findMany({ where: { id: { in: [B_TEACHER, TM] } }, select: { name: true, status: true } });
  assert.deepEqual(untouched.map((person) => [person.name, person.status]).sort(), [
    [B_TEACHER, "ACTIVE"],
    [TM, "ACTIVE"],
  ]);
});

test("5. the head gives their new teacher one of the department's sections, from the Faculty page", { skip: SKIP }, async () => {
  const result = await college.assignFacultyToSection(hod(), {
    departmentId: ids.cse,
    userId: ids.arun,
    sectionId: ids.phyB,
    expectedTeacherId: "",
  });
  assert.deepEqual([result.teacherName, result.replaced, result.ids], [
    "Arun Kumar",
    [],
    { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyB },
  ]);
  assert.deepEqual(await teachersOf(ids.phyB), [{ userId: ids.arun, role: "PRIMARY" }]);
  const courseLink = await prisma.cohortSubject.findFirstOrThrow({ where: { cohortId: ids.phyB } });
  assert.equal(courseLink.facultyId, ids.arun, "the course's teacher too, as the section page sets it");
  const audits = await prisma.auditLog.findMany({ where: { institutionId: A, action: "cohort_faculty.assigned", actorUserId: HEAD } });
  assert.ok(audits.some((entry) => (entry.afterJson as { userId?: string }).userId === ids.arun));

  // Their row and their page show it; they can take the section's attendance.
  const member = await college.getDepartmentFacultyMember(hod(), ids.cse, ids.arun);
  assert.deepEqual(member?.person.sections.map((section) => [section.courseName, section.label]), [["Physics", "Section B"]]);
  assert.deepEqual((await listCapturableCohortsForActor(teacher(ids.arun))).map((cohort) => cohort.name), ["PHY401-B"]);

  // A disabled account is not given a section.
  await college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: TB, active: false });
  try {
    await assert.rejects(
      () => college.assignFacultyToSection(hod(), { departmentId: ids.cse, userId: TB, sectionId: ids.phyA, expectedTeacherId: TA }),
      refused(/access has been stopped/),
    );
  } finally {
    await college.setDepartmentFacultyActive(hod(), { departmentId: ids.cse, userId: TB, active: true });
  }
});

test("6. the head cannot give a section to a teacher from elsewhere, or a section from elsewhere to anyone", { skip: SKIP }, async () => {
  const assign = (input: { departmentId?: string; userId: string; sectionId: string; expectedTeacherId: string }) =>
    college.assignFacultyToSection(hod(), { departmentId: ids.cse, ...input });
  await assert.rejects(() => assign({ userId: TM, sectionId: ids.cheB, expectedTeacherId: TB }), refused(/not in your department/));
  await assert.rejects(() => assign({ userId: B_TEACHER, sectionId: ids.cheB, expectedTeacherId: TB }), refused(/not part of this college/));
  await assert.rejects(() => assign({ userId: ids.arun, sectionId: ids.mecA, expectedTeacherId: TM }), refused(/not part of this department/));
  await assert.rejects(
    () => assign({ departmentId: ids.me, userId: ids.arun, sectionId: ids.mecA, expectedTeacherId: TM }),
    refused(/not part of this college/),
  );
  await assert.rejects(() => assign({ userId: ids.arun, sectionId: ids.bSection, expectedTeacherId: B_TEACHER }), refused(/not part of this department/));
  await assert.rejects(() => assign({ userId: ids.arun, sectionId: ids.phy, expectedTeacherId: "" }), refused(/not part of this department/), "a course's id is not a section");
  assert.deepEqual(await teachersOf(ids.cheB), [{ userId: TB, role: "PRIMARY" }]);
  assert.deepEqual(await teachersOf(ids.mecA), [{ userId: TM, role: "PRIMARY" }]);
  assert.deepEqual(await teachersOf(ids.bSection), [{ userId: B_TEACHER, role: "PRIMARY" }]);
});

test("7. a section that has a teacher changes hands only on purpose, and never gains a second", { skip: SKIP }, async () => {
  const assign = (userId: string, expectedTeacherId: string) =>
    college.assignFacultyToSection(hod(), { departmentId: ids.cse, userId, sectionId: ids.phyB, expectedTeacherId });
  await assert.rejects(() => assign(ids.arun, ids.arun), refused(/already teaches this section/));
  // The screen showed the section free, or somebody else teaching it: nothing changes.
  await assert.rejects(() => assign(TA, ""), refused(/is taught by Arun Kumar now/));
  await assert.rejects(() => assign(TA, TB), refused(/is taught by Arun Kumar now/));
  assert.deepEqual(await teachersOf(ids.phyB), [{ userId: ids.arun, role: "PRIMARY" }]);

  // "Replace Arun Kumar": one teacher again, the new one.
  const replaced = await assign(TA, ids.arun);
  assert.deepEqual(replaced.replaced, ["Arun Kumar"]);
  assert.deepEqual(await teachersOf(ids.phyB), [{ userId: TA, role: "PRIMARY" }]);
  await assign(ids.arun, TA);
  assert.deepEqual(await teachersOf(ids.phyB), [{ userId: ids.arun, role: "PRIMARY" }]);
});

test("8. the Director's faculty tools are unchanged, and see what the head did", { skip: SKIP }, async () => {
  const mechanical = await college.getDepartmentFaculty(admin(), ids.me);
  assert.deepEqual(mechanical?.faculty.map((person) => [person.userId, person.manageable]), [[TM, true]]);
  const directory = await getFacultyDirectory(admin());
  assert.ok(directory.members.some((member) => member.id === ids.arun && member.departmentId === ids.cse), "the head's new teacher is on the Faculty page");

  // The Director may add to any department, and give a section to a teacher of another department.
  const invited = await college.addDepartmentFaculty(admin(), { departmentId: ids.me, name: "Kiran Rao", email: "hp-it-kiran@test.local" });
  const kiran = await prisma.user.findUniqueOrThrow({
    where: { id: invited.member.id },
    select: { departmentId: true, roleAssignments: { select: { role: { select: { key: true } } } } },
  });
  assert.deepEqual(
    [kiran.departmentId, kiran.roleAssignments.map((assignment) => assignment.role.key)],
    [ids.me, ["FACULTY"]],
    "the Director's new teacher is an ordinary teacher, as before",
  );
  await college.assignFacultyToSection(admin(), { departmentId: ids.me, userId: TA, sectionId: ids.mecA, expectedTeacherId: TM });
  assert.deepEqual(await teachersOf(ids.mecA), [{ userId: TA, role: "PRIMARY" }]);
  await college.assignFacultyToSection(admin(), { departmentId: ids.me, userId: TM, sectionId: ids.mecA, expectedTeacherId: TA });
  assert.deepEqual(await teachersOf(ids.mecA), [{ userId: TM, role: "PRIMARY" }]);
  // And the head's department page is theirs to open, too.
  assert.ok(await college.getDepartmentFacultyMember(admin(), ids.cse, ids.arun));
});

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

test("9. the head opens their department's students: everyone in its sections, and nobody else's", { skip: SKIP }, async () => {
  const view = await college.getDepartmentStudents(hod(), ids.cse);
  assert.ok(view);
  assert.deepEqual(
    view.students.map((row) => [row.studentId, row.sections.map((section) => section.groupName), row.faceEnrolled, row.login]),
    [[PRIYA, ["PHY401-A"], false, "none"]],
  );
  assert.deepEqual(view.courses.map((course) => course.code).sort(), ["CHE402", "PHY401"]);
  assert.deepEqual(view.sections.map((section) => section.groupName), ["CHE402-B", "PHY401-A", "PHY401-B"]);
});

test("10. the head searches the college's students by name, student ID or admission number", { skip: SKIP }, async () => {
  const found = async (query: string) =>
    (await college.searchStudentsForDepartment(hod(), ids.cse, query))?.results.map((row) => row.studentId);
  assert.deepEqual(await found("aman"), [AMAN], "this college's Aman, not the other college's");
  assert.deepEqual(await found("CSE001"), [AMAN]);
  assert.deepEqual(await found("adm-11"), [AMAN]);
  assert.deepEqual(await found("Meera"), [MEERA], "a student of another department can join one of these courses");
  const short = await college.searchStudentsForDepartment(hod(), ids.cse, "a");
  assert.deepEqual([short?.searched, short?.results], [false, []], "one letter is not a search");
  const priya = await college.searchStudentsForDepartment(hod(), ids.cse, "Priya");
  assert.deepEqual(priya?.results[0].sections.map((section) => section.groupName), ["PHY401-A"], "where they are already");

  // The list's own search and filters.
  const listed = async (filters: Parameters<typeof college.getDepartmentStudents>[2]) =>
    (await college.getDepartmentStudents(hod(), ids.cse, filters))?.students.map((row) => row.studentId);
  assert.deepEqual(await listed({ q: "patel" }), [PRIYA]);
  assert.deepEqual(await listed({ q: "kumar" }), []);
  assert.deepEqual(await listed({ courseId: ids.che }), []);
  assert.deepEqual(await listed({ sectionId: ids.phyA }), [PRIYA]);
  assert.deepEqual(await listed({ face: "enrolled" }), []);
  assert.deepEqual(await listed({ login: "none" }), [PRIYA]);
});

test("11. the head adds an existing student to one of their sections, once", { skip: SKIP }, async () => {
  const pick = await college.getDepartmentStudentPick(hod(), ids.cse, AMAN);
  assert.deepEqual(
    [pick?.student.studentCode, pick?.student.admissionNumber, pick?.placements],
    ["CSE001", "ADM-11", []],
  );
  assert.deepEqual(pick?.sectionChoices.map((choice) => choice.groupName), ["CHE402-B", "PHY401-A", "PHY401-B"], "the department's sections only");

  const added = await place(AMAN, ids.phyA);
  assert.deepEqual([added.name, added.moved, added.ids], ["Aman Kumar", false, physicsA()]);
  assert.equal((await enrolment(AMAN, ids.phyA))?.status, "ACTIVE");
  const audit = await prisma.auditLog.findFirst({ where: { institutionId: A, action: "enrollment.created", actorUserId: HEAD } });
  assert.ok(audit, "recorded as the head's doing");

  await assert.rejects(() => place(AMAN, ids.phyA), refused(/already in PHY401-A/));
  assert.equal(await prisma.enrollment.count({ where: { studentId: AMAN, cohortId: ids.phyA } }), 1, "no second enrolment");
  await assert.rejects(() => place(LEFT, ids.phyA), refused(/not on roll/));
  assert.equal(await enrolment(LEFT, ids.phyA), null);

  // The section page — the other way in — shows them.
  const section = await college.getCourseSectionDetail(hod(), physicsA());
  assert.deepEqual(section?.students.map((row) => row.studentCode).sort(), ["CSE001", "CSE003"]);
});

test("12. the head admits a new student through the student service, straight into a section", { skip: SKIP }, async () => {
  const created = await college.createDepartmentStudent(
    hod(),
    { departmentId: ids.cse, sectionId: ids.cheB },
    newStudent("CSE010", "Neha", "Verma", "ADM-20"),
  );
  ids.neha = created.studentId;
  const row = await prisma.student.findUniqueOrThrow({ where: { id: created.studentId } });
  assert.deepEqual(
    [row.institutionId, row.studentCode, row.admissionNumber, row.status, row.email],
    [A, "CSE010", "ADM-20", "ACTIVE", "hp-it-cse010@test.local"],
  );
  assert.ok(row.userId, "admitted with their Student Portal login");
  assert.equal((await enrolment(created.studentId, ids.cheB))?.status, "ACTIVE");
  const detail = await college.getDepartmentStudent(hod(), ids.cse, created.studentId);
  assert.deepEqual(detail?.placements.map((placement) => placement.groupName), ["CHE402-B"], "their page opens on the section they joined");
  const actions = (await prisma.auditLog.findMany({ where: { institutionId: A, actorUserId: HEAD, OR: [{ entityId: created.studentId }, { action: "enrollment.created" }] } }))
    .filter((entry) => entry.entityId === created.studentId || (entry.afterJson as { studentId?: string }).studentId === created.studentId)
    .map((entry) => entry.action)
    .sort();
  assert.deepEqual(actions, ["enrollment.created", "student.created"]);

  // The student service's own checks: a code is one student's.
  await assert.rejects(
    () => college.createDepartmentStudent(hod(), { departmentId: ids.cse, sectionId: ids.cheB }, newStudent("CSE010", "Other", "Person")),
    (error: Error) => error instanceof StudentError && /already belongs to Neha Verma/.test(error.message),
  );
  // And only into this department's sections.
  const before = await prisma.student.count({ where: { institutionId: A } });
  await assert.rejects(
    () => college.createDepartmentStudent(hod(), { departmentId: ids.cse, sectionId: ids.mecA }, newStudent("CSE011", "Wrong", "Place")),
    refused(/not part of this department/),
  );
  await assert.rejects(
    () => college.createDepartmentStudent(hod(), { departmentId: ids.cse, sectionId: "" }, newStudent("CSE012", "No", "Section")),
    refused(/Choose one of the department's sections/),
  );
  assert.equal(await prisma.student.count({ where: { institutionId: A } }), before, "nobody half-created");
});

test("13. one student is in several courses' sections at once — and in one section of each course", { skip: SKIP }, async () => {
  await place(AMAN, ids.cheB);
  assert.equal((await enrolment(AMAN, ids.phyA))?.status, "ACTIVE", "adding Chemistry B leaves Physics A");
  assert.equal((await enrolment(AMAN, ids.cheB))?.status, "ACTIVE");

  // Physics B is the same course as Physics A: refused unless it is a move, of exactly that section.
  await assert.rejects(
    () => place(AMAN, ids.phyB),
    (error: Error) => error instanceof SameCourseConflict && error.current.sectionId === ids.phyA && /Physics — Section A/.test(error.message),
  );
  await assert.rejects(() => place(AMAN, ids.phyB, ids.cheB), SameCourseConflict);
  assert.equal(await enrolment(AMAN, ids.phyB), null);

  const moved = await place(AMAN, ids.phyB, ids.phyA);
  assert.equal(moved.moved, true);
  assert.deepEqual(
    [(await enrolment(AMAN, ids.phyA))?.status, (await enrolment(AMAN, ids.phyB))?.status, (await enrolment(AMAN, ids.cheB))?.status],
    ["INACTIVE", "ACTIVE", "ACTIVE"],
  );
  await place(AMAN, ids.phyA, ids.phyB);
  // A move from a section they are not in is just an add.
  assert.equal((await place(RAHUL, ids.phyA, ids.phyB)).moved, false);

  const detail = await college.getDepartmentStudent(hod(), ids.cse, AMAN);
  assert.deepEqual(
    detail?.placements.map((placement) => [placement.course.name, placement.label, placement.teacher?.userId ?? null]),
    [
      ["Chemistry", "Section B", TB],
      ["Physics", "Section A", TA],
    ],
  );
  assert.deepEqual(
    detail?.sectionChoices.map((choice) => [choice.groupName, choice.inSection, choice.sameCourseSection?.sectionId ?? null]),
    [
      ["CHE402-B", true, null],
      ["PHY401-A", true, null],
      ["PHY401-B", false, ids.phyA],
    ],
    "Physics B is offered as a move from Physics A",
  );
  assert.equal(await prisma.enrollment.count({ where: { studentId: AMAN } }), 3, "one row per section ever joined, never a second");
});

// ---------------------------------------------------------------------------
// Face enrolment from the department
// ---------------------------------------------------------------------------

test("19. the head enrols a department student's face through the administrator's enrolment service", { skip: SKIP }, async () => {
  const ai = faceAi(faceSample(1, 0));
  const screen = await college.getDepartmentStudentFace(hod(), ids.cse, AMAN, ai);
  assert.deepEqual(
    [screen?.student.studentCode, screen?.status.status, screen?.status.usableSamples, screen?.runningModel?.modelVersion],
    ["CSE001", "NOT_ENROLLED", 0, MODEL.modelVersion],
  );

  const { value: result, lines } = await logsOf(() => college.enrollDepartmentStudentFace(hod(), capture(AMAN), "add", ai));
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.deepEqual(ai.sent, [IMAGE], "face-ai saw the photograph once");
  const row = await prisma.faceEmbedding.findUniqueOrThrow({
    where: { id: result.ok ? result.embeddingId : "" },
    select: { studentId: true, institutionId: true, enrolledByUserId: true, channel: true, captureSource: true, isActive: true, modelName: true, modelVersion: true, sourceImageUrl: true },
  });
  assert.deepEqual(row, {
    studentId: AMAN,
    institutionId: A,
    enrolledByUserId: HEAD,
    channel: "STAFF",
    captureSource: "CAMERA",
    isActive: true,
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    sourceImageUrl: null,
  });
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { institutionId: A, action: "face_enrollment.created" } });
  assert.deepEqual([audit.actorUserId, audit.entityId], [HEAD, result.ok ? result.embeddingId : ""]);
  ids.logLines = lines.join("\n");

  // The student's page and the list now say so — as a count and a date.
  const detail = await college.getDepartmentStudent(hod(), ids.cse, AMAN);
  assert.deepEqual([detail?.face.enrolled, detail?.face.activeSamples], [true, 1]);
  assert.ok(detail?.face.lastEnrolledAt instanceof Date);
  const enrolled = await college.getDepartmentStudents(hod(), ids.cse, { face: "enrolled" });
  assert.deepEqual(enrolled?.students.map((row) => row.studentId), [AMAN]);

  // Another sample, then a replacement of the set — the same two paths the administrator has.
  assert.equal((await college.enrollDepartmentStudentFace(hod(), capture(AMAN), "add", faceAi(faceSample(1, 1)))).ok, true);
  const replaced = await college.enrollDepartmentStudentFace(hod(), capture(AMAN), "replace", faceAi(faceSample(1, 2)));
  assert.deepEqual([replaced.ok, replaced.ok && replaced.replaced], [true, 2]);
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: AMAN, isActive: true } }), 1);
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: AMAN } }), 3, "retired samples are kept as history");
});

test("20. the enrolment service's own checks run on the department's path", { skip: SKIP }, async () => {
  const facesOf = (studentId: string) => prisma.faceEmbedding.count({ where: { studentId } });

  // A photograph face-ai turns down.
  const noFace = await college.enrollDepartmentStudentFace(hod(), capture(PRIYA), "add", faceAi(rejected("no_face")));
  assert.deepEqual([noFace.ok, !noFace.ok && noFace.reason], [false, "no_face"]);
  const blurry = await college.enrollDepartmentStudentFace(hod(), capture(PRIYA), "add", faceAi(rejected("low_quality")));
  assert.deepEqual([blurry.ok, !blurry.ok && blurry.reason], [false, "low_quality"]);

  // A vector that breaks the model's contract.
  const broken = await college.enrollDepartmentStudentFace(hod(), capture(PRIYA), "add", faceAi([1, 0, 0]));
  assert.deepEqual([broken.ok, !broken.ok && broken.reason], [false, "invalid_embedding"]);

  // Aman's face, offered as Priya's: the duplicate scan across the college catches it.
  const duplicate = await college.enrollDepartmentStudentFace(hod(), capture(PRIYA), "add", faceAi(faceSample(1, 3)));
  assert.deepEqual([duplicate.ok, !duplicate.ok && duplicate.reason], [false, "duplicate_identity"]);
  assert.equal(await facesOf(PRIYA), 0, "nothing was stored for any of them");

  // Her own face is accepted.
  assert.equal((await college.enrollDepartmentStudentFace(hod(), capture(PRIYA), "add", faceAi(faceSample(3, 0)))).ok, true);
  assert.equal(await facesOf(PRIYA), 1);
});

test("21. what the head enrols, recognition reads exactly as it reads the administrator's", { skip: SKIP }, async () => {
  // The administrator enrols Rahul from the Students screen's service, with the same stand-in.
  const ai = faceAi(faceSample(2, 0));
  const byAdmin = await enrollFaceForStudentRequest(admin(), { studentId: RAHUL, imageBase64: IMAGE, captureSource: "CAMERA" }, ai);
  assert.equal(byAdmin.ok, true);
  assert.deepEqual(ai.sent, [IMAGE], "the same request reaches face-ai either way");

  const fields = { channel: true, captureSource: true, isActive: true, modelName: true, modelVersion: true, weightsVersion: true, preprocessingVersion: true, embeddingDim: true, aligned: true } as const;
  const [headsRow, adminsRow] = await Promise.all([
    prisma.faceEmbedding.findFirstOrThrow({ where: { studentId: AMAN, isActive: true }, select: fields }),
    prisma.faceEmbedding.findFirstOrThrow({ where: { studentId: RAHUL, isActive: true }, select: fields }),
  ]);
  assert.deepEqual(headsRow, adminsRow, "one kind of template, whoever enrolled it");

  // Recognition's own candidate read for Physics A: everyone enrolled in it with a face, under the running model.
  const candidates = await findCandidateEmbeddingsWithVectorsForCohort(ids.phyA, MODEL_REF);
  assert.deepEqual([...new Set(candidates.map((row) => row.studentId))].sort(), [AMAN, RAHUL, PRIYA].sort());
  assert.ok(candidates.every((row) => row.embedding.length === EMBEDDING_DIMENSION));
  assert.deepEqual(await findCandidateEmbeddingsWithVectorsForCohort(ids.cheB, MODEL_REF).then((rows) => rows.map((row) => row.studentId)), [AMAN]);
});

test("22. no template or photograph reaches a page, an audit row or a log", { skip: SKIP }, async () => {
  const vectors = [faceSample(1, 0), faceSample(1, 1), faceSample(1, 2), faceSample(3, 0), faceSample(2, 0)];
  const secrets = [IMAGE, ...vectors.flatMap(componentsOf)];
  const pages = {
    student: await college.getDepartmentStudent(hod(), ids.cse, AMAN),
    students: await college.getDepartmentStudents(hod(), ids.cse),
    face: await college.getDepartmentStudentFace(hod(), ids.cse, AMAN, faceAi(faceSample(1, 0))),
    search: await college.searchStudentsForDepartment(hod(), ids.cse, "Aman"),
    pick: await college.getDepartmentStudentPick(hod(), ids.cse, AMAN),
  };
  for (const [name, page] of Object.entries(pages)) {
    assert.ok(page, name);
    assertNoTemplate(page, name);
    const text = JSON.stringify(page);
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name} carries ${secret.slice(0, 12)}…`);
  }
  const { value: result, lines } = await logsOf(() =>
    college.enrollDepartmentStudentFace(hod(), capture(PRIYA), "add", faceAi(faceSample(3, 1))),
  );
  assertNoTemplate(result, "the enrolment result");
  const logged = [ids.logLines, ...lines].join("\n");
  const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { institutionId: A } }));
  for (const secret of secrets) {
    assert.ok(!logged.includes(secret), `logged ${secret.slice(0, 12)}…`);
    assert.ok(!audits.includes(secret), `audited ${secret.slice(0, 12)}…`);
  }
});

test("23. the head cannot enrol the face of a student who is not their department's", { skip: SKIP }, async () => {
  const ai = faceAi(faceSample(5, 0));
  for (const [departmentId, studentId, message] of [
    [ids.cse, MEERA, /not in any of this department's sections/],
    [ids.me, MEERA, /not part of this college/],
    [ids.cse, ELSEWHERE, /not in any of this department's sections/],
    [ids.bCse, ELSEWHERE, /not part of this college/],
    [ids.cse, "no-such-student", /not in any of this department's sections/],
  ] as const) {
    for (const mode of ["add", "replace"] as const) {
      await assert.rejects(() => college.enrollDepartmentStudentFace(hod(), capture(studentId, departmentId), mode, ai), refused(message));
    }
    assert.equal(await college.getDepartmentStudentFace(hod(), departmentId, studentId, ai), null);
  }
  // Nor through the administrator's own service, which the head has no permission for.
  await assert.rejects(() => enrollFaceForStudentRequest(hod(), { studentId: MEERA, imageBase64: IMAGE, captureSource: "CAMERA" }, ai), forbidden);
  assert.deepEqual(ai.sent, [], "face-ai never saw the photograph");
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: { in: [MEERA, ELSEWHERE] } } }), 0);
});

test("23b. a student whose only place in the department was in an archived session is read, not enrolled", { skip: SKIP }, async () => {
  // Last year's session, with a Physics section and one student in it; then archived.
  await prisma.academicSession.create({
    data: { id: "hp-it-old", institutionId: A, name: "2025-26", startDate: new Date("2025-07-01Z"), endDate: new Date("2026-05-31Z") },
  });
  const [oldSection] = (
    await college.addCourseSections(admin(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sessionId: "hp-it-old", sections: [{ name: "A" }] })
  ).sectionIds;
  await student("hp-it-alumni", A, "CSE099", "Old", "Student");
  await college.addStudentToSection(admin(), { ...physicsA(), sectionId: oldSection }, "hp-it-alumni");
  await prisma.academicSession.update({ where: { id: "hp-it-old" }, data: { isActive: false } });

  const detail = await college.getDepartmentStudent(hod(), ids.cse, "hp-it-alumni");
  assert.ok(detail, "still one of the department's students to read");
  assert.deepEqual([detail.placements, detail.face.canEnroll], [[], false]);
  const ai = faceAi(faceSample(8, 0));
  assert.equal(await college.getDepartmentStudentFace(hod(), ids.cse, "hp-it-alumni", ai), null);
  await assert.rejects(
    () => college.enrollDepartmentStudentFace(hod(), capture("hp-it-alumni"), "add", ai),
    refused(/not in any of this department's sections/),
  );
  assert.deepEqual(ai.sent, []);
  // A student in a current section can be.
  assert.equal((await college.getDepartmentStudent(hod(), ids.cse, AMAN))?.face.canEnroll, true);
});

// ---------------------------------------------------------------------------
// Taking a student out of a section
// ---------------------------------------------------------------------------

test("14–16. taking a student out of one section ends that place only: other courses, face, login and registers stay", { skip: SKIP }, async () => {
  // A register in Physics A with Aman on it, and a login for Aman.
  const register = await prisma.attendanceSession.create({
    data: { institutionId: A, cohortId: ids.phyA, facultyId: TA, sessionDate: new Date("2026-09-21T00:00:00Z"), status: "FINALIZED" },
  });
  await prisma.attendanceRecord.create({
    data: { institutionId: A, sessionId: register.id, studentId: AMAN, aiResult: "PRESENT", finalResult: "PRESENT" },
  });
  const login = await prisma.user.create({
    data: { institutionId: A, email: "hp-it-aman.invalid", name: "Aman Kumar", passwordHash: "x" },
  });
  await prisma.student.update({ where: { id: AMAN }, data: { userId: login.id } });

  const kept = async () => ({
    student: await prisma.student.findUniqueOrThrow({ where: { id: AMAN }, select: { status: true, userId: true } }),
    login: (await prisma.user.findUniqueOrThrow({ where: { id: login.id } })).status,
    templates: await prisma.faceEmbedding.count({ where: { studentId: AMAN } }),
    activeTemplates: await prisma.faceEmbedding.count({ where: { studentId: AMAN, isActive: true } }),
    records: await prisma.attendanceRecord.count({ where: { studentId: AMAN } }),
    registers: await prisma.attendanceSession.count({ where: { cohortId: ids.phyA } }),
  });
  const before = await kept();

  const removed = await college.removeStudentFromDepartmentSection(hod(), { departmentId: ids.cse, studentId: AMAN, sectionId: ids.phyA });
  assert.deepEqual([removed.name, removed.stillInDepartment, removed.ids], ["Aman Kumar", true, physicsA()]);
  const ended = await enrolment(AMAN, ids.phyA);
  assert.equal(ended?.status, "INACTIVE");
  assert.ok(ended?.unenrolledAt, "the place is ended, not deleted");
  assert.equal((await enrolment(AMAN, ids.cheB))?.status, "ACTIVE", "14: Chemistry B stays");
  assert.deepEqual(await kept(), before, "15, 16: record, login, face templates and registers are all kept");
  assert.ok(await prisma.auditLog.findFirst({ where: { institutionId: A, action: "enrollment.updated", actorUserId: HEAD, entityId: ended.id } }));

  const detail = await college.getDepartmentStudent(hod(), ids.cse, AMAN);
  assert.deepEqual(detail?.placements.map((placement) => placement.groupName), ["CHE402-B"]);
  assert.deepEqual([detail?.face.enrolled, detail?.login.state], [true, "enabled"]);
  assert.deepEqual(
    (await findCandidateEmbeddingsWithVectorsForCohort(ids.phyA, MODEL_REF)).map((row) => row.studentId).includes(AMAN),
    false,
    "Physics A's registers no longer look for them; Chemistry B's still do",
  );
  assert.deepEqual((await findCandidateEmbeddingsWithVectorsForCohort(ids.cheB, MODEL_REF)).map((row) => row.studentId), [AMAN]);

  await assert.rejects(
    () => college.removeStudentFromDepartmentSection(hod(), { departmentId: ids.cse, studentId: AMAN, sectionId: ids.phyA }),
    refused(/not in this section/),
  );

  // Rahul's only section of the department: he is no longer the head's to open, and nothing else changed.
  const last = await college.removeStudentFromDepartmentSection(hod(), { departmentId: ids.cse, studentId: RAHUL, sectionId: ids.phyA });
  assert.equal(last.stillInDepartment, false);
  assert.equal(await college.getDepartmentStudent(hod(), ids.cse, RAHUL), null);
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: RAHUL, isActive: true } }), 1);
  assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: RAHUL } })).status, "ACTIVE");
});

test("16b. a student taken off roll can still have their place in a section ended", { skip: SKIP }, async () => {
  await student("hp-it-leaving", A, "CSE098", "Leaving", "Soon");
  await place("hp-it-leaving", ids.phyB);
  await prisma.student.update({ where: { id: "hp-it-leaving" }, data: { status: "INACTIVE" } });
  const removed = await college.removeStudentFromDepartmentSection(hod(), {
    departmentId: ids.cse,
    studentId: "hp-it-leaving",
    sectionId: ids.phyB,
  });
  assert.deepEqual([removed.name, removed.stillInDepartment], ["Leaving Soon", false]);
  assert.equal((await enrolment("hp-it-leaving", ids.phyB))?.status, "INACTIVE");
  assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: "hp-it-leaving" } })).status, "INACTIVE", "the record is as it was");
});

// ---------------------------------------------------------------------------
// Reaching outside the department
// ---------------------------------------------------------------------------

test("17. the head cannot read, add or remove another college's student", { skip: SKIP }, async () => {
  await assert.rejects(() => place(ELSEWHERE, ids.phyA), refused(/not part of this college/));
  assert.equal(await college.getDepartmentStudentPick(hod(), ids.cse, ELSEWHERE), null);
  assert.equal(await college.getDepartmentStudent(hod(), ids.cse, ELSEWHERE), null);
  assert.deepEqual((await college.searchStudentsForDepartment(hod(), ids.cse, "Elsewhere"))?.results, []);
  await assert.rejects(
    () => college.removeStudentFromDepartmentSection(hod(), { departmentId: ids.cse, studentId: ELSEWHERE, sectionId: ids.phyA }),
    refused(/not in this section/),
  );
  await assert.rejects(
    () => college.removeStudentFromDepartmentSection(hod(), { departmentId: ids.cse, studentId: ELSEWHERE, sectionId: ids.bSection }),
    refused(/not part of this department/),
  );
  assert.equal((await enrolment(ELSEWHERE, ids.bSection))?.status, "ACTIVE");
  assert.equal(await prisma.enrollment.count({ where: { studentId: ELSEWHERE } }), 1);
});

test("18, 26. ids from another department, or mixed together, are refused and change nothing", { skip: SKIP }, async () => {
  const mechanicsBefore = await prisma.enrollment.findMany({ where: { cohortId: ids.mecA }, select: { studentId: true, status: true } });
  const add = (departmentId: string, studentId: string, sectionId: string) =>
    college.addStudentToDepartmentSection(hod(), { departmentId, studentId, sectionId });
  const remove = (departmentId: string, studentId: string, sectionId: string) =>
    college.removeStudentFromDepartmentSection(hod(), { departmentId, studentId, sectionId });

  await assert.rejects(() => add(ids.me, AMAN, ids.mecA), refused(/not part of this college/));
  await assert.rejects(() => add(ids.cse, AMAN, ids.mecA), refused(/not part of this department/));
  await assert.rejects(() => add(ids.cse, AMAN, ids.cse), refused(/not part of this department/), "a department's id is not a section");
  await assert.rejects(() => add(ids.cse, AMAN, ids.bSection), refused(/not part of this department/));
  await assert.rejects(() => add(ids.cse, AMAN, ""), refused(/Choose one of the department's sections/));
  await assert.rejects(() => add(ids.bCse, AMAN, ids.bSection), refused(/not part of this college/));
  await assert.rejects(() => remove(ids.cse, MEERA, ids.mecA), refused(/not part of this department/));
  await assert.rejects(() => remove(ids.me, MEERA, ids.mecA), refused(/not part of this college/));
  await assert.rejects(() => remove(ids.cse, MEERA, ids.phyA), refused(/not in this section/));
  // Priya is in Physics A: a "move" to Physics B that names Mechanics A as where she leaves is no move.
  await assert.rejects(
    () => college.addStudentToDepartmentSection(hod(), { departmentId: ids.cse, studentId: PRIYA, sectionId: ids.phyB, moveFrom: ids.mecA }),
    (error: Error) => error instanceof SameCourseConflict && error.current.sectionId === ids.phyA,
  );
  assert.equal((await enrolment(PRIYA, ids.phyA))?.status, "ACTIVE");
  assert.equal(await enrolment(PRIYA, ids.phyB), null);
  assert.deepEqual(
    await prisma.enrollment.findMany({ where: { cohortId: ids.mecA }, select: { studentId: true, status: true } }),
    mechanicsBefore,
  );
  assert.equal(await enrolment(AMAN, ids.mecA), null);
});

test("24, 25. another department's or college's pages read as not found", { skip: SKIP }, async () => {
  for (const [name, read] of Object.entries({
    "Mechanical's faculty": () => college.getDepartmentFaculty(hod(), ids.me),
    "Mechanical's teacher": () => college.getDepartmentFacultyMember(hod(), ids.me, TM),
    "Mechanical's students": () => college.getDepartmentStudents(hod(), ids.me),
    "Mechanical's student": () => college.getDepartmentStudent(hod(), ids.me, MEERA),
    "Mechanical's student, under CSE": () => college.getDepartmentStudent(hod(), ids.cse, MEERA),
    "Mechanical's add page": () => college.searchStudentsForDepartment(hod(), ids.me, "Aman"),
    "Mechanical's pick": () => college.getDepartmentStudentPick(hod(), ids.me, AMAN),
    "Mechanical's face page": () => college.getDepartmentStudentFace(hod(), ids.me, MEERA),
    "a semester as a department": () => college.getDepartmentStudents(hod(), ids.s4),
    "a section as a department": () => college.getDepartmentFaculty(hod(), ids.phyA),
    "the other college's faculty": () => college.getDepartmentFaculty(hod(), ids.bCse),
    "the other college's teacher": () => college.getDepartmentFacultyMember(hod(), ids.cse, B_TEACHER),
    "the other college's students": () => college.getDepartmentStudents(hod(), ids.bCse),
    "the other college's student": () => college.getDepartmentStudent(hod(), ids.cse, ELSEWHERE),
    "the other college's pick": () => college.getDepartmentStudentPick(hod(), ids.cse, ELSEWHERE),
    "the other college's face page": () => college.getDepartmentStudentFace(hod(), ids.bCse, ELSEWHERE),
  })) {
    assert.equal(await read(), null, name);
  }
  // Nothing of the other college appears on the head's own pages either.
  const own = JSON.stringify([
    await college.getDepartmentFaculty(hod(), ids.cse),
    await college.getDepartmentStudents(hod(), ids.cse),
    await college.searchStudentsForDepartment(hod(), ids.cse, "CSE001"),
  ]);
  for (const foreign of [ELSEWHERE, B_TEACHER, ids.bCse, ids.bSection, MEERA, TM]) {
    assert.ok(!own.includes(foreign), `${foreign} appeared`);
  }
});

test("27. a head whose account is disabled, or who is not a head, can do none of it", { skip: SKIP }, async () => {
  const attempts = (who: SessionUser) => [
    () => college.getDepartmentFaculty(who, ids.cse),
    () => college.getDepartmentFacultyMember(who, ids.cse, TA),
    () => college.getDepartmentStudents(who, ids.cse),
    () => college.getDepartmentStudent(who, ids.cse, AMAN),
    () => college.searchStudentsForDepartment(who, ids.cse, "Aman"),
    () => college.addDepartmentFaculty(who, { departmentId: ids.cse, name: "X", email: "hp-it-x@test.local" }),
    () => college.updateDepartmentFacultyMember(who, { departmentId: ids.cse, userId: TA, name: "X" }),
    () => college.setDepartmentFacultyActive(who, { departmentId: ids.cse, userId: TA, active: false }),
    () => college.assignFacultyToSection(who, { departmentId: ids.cse, userId: TA, sectionId: ids.phyB, expectedTeacherId: ids.arun }),
    () => college.addStudentToDepartmentSection(who, { departmentId: ids.cse, studentId: PRIYA, sectionId: ids.cheB }),
    () => college.removeStudentFromDepartmentSection(who, { departmentId: ids.cse, studentId: AMAN, sectionId: ids.cheB }),
    () => college.createDepartmentStudent(who, { departmentId: ids.cse, sectionId: ids.cheB }, newStudent("CSE050", "X", "Y")),
    () => college.getDepartmentStudentFace(who, ids.cse, AMAN, faceAi(faceSample(6, 0))),
    () => college.enrollDepartmentStudentFace(who, capture(AMAN), "add", faceAi(faceSample(6, 0))),
  ];
  const snapshot = async () =>
    JSON.stringify([
      await prisma.enrollment.findMany({ where: { institutionId: A }, orderBy: { id: "asc" } }),
      await prisma.cohortFaculty.findMany({ where: { cohort: { institutionId: A } }, orderBy: { id: "asc" } }),
      await prisma.user.count({ where: { institutionId: A } }),
      await prisma.student.count({ where: { institutionId: A } }),
      await prisma.faceEmbedding.count({ where: { institutionId: A } }),
      (await prisma.user.findUniqueOrThrow({ where: { id: TA } })).status,
    ]);
  const before = await snapshot();

  await prisma.user.update({ where: { id: HEAD }, data: { status: "INACTIVE" } });
  try {
    for (const attempt of attempts(hod())) await assert.rejects(attempt, forbidden);
  } finally {
    await prisma.user.update({ where: { id: HEAD }, data: { status: "ACTIVE" } });
  }
  // A lecturer of the department is not its head.
  for (const attempt of attempts(teacher(TA))) await assert.rejects(attempt, forbidden);
  assert.equal(await snapshot(), before, "nothing changed");
  assert.ok(await college.getDepartmentFaculty(hod(), ids.cse), "restored, the head is back in");
});

test("28. a school's staff reach none of it, and the school is left as it was", { skip: SKIP }, async () => {
  const school = actor(S_ADMIN, "SCHOOL_ADMIN", S);
  const attempts = [
    () => college.getDepartmentFaculty(school, ids.cse),
    () => college.getDepartmentStudents(school, ids.cse),
    () => college.getDepartmentStudent(school, ids.cse, AMAN),
    () => college.searchStudentsForDepartment(school, ids.cse, "Aman"),
    () => college.addDepartmentFaculty(school, { departmentId: ids.cse, name: "X", email: "hp-it-school-x@test.local" }),
    () => college.addStudentToDepartmentSection(school, { departmentId: ids.cse, studentId: AMAN, sectionId: ids.phyA }),
    () => college.enrollDepartmentStudentFace(school, capture(AMAN), "add", faceAi(faceSample(7, 0))),
  ];
  for (const attempt of attempts) await assert.rejects(attempt, refused(/colleges only/));
  assert.equal(await prisma.user.count({ where: { institutionId: S } }), 1);
  assert.equal(await prisma.student.count({ where: { institutionId: S } }), 0);
  assert.equal(await prisma.academicUnit.count({ where: { institutionId: S } }), 0);
});
