import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EMBEDDING_DIMENSION,
  type DetectEmbedResponse,
  type EnrollResponse,
  type ModelInfoResponse,
} from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { ensureSystemRolesAndPermissions, inspectBootstrapState } from "@/modules/authorization/bootstrap";
import { assignRole } from "@/modules/authorization/role-management";
import { ForbiddenError } from "@/modules/authorization/types";
import { getSessionUserByRawToken, loginService } from "@/modules/auth-tenancy/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  listCapturableCohortsForActor,
  listCohortSubjectsForCapture,
  startOrResumeCaptureSession,
} from "@/modules/attendance-capture/service";
import { getFilterOptions } from "@/modules/attendance-reporting/service";
import {
  applyReviewDecision,
  confirmAttendance,
  generateAttendanceCandidates,
  getAttendanceReviewBoard,
} from "@/modules/attendance-review/service";
import { listCohortsForInstitutionRequest } from "@/modules/cohorts/service";
import { getFacultyDirectory, inviteFaculty, updateFacultyDetails } from "@/modules/faculty/directory-service";
import { runRecognitionForSession } from "@/modules/recognition-engine/service";
import { EMPTY_STUDENT_FILTERS } from "@/modules/students/directory-filters";
import { getStudentForRequest, listStudentsForRequest } from "@/modules/students/directory-service";
import * as college from "./service.ts";
import { CollegeSetupError } from "./types.ts";

/**
 * The teachers a head of department adds get `DEPARTMENT_FACULTY`, a role
 * that teaches its own department's sections and reads nothing college-wide.
 *
 * The case this exists for: a head adds "Faculty X" with an address they
 * control, is shown the password, and signs in as X. X must then be able to
 * do exactly what a teacher does for the section they were given — and
 * nothing the head's own role could not already do: no college-wide student
 * or class directory, no other department, no other college, no account,
 * role or department change, no route to becoming a head.
 *
 * X signs in for real (`loginService`, then the session lookup every page
 * uses), so the permissions tested are the ones the database grants. Only
 * face-ai is replaced, for the recognition run.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const A = "df-it-inst";
const B = "df-it-other";
const S = "df-it-school";
const INSTITUTIONS = [A, B, S];
const NOW = "df-it-now";
const B_NOW = "df-it-b-now";
const ADMIN = "df-it-admin";
const HEAD_A = "df-it-head-a";
const HEAD_B = "df-it-head-b";
const TA = "df-it-teacher-a";
const TB = "df-it-teacher-b";
const B_ADMIN = "df-it-b-admin";
const B_TEACHER = "df-it-b-teacher";
const S_ADMIN = "df-it-s-admin";
const AMAN = "df-it-aman";
const RAHUL = "df-it-rahul";
const MEERA = "df-it-meera";
const ELSEWHERE = "df-it-elsewhere";

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
const hodA = () => actor(HEAD_A, "HOD", A);
const hodB = () => actor(HEAD_B, "HOD", A);
const teacher = (userId: string) => actor(userId, "FACULTY", A);
const refused = (pattern: RegExp) => (error: Error) => error instanceof CollegeSetupError && pattern.test(error.message);
const forbidden = (error: Error) => error instanceof ForbiddenError;

const MODEL: ModelInfoResponse = {
  modelName: "df-it-model",
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

/** One "face" is an axis; a sample leans slightly off it, a probe sits on it. */
function unit(weights: Record<number, number>): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (const [index, weight] of Object.entries(weights)) v[Number(index)] = weight;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}
const faceSample = (face: number) => unit({ [face]: 1, 40: 0.15 });
const faceProbe = (face: number) => unit({ [face]: 1 });

function enrolAs(face: number) {
  const response: EnrollResponse = {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: faceSample(face),
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    weightsVersion: MODEL.weightsVersion,
    preprocessingVersion: MODEL.preprocessingVersion,
    embeddingDim: EMBEDDING_DIMENSION,
    aligned: true,
  };
  return { faceModelInfo: async () => MODEL, faceEnroll: async () => response };
}

async function cleanup() {
  const where = { institutionId: { in: INSTITUTIONS } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: where } });
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
  for (const kind of ["SECTION", "COURSE", "SEMESTER", "DEPARTMENT"] as const) {
    await prisma.academicUnit.deleteMany({ where: { ...where, kind } });
  }
  await prisma.academicSession.deleteMany({ where });
  await prisma.userRoleAssignment.deleteMany({ where: { user: where } });
  await prisma.rolePermission.deleteMany({ where: { role: where } });
  await prisma.role.deleteMany({ where });
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

