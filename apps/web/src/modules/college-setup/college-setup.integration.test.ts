import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import { ForbiddenError } from "@/modules/authorization/types";
import { verifyPassword } from "@/modules/auth-tenancy/password";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getStudentDashboard } from "@/modules/attendance-analytics/service";
import { listCapturableCohortsForActor } from "@/modules/attendance-capture/service";
import { getRollup, normalizeFilters } from "@/modules/attendance-reporting/service";
import { enrollStudentInCohortForRequest } from "@/modules/enrollment/service";
import { createStudentForRequest, listStudentsForRequest } from "@/modules/students/directory-service";
import { StudentError } from "@/modules/students/directory-types";
import { resolveCollegeScope } from "./scope.ts";
import * as college from "./service.ts";
import { CollegeSetupError } from "./types.ts";

/**
 * College setup against a real Postgres: the structure an administrator and a
 * head of department build, who may reach what, and that attendance, the
 * student portal and the reports see it without being told.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const A = "cs-it-inst";
const B = "cs-it-other";
const SCHOOL = "cs-it-school";
const NOW = "cs-it-now";
const OLD = "cs-it-old";
const B_NOW = "cs-it-b-now";
const ADMIN = "cs-it-admin";
const T1 = "cs-it-t1";
const T2 = "cs-it-t2";
const T3 = "cs-it-t3";
const STOPPED = "cs-it-stopped";
const B_ADMIN = "cs-it-b-admin";
const S_ADMIN = "cs-it-s-admin";
const INSTITUTIONS = [A, B, SCHOOL];

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
const hod = (userId = T2) => actor(userId, "HOD", A);
const refused = (pattern: RegExp) => (error: Error) => error instanceof CollegeSetupError && pattern.test(error.message);
const forbidden = (error: Error) => error instanceof ForbiddenError;

async function cleanup() {
  const where = { institutionId: { in: INSTITUTIONS } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.session.deleteMany({ where: { user: where } });
  await prisma.attendanceRecord.deleteMany({ where });
  await prisma.attendanceSession.deleteMany({ where });
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
  await prisma.user.deleteMany({ where });
  await prisma.institution.deleteMany({ where: { id: { in: INSTITUTIONS } } });
}

async function staff(id: string, institutionId: string, roleKey: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await prisma.user.create({
    data: {
      id,
      institutionId,
      email: `${id}@test.local`,
      name: id,
      passwordHash: "x",
      status,
      roleAssignments: { create: { roleId: role.id, institutionId } },
    },
  });
}

async function roleKeys(userId: string): Promise<string[]> {
  const rows = await prisma.userRoleAssignment.findMany({ where: { userId }, select: { role: { select: { key: true } } } });
  return rows.map((row) => row.role.key).sort();
}

const ids: Record<string, string> = {};

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  const settings = { attendanceMode: "SUBJECT_WISE" };
  await prisma.institution.createMany({
    data: [
      { id: A, name: "College IT", type: "COLLEGE", settings },
      { id: B, name: "Other College IT", type: "COLLEGE", settings },
      { id: SCHOOL, name: "School IT", type: "SCHOOL" },
    ],
  });
  await prisma.academicSession.createMany({
    data: [
      { id: NOW, institutionId: A, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
      { id: OLD, institutionId: A, name: "2025-26", startDate: new Date("2025-07-01Z"), endDate: new Date("2026-05-31Z"), isActive: false },
      { id: B_NOW, institutionId: B, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    ],
  });
  await staff(ADMIN, A, "COLLEGE_ADMIN");
  for (const id of [T1, T2, T3]) await staff(id, A, "FACULTY");
  await staff(STOPPED, A, "FACULTY", "INACTIVE");
  await staff(B_ADMIN, B, "COLLEGE_ADMIN");
  await staff(S_ADMIN, SCHOOL, "SCHOOL_ADMIN");
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

test("departments are created by an administrator, unique by code and by name, and at colleges only", { skip: SKIP }, async () => {
  ids.cse = (await college.createDepartment(admin(), { name: "Computer  Science", code: "cse" })).departmentId;
  ids.me = (await college.createDepartment(admin(), { name: "Mechanical Engineering", code: "ME" })).departmentId;
  const cse = await prisma.academicUnit.findUniqueOrThrow({ where: { id: ids.cse } });
  assert.deepEqual([cse.kind, cse.name, cse.code], ["DEPARTMENT", "Computer Science", "CSE"]);

  await assert.rejects(() => college.createDepartment(admin(), { name: "Computing", code: "Cse" }), refused(/already uses the code CSE/));
  await assert.rejects(() => college.createDepartment(admin(), { name: "computer science", code: "CS2" }), refused(/already has a department called/));
  await assert.rejects(() => college.createDepartment(actor(S_ADMIN, "SCHOOL_ADMIN", SCHOOL), { name: "X", code: "X" }), refused(/colleges only/));
  // Another college keeps its own codes.
  ids.bCse = (await college.createDepartment(actor(B_ADMIN, "COLLEGE_ADMIN", B), { name: "Computer Science", code: "CSE" })).departmentId;

  const audit = await prisma.auditLog.findFirst({ where: { entityId: ids.cse, action: "academic_unit.created" } });
  assert.deepEqual(audit?.afterJson, { kind: "DEPARTMENT", name: "Computer Science", code: "CSE" });
  assert.equal(audit?.actorUserId, ADMIN);
});

test("naming a head swaps their teaching role for HOD, sets their department, and the department names them", { skip: SKIP }, async () => {
  const result = await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: T1 });
  assert.equal(result.name, T1);
  assert.deepEqual(await roleKeys(T1), ["HOD"]);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: T1 } })).departmentId, ids.cse);
  const cse = await prisma.academicUnit.findUniqueOrThrow({ where: { id: ids.cse } });
  assert.deepEqual(cse.metadata, { headUserId: T1 });
  assert.deepEqual(await resolveCollegeScope(hod(T1)), { kind: "hod", institutionId: A, departmentId: ids.cse });

  const changed = await prisma.auditLog.findFirstOrThrow({ where: { entityId: T1, action: "user.role_changed" } });
  assert.deepEqual(changed.beforeJson, { roles: ["FACULTY"] });
  assert.deepEqual(changed.afterJson, { roles: ["HOD"], headOfDepartmentId: ids.cse });
});

test("a person heads one department; a new head returns the old one to teaching", { skip: SKIP }, async () => {
  await assert.rejects(() => college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: T1 }), refused(/already heads Computer Science/));
  await assert.rejects(() => college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: ADMIN }), refused(/college administrator/));
  await assert.rejects(() => college.assignDepartmentHead(admin(), { departmentId: ids.me, userId: STOPPED }), refused(/access has been stopped/));
  await assert.rejects(() => college.assignDepartmentHead(admin(), { departmentId: ids.bCse, userId: T2 }), refused(/not part of this college/));

  const result = await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: T2 });
  assert.equal(result.replaced, T1);
  assert.deepEqual(await roleKeys(T1), ["FACULTY"]);
  assert.deepEqual(await roleKeys(T2), ["HOD"]);
  await assert.rejects(() => resolveCollegeScope(hod(T1)), forbidden, "a head who stepped down keeps nothing");
  // T1 stays in the department as a teacher; T3 belongs to Mechanical.
  await prisma.user.update({ where: { id: T3 }, data: { departmentId: ids.me } });
});

test("the head builds their department: semester, course with its subject, sections with teachers", { skip: SKIP }, async () => {
  ids.s4 = (await college.createSemester(hod(), { departmentId: ids.cse, number: "4" })).semesterId;
  assert.equal((await prisma.academicUnit.findUniqueOrThrow({ where: { id: ids.s4 } })).name, "4th Semester");
  await assert.rejects(() => college.createSemester(hod(), { departmentId: ids.cse, number: 4, name: "Sem IV" }), refused(/already has semester 4/));
  await college.setCurrentSemester(hod(), { departmentId: ids.cse, semesterId: ids.s4 });

  ids.phy = (await college.createCourse(hod(), { departmentId: ids.cse, semesterId: ids.s4, code: "phy401", name: "Physics" })).courseId;
  ids.che = (await college.createCourse(hod(), { departmentId: ids.cse, semesterId: ids.s4, code: "CHE402", name: "Chemistry" })).courseId;
  ids.mat = (await college.createCourse(hod(), { departmentId: ids.cse, semesterId: ids.s4, code: "MAT403", name: "Mathematics" })).courseId;
  const subject = await prisma.subject.findFirstOrThrow({ where: { institutionId: A, code: "PHY401" } });
  assert.equal(subject.name, "Physics");
  await assert.rejects(
    () => college.createCourse(hod(), { departmentId: ids.cse, semesterId: ids.s4, code: "PHY401", name: "Physics again" }),
    refused(/unique across the college/),
  );

  const phy = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sessionId: NOW };
  const made = await college.addCourseSections(hod(), {
    ...phy,
    sections: [{ name: "A", teacherId: T1 }, { name: "B", teacherId: T2 }, { name: "C" }],
  });
  [ids.phyA, ids.phyB, ids.phyC] = made.sectionIds;
  const groups = await prisma.cohort.findMany({
    where: { id: { in: made.sectionIds } },
    orderBy: { name: "asc" },
    select: { name: true, subjects: { select: { subjectId: true, facultyId: true } }, facultyLinks: { select: { userId: true, role: true } } },
  });
  assert.deepEqual(groups.map((group) => group.name), ["PHY401-A", "PHY401-B", "PHY401-C"]);
  assert.deepEqual(groups.map((group) => group.subjects), [
    [{ subjectId: subject.id, facultyId: T1 }],
    [{ subjectId: subject.id, facultyId: T2 }],
    [{ subjectId: subject.id, facultyId: null }],
  ]);
  assert.deepEqual(groups.map((group) => group.facultyLinks), [[{ userId: T1, role: "PRIMARY" }], [{ userId: T2, role: "PRIMARY" }], []]);

  await assert.rejects(() => college.addCourseSections(hod(), { ...phy, sections: [{ name: "section a" }] }), refused(/already has Section A/));
  await assert.rejects(() => college.addCourseSections(hod(), { ...phy, sections: [{ name: "D", teacherId: T3 }] }), refused(/not in your department/));
  await assert.rejects(() => college.addCourseSections(hod(), { ...phy, sessionId: OLD, sections: [{ name: "Z" }] }), refused(/archived/));

  ids.cheB = (await college.addCourseSections(hod(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.che, sessionId: NOW, sections: [{ name: "A" }, { name: "B", teacherId: T1 }] })).sectionIds[1];
  ids.matA = (await college.addCourseSections(hod(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.mat, sessionId: NOW, sections: [{ name: "A", teacherId: T2 }] })).sectionIds[0];
});

test("a head of department reaches nothing outside their department", { skip: SKIP }, async () => {
  // Mechanical, set up by the administrator.
  ids.meS1 = (await college.createSemester(admin(), { departmentId: ids.me, number: 1 })).semesterId;
  ids.mec = (await college.createCourse(admin(), { departmentId: ids.me, semesterId: ids.meS1, code: "MEC101", name: "Mechanics" })).courseId;
  ids.mecA = (await college.addCourseSections(admin(), { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sessionId: NOW, sections: [{ name: "A", teacherId: T3 }] })).sectionIds[0];
  const me = { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sectionId: ids.mecA };

  assert.equal(await college.getDepartmentDetail(hod(), ids.me), null);
  assert.equal(await college.getSemesterDetail(hod(), ids.me, ids.meS1), null);
  assert.equal(await college.getCourseDetail(hod(), ids.me, ids.meS1, ids.mec), null);
  assert.equal(await college.getCourseSectionDetail(hod(), me), null);
  assert.equal(await college.getDepartmentStudents(hod(), ids.me), null);
  assert.equal(await college.getDepartmentFaculty(hod(), ids.me), null);
  assert.deepEqual((await college.getDepartmentsOverview(hod())).departments.map((d) => d.id), [ids.cse]);
  assert.deepEqual((await college.getCoursesIndex(hod())).courses.map((course) => course.code).sort(), ["CHE402", "MAT403", "PHY401"]);

  await assert.rejects(() => college.createSemester(hod(), { departmentId: ids.me, number: 2 }), refused(/not part of this college/));
  await assert.rejects(() => college.createCourse(hod(), { departmentId: ids.me, semesterId: ids.meS1, code: "X1", name: "X" }), refused(/not part of this college/));
  await assert.rejects(() => college.setCourseSectionTeacher(hod(), { ...me, teacherId: T2 }), refused(/not part of this college/));
  await assert.rejects(() => college.addStudentsToSection(hod(), me, "ANY"), refused(/not part of this college/));
  // CSE's id in front of Mechanical's semester: the chain is checked, not just the first id.
  await assert.rejects(() => college.createCourse(hod(), { departmentId: ids.cse, semesterId: ids.meS1, code: "X2", name: "X" }), refused(/not part of this department/));
  await assert.rejects(() => college.removeCourseSection(hod(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.mecA }), refused(/not part of this course/));

  // Administrator-only work.
  await assert.rejects(() => college.createDepartment(hod(), { name: "Civil", code: "CE" }), forbidden);
  await assert.rejects(() => college.assignDepartmentHead(hod(), { departmentId: ids.cse, userId: T1 }), forbidden);
  await assert.rejects(() => college.resetDepartmentHeadPassword(hod(), ids.cse), forbidden);
  // A head may create a teacher from a section page — department faculty, in their own department only
  // (college-setup.department-faculty.integration.test.ts) — so another department's section is refused.
  await assert.rejects(() => college.inviteTeacherForCourseSection(hod(), { ...me, name: "N", email: "n@test.local" }), refused(/not part of this college/));
  // The institution-wide screens refuse the head outright.
  await assert.rejects(() => listStudentsForRequest(hod(), { q: "", status: "ACTIVE", cohortId: "", campusId: "", sort: "name_asc", page: 1 } as never), forbidden);
  await assert.rejects(() => enrollStudentInCohortForRequest(hod(), { studentId: "x", cohortId: ids.mecA }), forbidden);
});

test("another college's ids read as not found, for its administrator and for a head", { skip: SKIP }, async () => {
  const other = actor(B_ADMIN, "COLLEGE_ADMIN", B);
  const cseSection = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyA };
  assert.equal(await college.getDepartmentDetail(other, ids.cse), null);
  assert.equal(await college.getCourseSectionDetail(other, cseSection), null);
  await assert.rejects(() => college.createSemester(other, { departmentId: ids.cse, number: 5 }), refused(/not part of this college/));
  await assert.rejects(() => college.addStudentsToSection(other, cseSection, "X"), refused(/not part of this college/));
  assert.equal(await college.getDepartmentDetail(hod(), ids.bCse), null);
  await assert.rejects(() => college.createSemester(hod(), { departmentId: ids.bCse, number: 1 }), refused(/not part of this college/));
});

test("students: admitted into a section, added to other courses by ID, removed with their history kept", { skip: SKIP }, async () => {
  const phyA = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyA };
  const cheB = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.che, sectionId: ids.cheB };
  const form = { email: "", phone: "", campusId: "", admissionNumber: "", admissionDate: "" };

  const aman = await college.addNewStudentToSection(hod(), phyA, {
    ...form,
    email: "cs-it-cse2601@test.local",
    studentCode: "CSE2601",
    firstName: "Aman",
    lastName: "Sharma",
  });
  ids.aman = aman.studentId;
  const placed = await prisma.enrollment.findUniqueOrThrow({ where: { studentId_cohortId: { studentId: aman.studentId, cohortId: ids.phyA } } });
  assert.equal(placed.status, "ACTIVE");
  const created = await prisma.auditLog.findFirstOrThrow({ where: { entityId: aman.studentId, action: "student.created" } });
  assert.equal(created.actorUserId, T2, "the student service's audit row, naming the head");
  // The head was lent the permission for that one call only.
  await assert.rejects(
    () => createStudentForRequest(hod(), { ...form, studentCode: "CSE2699", firstName: "No", lastName: "Way" }),
    forbidden,
  );
  // The student service's own duplicate check, unchanged: codes are compared as written.
  await assert.rejects(
    () => college.addNewStudentToSection(hod(), phyA, { ...form, studentCode: "CSE2601", firstName: "A", lastName: "B" }),
    (error: Error) => error instanceof StudentError && /already belongs to Aman Sharma/.test(error.message),
  );

  await prisma.student.create({ data: { id: "cs-it-left", institutionId: A, studentCode: "CSE2690", firstName: "Left", lastName: "Early", status: "INACTIVE" } });
  const first = await college.addStudentsToSection(hod(), cheB, "cse2601, NOPE9\nCSE2690");
  assert.deepEqual(first.added, ["Aman Sharma (CSE2601)"], "one student has an ID like cse2601");
  assert.deepEqual(first.skipped, ["No student has the ID NOPE9.", "Left Early (CSE2690) is not on roll."]);
  assert.deepEqual((await college.addStudentsToSection(hod(), cheB, "CSE2601")).skipped, ["Aman Sharma (CSE2601) is already in CHE402-B."]);

  await college.removeStudentFromSection(hod(), cheB, aman.studentId);
  const ended = await prisma.enrollment.findUniqueOrThrow({ where: { studentId_cohortId: { studentId: aman.studentId, cohortId: ids.cheB } } });
  assert.equal(ended.status, "INACTIVE");
  assert.ok(ended.unenrolledAt, "ended, not deleted");
  await college.addStudentsToSection(hod(), cheB, "CSE2601");
  await college.addStudentsToSection(hod(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.mat, sectionId: ids.matA }, "CSE2601");

  const department = await college.getDepartmentStudents(hod(), ids.cse);
  const row = department?.students.find((student) => student.studentId === aman.studentId);
  assert.deepEqual(row?.sections.map((section) => section.groupName).sort(), ["CHE402-B", "MAT403-A", "PHY401-A"]);
  const phyB = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyB };
  const offered = await college.searchStudentsForSection(hod(), phyB, "");
  assert.deepEqual(offered?.suggestions.map((student) => student.studentCode), ["CSE2601"], "offered for sections they are not in");

  // Two students whose IDs differ only in case: the exact one is taken, and a guess between them is refused.
  await prisma.student.create({ data: { id: "cs-it-twin", institutionId: A, studentCode: "cse2601", firstName: "Other", lastName: "Aman" } });
  const guess = await college.addStudentsToSection(hod(), phyB, "Cse2601");
  assert.deepEqual(guess, { added: [], skipped: ["More than one student has an ID like Cse2601. Enter it exactly as it is written."] });
  assert.deepEqual((await college.addStudentsToSection(hod(), phyB, "cse2601")).added, ["Other Aman (cse2601)"]);
});

test("a teacher sees exactly the sections they were given to take attendance", { skip: SKIP }, async () => {
  const names = async (user: SessionUser) => (await listCapturableCohortsForActor(user)).map((cohort) => cohort.name).sort();
  assert.deepEqual(await names(actor(T1, "FACULTY", A)), ["CHE402-B", "PHY401-A"]);
  assert.deepEqual(await names(actor(T3, "FACULTY", A)), ["MEC101-A"]);
  assert.deepEqual(await names(hod()), ["MAT403-A", "PHY401-B"], "the head teaches their own, like anyone");
});

test("a college student's portal lists each course on its own, and agrees with the report", { skip: SKIP }, async () => {
  const courseLink = async (cohortId: string) =>
    (await prisma.cohortSubject.findFirstOrThrow({ where: { cohortId }, select: { id: true } })).id;
  const register = async (id: string, cohortId: string, day: number, result: "PRESENT" | "ABSENT") => {
    await prisma.attendanceSession.create({
      data: {
        id,
        institutionId: A,
        cohortId,
        cohortSubjectId: await courseLink(cohortId),
        facultyId: T1,
        sessionDate: new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`),
        startedAt: new Date(`2026-09-${String(day).padStart(2, "0")}T09:00:00.000Z`),
        status: "FINALIZED",
      },
    });
    await prisma.attendanceRecord.create({
      data: { id: `${id}-r`, institutionId: A, sessionId: id, studentId: ids.aman, aiResult: result, finalResult: result },
    });
  };
  await register("cs-it-p1", ids.phyA, 10, "PRESENT");
  await register("cs-it-p2", ids.phyA, 11, "PRESENT");
  await register("cs-it-p3", ids.phyA, 12, "ABSENT");
  await register("cs-it-c1", ids.cheB, 10, "PRESENT");
  await register("cs-it-c2", ids.cheB, 11, "PRESENT");

  // Aman was admitted with his Student Portal login, so there is no login to provision.
  const account = await prisma.student.findUniqueOrThrow({ where: { id: ids.aman }, select: { userId: true } });
  assert.ok(account.userId, "admitted with a login");
  const view = await getStudentDashboard(actor(account.userId!, "STUDENT", A));
  assert.equal(view?.attendanceMode, "SUBJECT_WISE");
  assert.deepEqual(view?.overall, { present: 4, absent: 1, total: 5, percentage: 80 });
  assert.deepEqual(
    Object.fromEntries((view?.subjects ?? []).map((subject) => [subject.subjectName, subject.rate])),
    {
      Chemistry: { present: 2, absent: 0, total: 2, percentage: 100 },
      Physics: { present: 2, absent: 1, total: 3, percentage: 66.7 },
    },
  );

  const filters = normalizeFilters({ from: "2026-09-01", to: "2026-09-30" }, new Date("2026-09-27T12:00:00Z"));
  const report = await getRollup(admin(), "student", filters, { page: 1, pageSize: 50 });
  assert.deepEqual(report.rows.find((candidate) => candidate.key === ids.aman)?.rate, view?.overall);
});

test("renaming a course renames its subject and this session's sections; a used section is kept", { skip: SKIP }, async () => {
  const course = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy };
  await college.updateCourse(hod(), { ...course, code: "PHY411", name: "Physics I", sessionId: NOW });
  const subject = await prisma.subject.findFirstOrThrow({ where: { institutionId: A, code: "PHY411" } });
  assert.equal(subject.name, "Physics I");
  assert.equal(await prisma.subject.count({ where: { institutionId: A, code: "PHY401" } }), 0, "renamed, not duplicated");
  const names = (await prisma.cohort.findMany({ where: { id: { in: [ids.phyA, ids.phyB, ids.phyC] } }, select: { name: true } }))
    .map((group) => group.name)
    .sort();
  assert.deepEqual(names, ["PHY411-A", "PHY411-B", "PHY411-C"]);
  await assert.rejects(
    () => college.updateCourse(hod(), { ...course, code: "CHE402", name: "Physics I" }),
    refused(/already used by Chemistry/),
  );

  await assert.rejects(
    () => college.removeCourseSection(hod(), { ...course, sectionId: ids.phyA }),
    refused(/can't be removed\..*1 student has been placed in this section.*Attendance has been taken for this section 3 times/),
  );
  await college.removeCourseSection(hod(), { ...course, sectionId: ids.phyC });
  assert.equal(await prisma.cohort.count({ where: { id: ids.phyC } }), 0);
  assert.equal(await prisma.cohortSubject.count({ where: { cohortId: ids.phyC } }), 0);

  await college.renameCourseSection(hod(), { ...course, sectionId: ids.phyB, name: "D" });
  assert.equal((await prisma.cohort.findUniqueOrThrow({ where: { id: ids.phyB } })).name, "PHY411-D");
  await assert.rejects(() => college.removeCourse(hod(), course), refused(/has had sections/));
  await assert.rejects(() => college.removeSemester(hod(), { departmentId: ids.cse, semesterId: ids.s4 }), refused(/has courses/));
});

test("a head moved to another department elsewhere loses theirs, and gains nothing", { skip: SKIP }, async () => {
  await prisma.user.update({ where: { id: T2 }, data: { departmentId: ids.me } });
  await assert.rejects(() => resolveCollegeScope(hod()), forbidden);
  assert.equal((await college.getDepartmentDetail(admin(), ids.cse))?.hod?.consistent, false);
  await prisma.user.update({ where: { id: T2 }, data: { departmentId: ids.cse } });
  assert.equal((await college.getDepartmentDetail(admin(), ids.cse))?.hod?.consistent, true);
  assert.equal((await resolveCollegeScope(hod())).kind, "hod");
});

test("the head's password: a reset shows a new one once and ends every session; disable and enable", { skip: SKIP }, async () => {
  await prisma.session.create({ data: { userId: T2, tokenHash: "cs-it-token-hash", expiresAt: new Date(Date.now() + 3_600_000) } });
  const issued = await college.resetDepartmentHeadPassword(admin(), ids.cse);
  ids.resetPassword = issued.password;
  assert.ok(issued.password.length >= 12);
  const head = await prisma.user.findUniqueOrThrow({ where: { id: T2 } });
  assert.equal(await verifyPassword(issued.password, head.passwordHash!), true);
  assert.equal(await prisma.session.count({ where: { userId: T2 } }), 0);

  await college.setDepartmentHeadActive(admin(), ids.cse, false);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: T2 } })).status, "INACTIVE");
  await assert.rejects(() => resolveCollegeScope(hod()), forbidden, "a disabled head reaches nothing");
  await college.setDepartmentHeadActive(admin(), ids.cse, true);
  assert.equal((await resolveCollegeScope(hod())).kind, "hod");
});

test("a new head's account is created, made head, and its password returned once", { skip: SKIP }, async () => {
  const result = await college.createDepartmentHead(admin(), {
    departmentId: ids.me,
    name: "Dr. Mechanical Head",
    email: "cs-it-mehead@test.local",
  });
  ids.newHeadPassword = result.invited.password;
  assert.equal(result.assignError, null);
  const user = await prisma.user.findUniqueOrThrow({ where: { email: "cs-it-mehead@test.local" } });
  assert.deepEqual(await roleKeys(user.id), ["HOD"]);
  assert.equal(user.departmentId, ids.me);
  assert.deepEqual(
    (await prisma.academicUnit.findUniqueOrThrow({ where: { id: ids.me } })).metadata,
    { headUserId: user.id },
  );
  assert.deepEqual((await resolveCollegeScope(actor(user.id, "HOD", A))).kind, "hod");

  await college.removeDepartmentHead(admin(), ids.me);
  assert.deepEqual(await roleKeys(user.id), ["FACULTY"]);
  assert.deepEqual((await prisma.academicUnit.findUniqueOrThrow({ where: { id: ids.me } })).metadata, {});
});

test("no audit row carries a password, a hash or a token", { skip: SKIP }, async () => {
  const rows = await prisma.auditLog.findMany({ where: { institutionId: { in: INSTITUTIONS } } });
  assert.ok(rows.length > 20, `${rows.length} audit rows written`);
  const text = JSON.stringify(rows.map((row) => [row.action, row.beforeJson, row.afterJson]));
  for (const secret of [ids.resetPassword, ids.newHeadPassword]) {
    assert.ok(secret && !text.includes(secret), "an issued password reached the audit log");
  }
  assert.doesNotMatch(text, /scrypt\$|passwordHash|tokenHash|rawToken/);
});
