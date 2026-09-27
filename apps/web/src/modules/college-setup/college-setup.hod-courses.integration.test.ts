import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { SYSTEM_ROLES, type PermissionKey } from "@/modules/authorization/permissions";
import { ensureSystemRolesAndPermissions } from "@/modules/authorization/bootstrap";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getStudentDashboard } from "@/modules/attendance-analytics/service";
import {
  listCapturableCohortsForActor,
  listCohortSubjectsForCapture,
  startOrResumeCaptureSession,
} from "@/modules/attendance-capture/service";
import { provisionStudentLogin } from "@/modules/students/login-provisioning";
import * as college from "./service.ts";
import { CollegeSetupError } from "./types.ts";

/**
 * A head of department runs their courses from the Courses page: add a course
 * to one of their semesters, add its sections one at a time with a teacher
 * each, find the college's students and add them, open a student, take one
 * out — against a real Postgres, with a second department and a second
 * college to reach for.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const A = "hc-it-inst";
const B = "hc-it-other";
const NOW = "hc-it-now";
const B_NOW = "hc-it-b-now";
const ADMIN = "hc-it-admin";
const HEAD = "hc-it-head";
const TA = "hc-it-teacher-a";
const TB = "hc-it-teacher-b";
const TC = "hc-it-teacher-c";
const TM = "hc-it-teacher-mech";
const B_ADMIN = "hc-it-b-admin";
const INSTITUTIONS = [A, B];

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
const chemistryB = () => ({ departmentId: ids.cse, semesterId: ids.s4, courseId: ids.che, sectionId: ids.cheB });
const enrolment = (studentId: string, cohortId: string) =>
  prisma.enrollment.findUnique({ where: { studentId_cohortId: { studentId, cohortId } } });

before(async () => {
  if (SKIP) return;
  await ensureSystemRolesAndPermissions(prisma);
  await cleanup();
  const settings = { attendanceMode: "SUBJECT_WISE" };
  await prisma.institution.createMany({
    data: [
      { id: A, name: "HOD Courses College", type: "COLLEGE", settings },
      { id: B, name: "Elsewhere College", type: "COLLEGE", settings },
    ],
  });
  await prisma.academicSession.createMany({
    data: [
      { id: NOW, institutionId: A, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
      { id: B_NOW, institutionId: B, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
    ],
  });
  await staff(ADMIN, A, "COLLEGE_ADMIN");
  for (const id of [HEAD, TA, TB, TC, TM]) await staff(id, A, "FACULTY");
  await staff(B_ADMIN, B, "COLLEGE_ADMIN");

  // The Director's part, unchanged: departments, a head, a semester made current.
  ids.cse = (await college.createDepartment(admin(), { name: "Computer Science", code: "CSE" })).departmentId;
  ids.me = (await college.createDepartment(admin(), { name: "Mechanical", code: "ME" })).departmentId;
  await college.assignDepartmentHead(admin(), { departmentId: ids.cse, userId: HEAD });
  await prisma.user.updateMany({ where: { id: { in: [TA, TB, TC] } }, data: { departmentId: ids.cse } });
  await prisma.user.update({ where: { id: TM }, data: { departmentId: ids.me } });
  ids.s3 = (await college.createSemester(hod(), { departmentId: ids.cse, number: 3 })).semesterId;
  ids.s4 = (await college.createSemester(hod(), { departmentId: ids.cse, number: 4 })).semesterId;
  await college.setCurrentSemester(hod(), { departmentId: ids.cse, semesterId: ids.s4 });
  ids.meS1 = (await college.createSemester(admin(), { departmentId: ids.me, number: 1 })).semesterId;
  ids.mec = (await college.createCourse(admin(), { departmentId: ids.me, semesterId: ids.meS1, code: "MEC101", name: "Mechanics" })).courseId;
  ids.mecA = (await college.addCourseSections(admin(), { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sessionId: NOW, sections: [{ name: "A", teacherId: TM }] })).sectionIds[0];

  await student("hc-it-s1", A, "CSE001", "Aman", "Kumar", "ADM-11");
  await student("hc-it-s2", A, "CSE002", "Rahul", "Singh");
  await student("hc-it-s3", A, "CSE003", "Simran", "Kaur");
  await student("hc-it-left", A, "CSE090", "Left", "Early");
  await prisma.student.update({ where: { id: "hc-it-left" }, data: { status: "INACTIVE" } });
  await student("hc-it-elsewhere", B, "CSE001", "Aman", "Elsewhere");
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

test("the head's Courses page names their department, its semesters and the current one", { skip: SKIP }, async () => {
  const index = await college.getCoursesIndex(hod());
  assert.equal(index.scope, "hod", "the page offers + Add course to a head of department");
  assert.deepEqual(index.departments.map((department) => department.id), [ids.cse]);
  const [own] = index.departments;
  assert.deepEqual(own.semesters.map((semester) => semester.name), ["3rd Semester", "4th Semester"], "their semesters only");
  assert.equal(own.currentSemesterId, ids.s4, "the add form starts on the current semester");
  assert.deepEqual(index.courses, []);
});

test("a course added from the Courses page lands in the head's semester, with its subject", { skip: SKIP }, async () => {
  const created = await college.createCourse(hod(), { semesterId: ids.s4, code: "phy401", name: "Physics" });
  ids.phy = created.courseId;
  assert.deepEqual([created.departmentId, created.semesterId], [ids.cse, ids.s4], "the department is the semester's own");
  const unit = await prisma.academicUnit.findUniqueOrThrow({ where: { id: ids.phy } });
  assert.deepEqual([unit.kind, unit.code, unit.name, unit.parentId], ["COURSE", "PHY401", "Physics", ids.s4]);
  assert.equal((await prisma.subject.findFirstOrThrow({ where: { institutionId: A, code: "PHY401" } })).name, "Physics");
  ids.che = (await college.createCourse(hod(), { semesterId: ids.s4, code: "CHE402", name: "Chemistry" })).courseId;

  // The code rule is the one it always was: unique across the college.
  await assert.rejects(() => college.createCourse(hod(), { semesterId: ids.s3, code: "Phy401", name: "Physics again" }), refused(/unique across the college/));
  await assert.rejects(() => college.createCourse(hod(), { semesterId: "", code: "X1", name: "X" }), refused(/Choose the semester/));
  const index = await college.getCoursesIndex(hod());
  assert.deepEqual(index.courses.map((course) => course.code).sort(), ["CHE402", "PHY401"]);
});

test("a head cannot add a course to another department's semester, or another college's", { skip: SKIP }, async () => {
  const before = await prisma.academicUnit.count({ where: { institutionId: A, kind: "COURSE" } });
  await assert.rejects(() => college.createCourse(hod(), { semesterId: ids.meS1, code: "HACK1", name: "Hack" }), refused(/not part of this college/));
  await assert.rejects(
    () => college.createCourse(hod(), { departmentId: ids.cse, semesterId: ids.meS1, code: "HACK2", name: "Hack" }),
    refused(/not part of this department/),
  );
  const elsewhere = await college.createDepartment(actor(B_ADMIN, "COLLEGE_ADMIN", B), { name: "Computer Science", code: "CSE" });
  const bSemester = await college.createSemester(actor(B_ADMIN, "COLLEGE_ADMIN", B), { departmentId: elsewhere.departmentId, number: 1 });
  await assert.rejects(() => college.createCourse(hod(), { semesterId: bSemester.semesterId, code: "HACK3", name: "Hack" }), refused(/not part of this/));
  assert.equal(await prisma.academicUnit.count({ where: { institutionId: A, kind: "COURSE" } }), before, "nothing was created");
});

test("sections are added one at a time, each with a department teacher, and a teacher from elsewhere is refused", { skip: SKIP }, async () => {
  const phy = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sessionId: NOW };
  const detail = await college.getCourseDetail(hod(), ids.cse, ids.s4, ids.phy);
  // The department's own teachers — the head among them, who teaches like anyone — and nobody from Mechanical.
  assert.deepEqual(detail?.teachers.map((choice) => choice.id).sort(), [HEAD, TA, TB, TC].sort());

  ids.phyA = (await college.addCourseSections(hod(), { ...phy, sections: [{ name: "A", teacherId: TA }] })).sectionIds[0];
  ids.phyB = (await college.addCourseSections(hod(), { ...phy, sections: [{ name: "B" }] })).sectionIds[0];
  ids.phyC = (await college.addCourseSections(hod(), { ...phy, sections: [{ name: "C", teacherId: TC }] })).sectionIds[0];
  const course = await college.getCourseDetail(hod(), ids.cse, ids.s4, ids.phy);
  assert.deepEqual(
    course?.sections.map((section) => [section.groupName, section.teacher?.userId ?? null, section.status]),
    [
      ["PHY401-A", TA, "ready"],
      ["PHY401-B", null, "needs_teacher"],
      ["PHY401-C", TC, "ready"],
    ],
  );

  // Section B needs a teacher: the head assigns one of theirs, and never Mechanical's.
  const sectionB = { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.phy, sectionId: ids.phyB };
  await assert.rejects(() => college.setCourseSectionTeacher(hod(), { ...sectionB, teacherId: TM }), refused(/not in your department/));
  await assert.rejects(() => college.addCourseSections(hod(), { ...phy, sections: [{ name: "D", teacherId: TM }] }), refused(/not in your department/));
  await college.setCourseSectionTeacher(hod(), { ...sectionB, teacherId: TB });
  const group = await prisma.cohort.findUniqueOrThrow({
    where: { id: ids.phyB },
    select: { facultyLinks: { select: { userId: true, role: true } }, subjects: { select: { facultyId: true } } },
  });
  assert.deepEqual(group.facultyLinks, [{ userId: TB, role: "PRIMARY" }]);
  assert.deepEqual(group.subjects, [{ facultyId: TB }], "the course link names the same teacher");

  ids.cheB = (await college.addCourseSections(hod(), { departmentId: ids.cse, semesterId: ids.s4, courseId: ids.che, sessionId: NOW, sections: [{ name: "B", teacherId: TB }] })).sectionIds[0];
});

test("the college's students are found by ID, name or admission number — this college's only", { skip: SKIP }, async () => {
  const byId = await college.searchStudentsForSection(hod(), physicsA(), "cse001");
  assert.deepEqual(byId?.results.map((row) => row.studentId), ["hc-it-s1"], "exactly one CSE001 here; the other college's is never read");
  const byName = await college.searchStudentsForSection(hod(), physicsA(), "  aman  KUM ");
  assert.deepEqual(byName?.results.map((row) => row.studentId), ["hc-it-s1"]);
  assert.equal(byName?.query, "aman KUM");
  const byAdmission = await college.searchStudentsForSection(hod(), physicsA(), "adm-11");
  assert.deepEqual(byAdmission?.results.map((row) => [row.studentCode, row.admissionNumber]), [["CSE001", "ADM-11"]]);
  const offRoll = await college.searchStudentsForSection(hod(), physicsA(), "CSE090");
  assert.deepEqual(offRoll?.results.map((row) => row.status), ["INACTIVE"], "listed, so the head sees why it cannot be added");
  const tooShort = await college.searchStudentsForSection(hod(), physicsA(), "a");
  assert.deepEqual([tooShort?.searched, tooShort?.results.length], [false, 0]);
  const none = await college.searchStudentsForSection(hod(), physicsA(), "Elsewhere");
  assert.deepEqual(none?.results, [], "another college's student is not found by name either");
});

test("students are added to Physics A one at a time; one from another college is refused", { skip: SKIP }, async () => {
  for (const id of ["hc-it-s1", "hc-it-s2", "hc-it-s3"]) {
    const added = await college.addStudentToSection(hod(), physicsA(), id);
    assert.equal(added.studentId, id);
  }
  const section = await college.getCourseSectionDetail(hod(), physicsA());
  assert.deepEqual(section?.students.map((row) => row.studentCode).sort(), ["CSE001", "CSE002", "CSE003"]);

  await assert.rejects(() => college.addStudentToSection(hod(), physicsA(), "hc-it-elsewhere"), refused(/not part of this college/));
  await assert.rejects(() => college.addStudentToSection(hod(), physicsA(), "hc-it-s1"), refused(/already in PHY401-A/));
  await assert.rejects(() => college.addStudentToSection(hod(), physicsA(), "hc-it-left"), refused(/not on roll/));
  assert.equal(await prisma.enrollment.count({ where: { studentId: "hc-it-elsewhere" } }), 0);

  // The search marks who is already in, and names the student just added while they are.
  const search = await college.searchStudentsForSection(hod(), physicsA(), "CSE00", "hc-it-s2");
  assert.deepEqual(search?.results.filter((row) => row.inSection).map((row) => row.studentCode).sort(), ["CSE001", "CSE002", "CSE003"]);
  assert.deepEqual(search?.added, { studentId: "hc-it-s2", name: "Rahul Singh" });
  const stranger = await college.searchStudentsForSection(hod(), physicsA(), "", "hc-it-elsewhere");
  assert.equal(stranger?.added, null, "an id that is not in the section names nobody");
});

test("one student is in several courses' sections; adding to one leaves the others alone", { skip: SKIP }, async () => {
  const suggested = await college.searchStudentsForSection(hod(), chemistryB(), "");
  assert.deepEqual(
    suggested?.suggestions.map((row) => row.studentCode),
    ["CSE003", "CSE001", "CSE002"],
    "Physics A's students, by name, offered for Chemistry B",
  );
  await college.addStudentToSection(hod(), chemistryB(), "hc-it-s1");
  await college.addStudentToSection(hod(), chemistryB(), "hc-it-s3");
  assert.equal((await enrolment("hc-it-s1", ids.phyA))?.status, "ACTIVE", "still in Physics A");
  assert.equal((await enrolment("hc-it-s1", ids.cheB))?.status, "ACTIVE", "and in Chemistry B");

  const view = await college.getSectionStudent(hod(), physicsA(), "hc-it-s1");
  assert.deepEqual(
    view?.sections.map((row) => [row.groupName, row.teacherName]),
    [
      ["PHY401-A", TA],
      ["CHE402-B", TB],
    ],
    "this section first, then their others",
  );
  assert.deepEqual(
    [view?.student.studentCode, view?.student.admissionNumber, view?.student.faceEnrolled, view?.student.hasLogin],
    ["CSE001", "ADM-11", false, false],
  );
  assert.equal(view?.selfEnrollment, true, "a college lets students enrol their own face unless it says otherwise");
  assert.equal(await college.getSectionStudent(hod(), chemistryB(), "hc-it-s2"), null, "Rahul is not in Chemistry B");
  assert.equal(await college.getSectionStudent(hod(), physicsA(), "hc-it-elsewhere"), null);

  // The student's portal lists both courses' sections as soon as they are in them.
  await provisionStudentLogin(admin(), "hc-it-s1", {});
  const account = await prisma.student.findUniqueOrThrow({ where: { id: "hc-it-s1" }, select: { userId: true } });
  ids.accountUserId = account.userId!;
  const portal = await getStudentDashboard(actor(ids.accountUserId, "STUDENT", A));
  assert.deepEqual(portal?.enrollments.map((row) => row.cohortName).sort(), ["CHE402-B", "PHY401-A"]);
});

test("attendance is taken for the new section by its teacher, and reaches the student's portal", { skip: SKIP }, async () => {
  const capturable = (await listCapturableCohortsForActor(teacher(TA))).map((cohort) => cohort.name);
  assert.deepEqual(capturable, ["PHY401-A"], "Teacher A sees the section they were given");
  assert.deepEqual((await listCapturableCohortsForActor(teacher(TM))).map((cohort) => cohort.name), ["MEC101-A"]);
  const subjects = await listCohortSubjectsForCapture(teacher(TA), ids.phyA);
  assert.deepEqual(subjects.map((subject) => subject.subjectName), ["Physics"]);
  // Only the section's teacher starts its register.
  await assert.rejects(() => startOrResumeCaptureSession(teacher(TM), { cohortId: ids.phyA, cohortSubjectId: subjects[0].id }));
  const started = await startOrResumeCaptureSession(teacher(TA), { cohortId: ids.phyA, cohortSubjectId: subjects[0].id });
  assert.equal(started.enrolledStudentCount, 3);
  assert.equal(started.subjectName, "Physics");
  assert.equal(started.session.cohortId, ids.phyA);

  // A register taken and confirmed, the way the review screen finishes one.
  const link = await prisma.cohortSubject.findFirstOrThrow({ where: { cohortId: ids.cheB } });
  const register = async (id: string, cohortId: string, subjectLinkId: string, day: number, result: "PRESENT" | "ABSENT") => {
    await prisma.attendanceSession.create({
      data: {
        id,
        institutionId: A,
        cohortId,
        cohortSubjectId: subjectLinkId,
        facultyId: TA,
        sessionDate: new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`),
        startedAt: new Date(`2026-09-${String(day).padStart(2, "0")}T09:00:00.000Z`),
        status: "FINALIZED",
      },
    });
    await prisma.attendanceRecord.create({
      data: { id: `${id}-r`, institutionId: A, sessionId: id, studentId: "hc-it-s1", aiResult: result, finalResult: result },
    });
  };
  await register("hc-it-p1", ids.phyA, subjects[0].id, 10, "PRESENT");
  await register("hc-it-p2", ids.phyA, subjects[0].id, 11, "ABSENT");
  await register("hc-it-c1", ids.cheB, link.id, 10, "PRESENT");

  const portal = await getStudentDashboard(actor(ids.accountUserId, "STUDENT", A));
  assert.deepEqual(
    Object.fromEntries((portal?.subjects ?? []).map((subject) => [subject.subjectName, subject.rate])),
    {
      Chemistry: { present: 1, absent: 0, total: 1, percentage: 100 },
      Physics: { present: 1, absent: 1, total: 2, percentage: 50 },
    },
  );
});

test("taking a student out of Physics A ends only that place: the student, face, history and Chemistry B stay", { skip: SKIP }, async () => {
  // A face template, as enrolment writes one: a 128-number vector.
  const vector = `[${Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  await prisma.$executeRaw`
    INSERT INTO "FaceEmbedding" (id, "institutionId", "studentId", embedding, "modelName", "modelVersion", "embeddingDim", "isActive")
    VALUES ('hc-it-face-s1', ${A}, 'hc-it-s1', ${vector}::vector, 'hc-it-model', '1', 128, TRUE)`;
  const counts = async () => ({
    embeddings: await prisma.faceEmbedding.count({ where: { studentId: "hc-it-s1" } }),
    records: await prisma.attendanceRecord.count({ where: { studentId: "hc-it-s1" } }),
    registers: await prisma.attendanceSession.count({ where: { cohortId: ids.phyA } }),
  });
  const before = await counts();

  const removed = await college.removeStudentFromSection(hod(), physicsA(), "hc-it-s1");
  assert.equal(removed.name, "Aman Kumar");
  const ended = await enrolment("hc-it-s1", ids.phyA);
  assert.equal(ended?.status, "INACTIVE");
  assert.ok(ended?.unenrolledAt, "ended, not deleted");
  assert.equal((await enrolment("hc-it-s1", ids.cheB))?.status, "ACTIVE", "Chemistry B is untouched");
  const record = await prisma.student.findUniqueOrThrow({ where: { id: "hc-it-s1" } });
  assert.deepEqual([record.status, record.userId], ["ACTIVE", ids.accountUserId], "the student and their login are kept");
  assert.deepEqual(await counts(), before, "face templates, attendance records and registers are all kept");

  // Physics A's list no longer has them; the student page only shows them where they are.
  const section = await college.getCourseSectionDetail(hod(), physicsA());
  assert.deepEqual(section?.students.map((row) => row.studentCode).sort(), ["CSE002", "CSE003"]);
  assert.equal(await college.getSectionStudent(hod(), physicsA(), "hc-it-s1"), null);
  assert.ok(await college.getSectionStudent(hod(), chemistryB(), "hc-it-s1"));

  // Their portal keeps Chemistry B as a current course, and the Physics attendance already taken.
  const portal = await getStudentDashboard(actor(ids.accountUserId, "STUDENT", A));
  assert.deepEqual(portal?.enrollments.map((row) => row.cohortName), ["CHE402-B"]);
  assert.deepEqual((portal?.subjects ?? []).map((subject) => subject.subjectName).sort(), ["Chemistry", "Physics"]);
  assert.equal(portal?.overall.total, 3, "every register they were on still counts");

  // Adding them back brings the same placement back, not a second one.
  await college.addStudentToSection(hod(), physicsA(), "hc-it-s1");
  assert.equal(await prisma.enrollment.count({ where: { studentId: "hc-it-s1", cohortId: ids.phyA } }), 1);
});

test("another department's ids, and mixed-up ids, read as not found and change nothing", { skip: SKIP }, async () => {
  const mechanics = { departmentId: ids.me, semesterId: ids.meS1, courseId: ids.mec, sectionId: ids.mecA };
  assert.equal(await college.getCourseDetail(hod(), ids.me, ids.meS1, ids.mec), null);
  assert.equal(await college.getCourseSectionDetail(hod(), mechanics), null);
  assert.equal(await college.searchStudentsForSection(hod(), mechanics, "CSE"), null);
  assert.equal(await college.getSectionStudent(hod(), mechanics, "hc-it-s2"), null);
  assert.equal(await college.getSectionPlacement(hod(), mechanics), null);
  // CSE's department in front of Mechanics' section, and a course from the wrong semester.
  assert.equal(await college.searchStudentsForSection(hod(), { ...physicsA(), sectionId: ids.mecA }, ""), null);
  assert.equal(await college.getSectionStudent(hod(), { ...physicsA(), semesterId: ids.s3 }, "hc-it-s2"), null);

  await assert.rejects(() => college.addStudentToSection(hod(), mechanics, "hc-it-s2"), refused(/not part of this college/));
  await assert.rejects(() => college.addStudentToSection(hod(), { ...physicsA(), sectionId: ids.mecA }, "hc-it-s2"), refused(/not part of this course/));
  await assert.rejects(() => college.removeStudentFromSection(hod(), mechanics, "hc-it-s2"), refused(/not part of this college/));
  await assert.rejects(() => college.setCourseSectionTeacher(hod(), { ...mechanics, teacherId: TA }), refused(/not part of this college/));
  assert.equal(await prisma.enrollment.count({ where: { cohortId: ids.mecA } }), 0);

  // Another college's administrator reaches none of it either.
  const other = actor(B_ADMIN, "COLLEGE_ADMIN", B);
  assert.equal(await college.searchStudentsForSection(other, physicsA(), "CSE"), null);
  await assert.rejects(() => college.addStudentToSection(other, physicsA(), "hc-it-s2"), refused(/not part of this college/));
});

test("the administrator's own way in is unchanged: the semester page, and the same section tools", { skip: SKIP }, async () => {
  const course = await college.createCourse(admin(), { departmentId: ids.cse, semesterId: ids.s3, code: "MAT301", name: "Mathematics" });
  assert.deepEqual([course.departmentId, course.semesterId], [ids.cse, ids.s3]);
  const [sectionId] = (await college.addCourseSections(admin(), { departmentId: ids.cse, semesterId: ids.s3, courseId: course.courseId, sessionId: NOW, sections: [{ name: "A", teacherId: TM }] })).sectionIds;
  const mathsA = { departmentId: ids.cse, semesterId: ids.s3, courseId: course.courseId, sectionId };
  assert.equal((await college.addStudentToSection(admin(), mathsA, "hc-it-s2")).name, "Rahul Singh");
  const search = await college.searchStudentsForSection(admin(), mathsA, "Rahul");
  assert.deepEqual(search?.results.map((row) => [row.studentCode, row.inSection]), [["CSE002", true]]);
  const view = await college.getSectionStudent(admin(), mathsA, "hc-it-s2");
  assert.deepEqual(view?.sections.map((row) => row.groupName), ["MAT301-A", "PHY401-A"]);
});