async function student(id: string, institutionId: string, code: string, firstName: string, lastName: string) {
  await prisma.student.create({ data: { id, institutionId, studentCode: code, firstName, lastName } });
}

const roleKeysOf = async (userId: string) =>
  (await prisma.userRoleAssignment.findMany({ where: { userId }, select: { role: { select: { key: true } } } }))
    .map((assignment) => assignment.role.key)
    .sort();
const teachersOf = (cohortId: string) =>
  prisma.cohortFaculty.findMany({ where: { cohortId }, select: { userId: true, role: true }, orderBy: { userId: "asc" } });

/** Signs in for real and resolves the session the way every page does. */
async function signIn(email: string, password: string): Promise<{ user: SessionUser; token: string }> {
  const result = await loginService(email, password);
  assert.equal(result.ok, true, result.ok ? "" : `sign-in refused: ${result.reason}`);
  const token = result.ok ? result.rawToken : "";
  const user = await getSessionUserByRawToken(token);
  assert.ok(user, "the session resolves");
  return { user, token };
}

const ids: Record<string, string> = {};
const x: { id: string; email: string; password: string; session?: SessionUser } = { id: "", email: "df-it-faculty-x@test.local", password: "" };
const section = (sectionId: string, courseId = ids.phy) => ({ departmentId: ids.cse, semesterId: ids.s4, courseId, sectionId });
const mechanicsA = () => ({ departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sectionId: ids.mecA });

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  const settings = { attendanceMode: "SUBJECT_WISE" };
  await prisma.institution.createMany({
    data: [
      { id: A, name: "Department Faculty College", type: "COLLEGE", settings },
      { id: B, name: "Other College", type: "COLLEGE", settings },
      { id: S, name: "Nearby School", type: "SCHOOL" },
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
  await staff(S_ADMIN, S, "SCHOOL_ADMIN");

  // Department A (Computer Science) and Department B (Mechanical), each with a head.
  ids.cse = (await college.createDepartment(admin(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.me = (await college.createDepartment(admin(), { name: "Mechanical", code: "ME" })).departmentId;
  await prisma.user.update({ where: { id: TA }, data: { departmentId: ids.cse } });
  await prisma.user.update({ where: { id: TB }, data: { departmentId: ids.me } });
  await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: HEAD_A });
  await college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: HEAD_B });

  ids.s4 = (await college.createSemester(hodA(), { departmentId: ids.cse, number: 4 })).semesterId;
  await college.setCurrentSemester(hodA(), { departmentId: ids.cse, semesterId: ids.s4 });
  ids.phy = (await college.createCourse(hodA(), { semesterId: ids.s4, code: "PHY401", name: "Physics" })).courseId;
  ids.che = (await college.createCourse(hodA(), { semesterId: ids.s4, code: "CHE402", name: "Chemistry" })).courseId;
  const inS4 = { departmentId: ids.cse, semesterId: ids.s4, sessionId: NOW };
  [ids.phyA, ids.phyB] = (
    await college.addCourseSections(hodA(), { ...inS4, courseId: ids.phy, sections: [{ name: "A" }, { name: "B", teacherId: TA }] })
  ).sectionIds;
  [ids.cheB] = (await college.addCourseSections(hodA(), { ...inS4, courseId: ids.che, sections: [{ name: "B" }] })).sectionIds;

  ids.meS1 = (await college.createSemester(hodB(), { departmentId: ids.me, number: 1 })).semesterId;
  ids.mec = (await college.createCourse(hodB(), { semesterId: ids.meS1, code: "MEC101", name: "Mechanics" })).courseId;
  [ids.mecA] = (
    await college.addCourseSections(hodB(), { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sessionId: NOW, sections: [{ name: "A", teacherId: TB }] })
  ).sectionIds;

  // Another college, with a section and a student of its own.
  const bAdmin = actor(B_ADMIN, "COLLEGE_ADMIN", B);
  ids.bCse = (await college.createDepartment(bAdmin, { name: "Computer Science", code: "CSE" })).departmentId;
  ids.bS1 = (await college.createSemester(bAdmin, { departmentId: ids.bCse, number: 1 })).semesterId;
  ids.bCourse = (await college.createCourse(bAdmin, { departmentId: ids.bCse, semesterId: ids.bS1, code: "CSE101", name: "Programming" })).courseId;
  await prisma.user.update({ where: { id: B_TEACHER }, data: { departmentId: ids.bCse } });
  [ids.bSection] = (
    await college.addCourseSections(bAdmin, { departmentId: ids.bCse, semesterId: ids.bS1, courseId: ids.bCourse, sessionId: B_NOW, sections: [{ name: "A", teacherId: B_TEACHER }] })
  ).sectionIds;

  await student(AMAN, A, "CSE001", "Aman", "Kumar");
  await student(RAHUL, A, "CSE002", "Rahul", "Singh");
  await student(MEERA, A, "ME001", "Meera", "Iyer");
  await student(ELSEWHERE, B, "CSE001", "Aman", "Elsewhere");
  await college.addStudentToSection(hodA(), section(ids.phyA), AMAN);
  await college.addStudentToSection(hodA(), section(ids.phyA), RAHUL);
  await college.addStudentToSection(hodB(), mechanicsA(), MEERA);
  await college.addStudentToSection(bAdmin, { departmentId: ids.bCse, semesterId: ids.bS1, courseId: ids.bCourse, sectionId: ids.bSection }, ELSEWHERE);
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The role, and its bootstrap
// ---------------------------------------------------------------------------

test("bootstrap:system creates DEPARTMENT_FACULTY with exactly its five grants, and running it again changes nothing", { skip: SKIP }, async () => {
  // This test's own tenants, whose rows nothing else writes while it runs —
  // other suites create and delete their own institutions in parallel.
  const where = { institutionId: { in: INSTITUTIONS } };
  const tenantRows = async () =>
    JSON.stringify([
      await prisma.institution.findMany({ where: { id: { in: INSTITUTIONS } }, orderBy: { id: "asc" } }),
      await prisma.user.findMany({ where, select: { id: true, passwordHash: true, status: true, departmentId: true }, orderBy: { id: "asc" } }),
      await prisma.userRoleAssignment.findMany({ where: { user: where }, select: { id: true, roleId: true }, orderBy: { id: "asc" } }),
      await prisma.student.findMany({ where, orderBy: { id: "asc" } }),
      await prisma.enrollment.findMany({ where, orderBy: { id: "asc" } }),
      await prisma.attendanceRecord.count({ where }),
      await prisma.faceEmbedding.count({ where }),
    ]);
  const before = await tenantRows();
  for (const run of [1, 2]) {
    const result = await ensureSystemRolesAndPermissions(prisma);
    assert.equal(result.rolesCreated, 0, `run ${run}: every role already exists`);
    for (const role of result.roles) {
      assert.deepEqual([role.key, role.permissionsAdded, role.permissionsRemoved], [role.key, 0, 0], `run ${run}: ${role.key} unchanged`);
    }
  }
  const role = await prisma.role.findFirstOrThrow({
    where: { institutionId: null, key: "DEPARTMENT_FACULTY" },
    select: { name: true, isSystem: true, permissions: { select: { permission: true } } },
  });
  assert.deepEqual([role.name, role.isSystem], ["Department Faculty", true]);
  assert.deepEqual(role.permissions.map((row) => row.permission).sort(), [
    "attendanceRecord.correct",
    "attendanceRecord.read",
    "attendanceSession.capture",
    "attendanceSession.create",
    "attendanceSession.finalize",
  ]);
  const state = await inspectBootstrapState(prisma);
  assert.equal(state.systemRolesComplete, true);
  assert.deepEqual(
    state.systemRoles.find((entry) => entry.key === "DEPARTMENT_FACULTY"),
    { key: "DEPARTMENT_FACULTY", present: true, missingPermissions: [], extraPermissions: [] },
  );
  assert.equal(await tenantRows(), before, "no user, password, institution, student, attendance or face row was touched");
});

// ---------------------------------------------------------------------------
// A head adds Faculty X
// ---------------------------------------------------------------------------

test("a head adds Faculty X: department faculty, in the head's own department, audited as the head's doing", { skip: SKIP }, async () => {
  const invited = await college.addDepartmentFaculty(hodA(), {
    departmentId: ids.cse,
    name: "Faculty X",
    email: x.email,
    employeeCode: "FX-1",
    // What a tampered form might add. The service takes neither, and must ignore both.
    ...({ roleKey: "COLLEGE_ADMIN", institutionId: B } as object),
  } as Parameters<typeof college.addDepartmentFaculty>[1]);
  x.id = invited.member.id;
  x.password = invited.password;

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: x.id },
    select: { institutionId: true, departmentId: true, status: true, passwordHash: true },
  });
  assert.deepEqual([row.institutionId, row.departmentId, row.status], [A, ids.cse, "ACTIVE"]);
  assert.deepEqual(await roleKeysOf(x.id), ["DEPARTMENT_FACULTY"], "the department role, and no other");
  // The one-time password: handed back once, kept only as a hash.
  assert.ok(x.password.length >= 12);
  assert.ok(row.passwordHash && !row.passwordHash.includes(x.password));
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { institutionId: A, action: "user.created", entityId: x.id } });
  assert.equal(audit.actorUserId, HEAD_A, "the head is the audited actor");
  assert.deepEqual((audit.afterJson as { roleKey?: string; departmentId?: string }).roleKey, "DEPARTMENT_FACULTY");
  assert.equal((audit.afterJson as { departmentId?: string }).departmentId, ids.cse);
  assert.ok(!JSON.stringify(audit).includes(x.password), "the audit row has no password");

  // Another department's or college's id in the form is refused, and nothing is created.
  const users = await prisma.user.count({ where: { institutionId: { in: INSTITUTIONS } } });
  for (const departmentId of [ids.me, ids.bCse, ids.s4, ""]) {
    await assert.rejects(
      () => college.addDepartmentFaculty(hodA(), { departmentId, name: "Sneaky", email: `df-it-sneaky-${departmentId || "none"}@test.local` }),
      refused(/not part of this college/),
    );
  }
  assert.equal(await prisma.user.count({ where: { institutionId: { in: INSTITUTIONS } } }), users);

  // The member row the head sees names the role.
  const listed = await college.getDepartmentFaculty(hodA(), ids.cse, { q: "FX-1" });
  assert.deepEqual(listed?.faculty.map((person) => [person.name, person.departmentFaculty, person.manageable]), [["Faculty X", true, true]]);
});

test("a head never grants a Department Faculty role that carries more than the head holds", { skip: SKIP }, async () => {
  // A head whose own role has lost one of the permissions the department role
  // carries — say their HOD role was edited in the database. Granting the
  // department role would hand an account more than its creator holds, so it
  // is refused, and nothing is made.
  const narrowed = hodA();
  narrowed.roles = narrowed.roles.map((role) => ({
    ...role,
    permissions: role.permissions.filter((permission) => permission !== "attendanceRecord.correct"),
  }));
  const users = await prisma.user.count({ where: { institutionId: A } });
  await assert.rejects(
    () => college.addDepartmentFaculty(narrowed, { departmentId: ids.cse, name: "Too Wide", email: "df-it-too-wide@test.local" }),
    refused(/grants more than a head of department holds/),
  );
  await assert.rejects(
    () => college.inviteTeacherForCourseSection(narrowed, { ...section(ids.cheB, ids.che), name: "Too Wide", email: "df-it-too-wide@test.local", expectedTeacherId: "" }),
    refused(/grants more than a head of department holds/),
  );
  assert.equal(await prisma.user.count({ where: { institutionId: A } }), users, "no account was made");
});

// ---------------------------------------------------------------------------
// Faculty X signs in
// ---------------------------------------------------------------------------

test("Faculty X signs in with the one-time password and holds the five teaching permissions, nothing more", { skip: SKIP }, async () => {
  const { user } = await signIn(x.email, x.password);
  x.session = user;
  assert.deepEqual(user.roles.map((role) => role.key), ["DEPARTMENT_FACULTY"]);
  assert.deepEqual([...new Set(user.roles.flatMap((role) => role.permissions))].sort(), [
    "attendanceRecord.correct",
    "attendanceRecord.read",
    "attendanceSession.capture",
    "attendanceSession.create",
    "attendanceSession.finalize",
  ]);
  assert.equal(user.institutionId, A);
});

test("Faculty X reaches no college-wide directory, no department page and no management", { skip: SKIP }, async () => {
  const X = x.session!;
  const attempts: Record<string, () => Promise<unknown>> = {
    "all-college students": () => listStudentsForRequest(X, EMPTY_STUDENT_FILTERS),
    "a student's record": () => getStudentForRequest(X, AMAN),
    "the class directory": () => listCohortsForInstitutionRequest(X, A),
    "the Faculty page": () => getFacultyDirectory(X),
    "Departments": () => college.getDepartmentsOverview(X),
    "Department A": () => college.getDepartmentDetail(X, ids.cse),
    "Department B": () => college.getDepartmentDetail(X, ids.me),
    "Department A's students": () => college.getDepartmentStudents(X, ids.cse),
    "Department B's students": () => college.getDepartmentStudents(X, ids.me),
    "Department B's faculty": () => college.getDepartmentFaculty(X, ids.me),
    "Department A's faculty": () => college.getDepartmentFaculty(X, ids.cse),
    "Courses": () => college.getCoursesIndex(X),
    "a section page": () => college.getCourseSectionDetail(X, section(ids.phyA)),
    "another college's department": () => college.getDepartmentStudents(X, ids.bCse),
    "a new department": () => college.createDepartment(X, { name: "Mine", code: "MINE" }),
    "a new semester": () => college.createSemester(X, { departmentId: ids.cse, number: 6 }),
    "a new course": () => college.createCourse(X, { semesterId: ids.s4, code: "X101", name: "X" }),
    "a new section": () => college.addCourseSections(X, { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sessionId: NOW, sections: [{ name: "Z" }] }),
    "a section's teacher": () => college.setCourseSectionTeacher(X, { ...section(ids.phyB), teacherId: x.id, expectedTeacherId: TA }),
    "a student's section": () => college.addStudentToDepartmentSection(X, { departmentId: ids.cse, studentId: MEERA, sectionId: ids.phyA }),
    "a face": () => college.enrollDepartmentStudentFace(X, { departmentId: ids.cse, studentId: AMAN, imageBase64: "AAAA", captureSource: "CAMERA" }, "add", enrolAs(9)),
    "a teacher account": () => college.addDepartmentFaculty(X, { departmentId: ids.cse, name: "Y", email: "df-it-y@test.local" }),
  };
  for (const [what, attempt] of Object.entries(attempts)) {
    await assert.rejects(attempt, forbidden, `Faculty X reached ${what}`);
  }
});

test("Faculty X cannot change their department or role, and never becomes a head", { skip: SKIP }, async () => {
  const X = x.session!;
  const collegeAdminRole = await prisma.role.findFirstOrThrow({ where: { key: "COLLEGE_ADMIN", institutionId: null } });
  const facultyRole = await prisma.role.findFirstOrThrow({ where: { key: "FACULTY", institutionId: null } });
  const hodRole = await prisma.role.findFirstOrThrow({ where: { key: "HOD", institutionId: null } });
  for (const [what, attempt] of Object.entries({
    "move to Department B": () => updateFacultyDetails(X, x.id, { name: "Faculty X", departmentId: ids.me }),
    "edit themselves from the department page": () => college.updateDepartmentFacultyMember(X, { departmentId: ids.cse, userId: x.id, name: "X" }),
    "grant themselves COLLEGE_ADMIN": () => assignRole(X, { targetUserId: x.id, roleId: collegeAdminRole.id, institutionId: A }),
    "grant themselves FACULTY": () => assignRole(X, { targetUserId: x.id, roleId: facultyRole.id, institutionId: A }),
    "grant themselves HOD": () => assignRole(X, { targetUserId: x.id, roleId: hodRole.id, institutionId: A }),
    "make themselves head": () => college.assignDepartmentHead(X, { departmentId: ids.me, userId: x.id }),
    "create an account": () => inviteFaculty(X, { name: "Y", email: "df-it-y2@test.local", roleKey: "FACULTY", departmentId: ids.cse }),
  })) {
    await assert.rejects(attempt, forbidden, `Faculty X could ${what}`);
  }
  // Nor can the head widen them.
  await assert.rejects(() => assignRole(hodA(), { targetUserId: x.id, roleId: facultyRole.id, institutionId: A }), forbidden);
  await assert.rejects(() => college.assignDepartmentHead(hodA(), { departmentId: ids.cse, userId: x.id }), forbidden);
  // And the Director is not offered them as a head, nor can pick them: a head held their password.
  const detail = await college.getDepartmentDetail(admin(), ids.me);
  assert.equal(detail?.hodCandidates.some((candidate) => candidate.id === x.id), false);
  await assert.rejects(
    () => college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: x.id }),
    refused(/can't head a department/),
  );
  assert.deepEqual(await roleKeysOf(x.id), ["DEPARTMENT_FACULTY"]);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: x.id } })).departmentId, ids.cse);
});

// ---------------------------------------------------------------------------
// Teaching
// ---------------------------------------------------------------------------

test("the head gives Faculty X Physics — Section A; X sees that section and nothing else", { skip: SKIP }, async () => {
  const X = x.session!;
  assert.deepEqual(await listCapturableCohortsForActor(X), [], "no section yet, nothing to open");
  const result = await college.assignFacultyToSection(hodA(), { departmentId: ids.cse, userId: x.id, sectionId: ids.phyA, expectedTeacherId: "" });
  assert.equal(result.teacherName, "Faculty X");
  assert.deepEqual(await teachersOf(ids.phyA), [{ userId: x.id, role: "PRIMARY" }]);

  assert.deepEqual((await listCapturableCohortsForActor(X)).map((cohort) => cohort.name), ["PHY401-A"]);
  const subjects = await listCohortSubjectsForCapture(X, ids.phyA);
  assert.deepEqual(subjects.map((subject) => subject.subjectName), ["Physics"]);
  ids.phySubject = subjects[0].id;
  const options = await getFilterOptions(X);
  assert.deepEqual(options.cohorts.map((cohort) => cohort.id), [ids.phyA], "reports offer only their own section");
  assert.deepEqual([options.faculty, options.academicUnits], [[], []]);
  // Another teacher's sections stay theirs.
  await assert.rejects(() => listCohortSubjectsForCapture(X, ids.phyB), forbidden);
  await assert.rejects(() => listCohortSubjectsForCapture(X, ids.mecA), forbidden);
  await assert.rejects(() => listCohortSubjectsForCapture(X, ids.bSection));
});

test("Faculty X takes Physics — Section A's attendance: register, recognition, review, confirmation", { skip: SKIP }, async () => {
  const X = x.session!;
  // Aman's face, enrolled from the department by the head.
  const enrolled = await college.enrollDepartmentStudentFace(
    hodA(),
    { departmentId: ids.cse, studentId: AMAN, imageBase64: "AAAA", captureSource: "CAMERA" },
    "add",
    enrolAs(1),
  );
  assert.equal(enrolled.ok, true);

  const started = await startOrResumeCaptureSession(X, { cohortId: ids.phyA, cohortSubjectId: ids.phySubject });
  assert.deepEqual([started.session.cohortId, started.enrolledStudentCount, started.subjectName], [ids.phyA, 2, "Physics"]);
  const sessionId = started.session.id;

  const detect: DetectEmbedResponse = {
    faces: [{ sequenceNumber: 1, boundingBox: { x: 0, y: 0, width: 120, height: 120 }, embedding: faceProbe(1), detectionConfidence: 0.99, qualityScore: 0.9 }],
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  } as DetectEmbedResponse;
  const summary = await runRecognitionForSession(
    X,
    { sessionId, images: [{ sequenceNumber: 1, imageBase64: "x".repeat(64) }] },
    { fetchModelInfo: async () => MODEL, detectEmbed: async () => detect },
  );
  const matched = summary.perStudent.filter((row) => row.matchStatus !== "UNMATCHED").map((row) => row.studentId);
  assert.deepEqual(matched, [AMAN], "recognition runs for them against their own section");

  await generateAttendanceCandidates(X, { sessionId, recognition: summary });
  const board = await getAttendanceReviewBoard(X, sessionId);
  const rows = [...board.present, ...board.absent, ...board.needsReview];
  assert.deepEqual(rows.map((row) => row.studentId).sort(), [AMAN, RAHUL].sort());
  assert.equal(board.actorCanFinalize, true, "the teacher who took it confirms it");
  const rahul = rows.find((row) => row.studentId === RAHUL)!;
  await applyReviewDecision(X, { attendanceRecordId: rahul.attendanceRecordId, newResult: "ABSENT", reason: "Not in class" });
  await confirmAttendance(X, sessionId);

  const register = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, facultyId: true } });
  assert.deepEqual(register, { status: "FINALIZED", facultyId: x.id });
  const records = await prisma.attendanceRecord.findMany({ where: { sessionId }, select: { studentId: true, finalResult: true }, orderBy: { studentId: "asc" } });
  assert.deepEqual(
    Object.fromEntries(records.map((record) => [record.studentId, record.finalResult])),
    { [AMAN]: "PRESENT", [RAHUL]: "ABSENT" },
  );

  // Another teacher's register is not theirs to open or read.
  const other = await startOrResumeCaptureSession(teacher(TA), { cohortId: ids.phyB, cohortSubjectId: (await listCohortSubjectsForCapture(teacher(TA), ids.phyB))[0].id });
  await assert.rejects(() => getAttendanceReviewBoard(X, other.session.id), forbidden);
  await assert.rejects(() => confirmAttendance(X, other.session.id), forbidden);
  const mechanics = await prisma.cohortSubject.findFirstOrThrow({ where: { cohortId: ids.mecA } });
  await assert.rejects(() => startOrResumeCaptureSession(X, { cohortId: ids.mecA, cohortSubjectId: mechanics.id }), forbidden);
});

// ---------------------------------------------------------------------------
// Assigning teachers
// ---------------------------------------------------------------------------

test("department faculty teach only their own department's sections, whoever assigns them", { skip: SKIP }, async () => {
  const before = JSON.stringify([await teachersOf(ids.mecA), await teachersOf(ids.phyB)]);
  // Head A: another department's section.
  await assert.rejects(
    () => college.assignFacultyToSection(hodA(), { departmentId: ids.cse, userId: x.id, sectionId: ids.mecA, expectedTeacherId: TB }),
    refused(/not part of this department/),
  );
  // Head B: somebody else's department faculty.
  await assert.rejects(
    () => college.assignFacultyToSection(hodB(), { departmentId: ids.me, userId: x.id, sectionId: ids.mecA, expectedTeacherId: TB }),
    refused(/not in your department/),
  );
  // The Director: refused too, with the way to do it properly.
  await assert.rejects(
    () => college.setCourseSectionTeacher(admin(), { ...mechanicsA(), teacherId: x.id, expectedTeacherId: TB }),
    refused(/faculty of another department and teaches only its sections/),
  );
  await assert.rejects(
    () => college.addCourseSections(admin(), { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sessionId: NOW, sections: [{ name: "B", teacherId: x.id }] }),
    refused(/faculty of another department/),
  );
  assert.equal(JSON.stringify([await teachersOf(ids.mecA), await teachersOf(ids.phyB)]), before, "nothing changed");

  // The pickers agree: X is offered for Computer Science's sections, never Mechanical's.
  const mech = await college.getCourseSectionDetail(admin(), mechanicsA());
  assert.equal(mech?.teachers.some((choice) => choice.id === x.id), false);
  assert.ok(mech?.teachers.some((choice) => choice.id === TA), "an ordinary teacher from elsewhere is still offered to the Director, as before");
  const phy = await college.getCourseSectionDetail(admin(), section(ids.phyB));
  assert.ok(phy?.teachers.some((choice) => choice.id === x.id));
  const own = await college.getCourseSectionDetail(hodA(), section(ids.phyB));
  assert.deepEqual(own?.teachers.map((choice) => choice.id).sort(), [HEAD_A, TA, x.id].sort(), "the head's list: their department only");
});

test("a section's Assign teacher: the head picks a department teacher, or creates one there, and replaces only on purpose", { skip: SKIP }, async () => {
  // Chemistry B has no teacher: a new department teacher is made and given it in one go.
  const created = await college.inviteTeacherForCourseSection(hodA(), {
    ...section(ids.cheB, ids.che),
    name: "Faculty Y",
    email: "df-it-faculty-y@test.local",
    expectedTeacherId: "",
  });
  assert.equal(created.assignError, null);
  assert.deepEqual(await roleKeysOf(created.invited.member.id), ["DEPARTMENT_FACULTY"]);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: created.invited.member.id } })).departmentId, ids.cse);
  assert.deepEqual(await teachersOf(ids.cheB), [{ userId: created.invited.member.id, role: "PRIMARY" }]);
  assert.ok(created.invited.password.length >= 12, "the password, once");

  // Physics B is taught by Teacher A. A form that showed it free creates the
  // account — the password must still be handed over — but gives nobody the section.
  const stale = await college.inviteTeacherForCourseSection(hodA(), {
    ...section(ids.phyB),
    name: "Faculty Z",
    email: "df-it-faculty-z@test.local",
    expectedTeacherId: "",
  });
  assert.match(stale.assignError ?? "", /is taught by df-it-teacher-a now/);
  assert.deepEqual(await teachersOf(ids.phyB), [{ userId: TA, role: "PRIMARY" }]);
  // Picking an existing teacher: the same guard, and no second teacher.
  await assert.rejects(
    () => college.setCourseSectionTeacher(hodA(), { ...section(ids.phyB), teacherId: TA, expectedTeacherId: TA }),
    refused(/already teaches this section/),
  );
  await college.setCourseSectionTeacher(hodA(), { ...section(ids.phyB), teacherId: stale.invited.member.id, expectedTeacherId: TA });
  assert.deepEqual(await teachersOf(ids.phyB), [{ userId: stale.invited.member.id, role: "PRIMARY" }]);
  await college.setCourseSectionTeacher(hodA(), { ...section(ids.phyB), teacherId: TA, expectedTeacherId: stale.invited.member.id });

  // The Director's new teacher from the same form is an ordinary teacher, as before.
  const byDirector = await college.inviteTeacherForCourseSection(admin(), {
    ...section(ids.phyB),
    name: "Director's Teacher",
    email: "df-it-directors@test.local",
    expectedTeacherId: TA,
  });
  assert.equal(byDirector.assignError, null);
  assert.deepEqual(await roleKeysOf(byDirector.invited.member.id), ["FACULTY"]);
  await college.setCourseSectionTeacher(admin(), { ...section(ids.phyB), teacherId: TA, expectedTeacherId: byDirector.invited.member.id });
});

// ---------------------------------------------------------------------------
// Nothing else changed
// ---------------------------------------------------------------------------

test("existing and Director-created teachers keep the ordinary role and everything it reads", { skip: SKIP }, async () => {
  const faculty = await prisma.role.findFirstOrThrow({ where: { key: "FACULTY", institutionId: null }, select: { permissions: { select: { permission: true } } } });
  assert.deepEqual(faculty.permissions.map((row) => row.permission).sort(), [
    "attendanceRecord.correct",
    "attendanceRecord.read",
    "attendanceSession.capture",
    "attendanceSession.create",
    "attendanceSession.finalize",
    "cohort.read",
    "student.read",
  ]);
  assert.deepEqual(await roleKeysOf(TA), ["FACULTY"]);
  const page = await listStudentsForRequest(teacher(TA), EMPTY_STUDENT_FILTERS);
  assert.ok(page.rows.some((row) => row.id === AMAN), "an ordinary teacher still reads the student directory");
  assert.deepEqual((await listCapturableCohortsForActor(teacher(TA))).map((cohort) => cohort.name), ["PHY401-B"]);
  // No existing account was moved onto the new role: at this college only the
  // teachers the head added hold it.
  const holders = await prisma.userRoleAssignment.findMany({
    where: { role: { key: "DEPARTMENT_FACULTY" }, user: { institutionId: A } },
    select: { user: { select: { email: true } } },
  });
  assert.deepEqual(holders.map((holder) => holder.user.email).sort(), [
    "df-it-faculty-x@test.local",
    "df-it-faculty-y@test.local",
    "df-it-faculty-z@test.local",
  ]);
  for (const id of [ADMIN, HEAD_A, HEAD_B, TA, TB]) {
    assert.equal((await roleKeysOf(id)).includes("DEPARTMENT_FACULTY"), false, `${id} was given the new role`);
  }
});

test("a disabled Faculty X can't sign in, and their open session ends", { skip: SKIP }, async () => {
  const { token } = await signIn(x.email, x.password);
  await college.setDepartmentFacultyActive(hodA(), { departmentId: ids.cse, userId: x.id, active: false });
  assert.equal(await getSessionUserByRawToken(token), null, "signed out everywhere");
  const refusedLogin = await loginService(x.email, x.password);
  assert.deepEqual(refusedLogin, { ok: false, reason: "account_inactive" });
  await college.setDepartmentFacultyActive(hodA(), { departmentId: ids.cse, userId: x.id, active: true });
  const again = await signIn(x.email, x.password);
  assert.deepEqual(again.user.roles.map((role) => role.key), ["DEPARTMENT_FACULTY"]);
});
