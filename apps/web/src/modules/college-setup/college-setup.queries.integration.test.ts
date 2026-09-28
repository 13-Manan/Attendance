import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { SYSTEM_ROLES, type PermissionKey } from "../authorization/permissions.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * How many statements a college page's read issues — counted at the database
 * client, for a small college and for one many times larger. They must be the
 * same number: a page that read one more query per department, course or
 * section would pass every other test and fall over at a real college.
 *
 * The counting client is installed as the process's Prisma client before any
 * module that reads it is loaded (see `lib/prisma.ts`), so every read below —
 * the service's, and its repository's — goes through it.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const Q = "cq-inst";
const SESSION = "cq-now";
const ADMIN = "cq-admin";

let statements = 0;
const client = SKIP ? null : new PrismaClient({ log: [{ emit: "event", level: "query" }] });
if (client) {
  client.$on("query", () => {
    statements += 1;
  });
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = client;
}

type Service = typeof import("./service.ts");
let service: Service;

const admin: SessionUser = {
  userId: ADMIN,
  email: `${ADMIN}@test.local`,
  name: ADMIN,
  institutionId: Q,
  campusId: null,
  roles: [
    {
      key: "COLLEGE_ADMIN",
      name: "College Admin",
      institutionId: null,
      campusId: null,
      permissions: [...SYSTEM_ROLES.find((role) => role.key === "COLLEGE_ADMIN")!.permissions] as PermissionKey[],
    },
  ],
};

async function cleanup(db: PrismaClient) {
  const where = { institutionId: Q };
  await db.auditLog.deleteMany({ where });
  await db.cohortSubject.deleteMany({ where: { cohort: where } });
  await db.cohortFaculty.deleteMany({ where: { cohort: where } });
  await db.enrollment.deleteMany({ where });
  await db.student.deleteMany({ where });
  await db.cohort.deleteMany({ where });
  await db.subject.deleteMany({ where });
  await db.user.updateMany({ where, data: { departmentId: null } });
  for (const kind of ["SECTION", "COURSE", "SEMESTER", "DEPARTMENT"] as const) {
    await db.academicUnit.deleteMany({ where: { ...where, kind } });
  }
  await db.academicSession.deleteMany({ where });
  await db.user.deleteMany({ where });
  await db.institution.deleteMany({ where: { id: Q } });
}

/**
 * Adds departments, each with semesters, courses and sections — every section
 * with a teacher and students — straight into the tables the service reads.
 */
async function grow(db: PrismaClient, prefix: string, size: { departments: number; semesters: number; courses: number; sections: number; students: number }) {
  const faculty = await db.role.findFirstOrThrow({ where: { key: "FACULTY", institutionId: null } });
  for (let d = 0; d < size.departments; d += 1) {
    const departmentId = `${prefix}-d${d}`;
    await db.academicUnit.create({ data: { id: departmentId, institutionId: Q, kind: "DEPARTMENT", name: `${prefix} Department ${d}`, code: `${prefix}D${d}`.toUpperCase(), metadata: {} } });
    const teacherId = `${prefix}-t${d}`;
    await db.user.create({
      data: {
        id: teacherId,
        institutionId: Q,
        email: `${teacherId}@test.local`,
        name: teacherId,
        passwordHash: "x",
        departmentId,
        roleAssignments: { create: { roleId: faculty.id, institutionId: Q } },
      },
    });
    for (let s = 0; s < size.semesters; s += 1) {
      const semesterId = `${departmentId}-s${s}`;
      await db.academicUnit.create({ data: { id: semesterId, institutionId: Q, kind: "SEMESTER", name: `Semester ${s + 1}`, sortOrder: s + 1, parentId: departmentId } });
      for (let c = 0; c < size.courses; c += 1) {
        const courseId = `${semesterId}-c${c}`;
        const code = `${prefix}${d}${s}${c}`.toUpperCase();
        await db.academicUnit.create({ data: { id: courseId, institutionId: Q, kind: "COURSE", name: `Course ${code}`, code, parentId: semesterId } });
        const subject = await db.subject.create({ data: { institutionId: Q, code, name: `Course ${code}` } });
        for (let x = 0; x < size.sections; x += 1) {
          const sectionUnit = `${courseId}-x${x}`;
          await db.academicUnit.create({ data: { id: sectionUnit, institutionId: Q, kind: "SECTION", name: String.fromCharCode(65 + x), parentId: courseId } });
          const cohortId = `${sectionUnit}-g`;
          await db.cohort.create({ data: { id: cohortId, institutionId: Q, academicUnitId: sectionUnit, academicSessionId: SESSION, name: `${code}-${String.fromCharCode(65 + x)}` } });
          await db.cohortSubject.create({ data: { cohortId, subjectId: subject.id, facultyId: teacherId } });
          await db.cohortFaculty.create({ data: { cohortId, userId: teacherId, role: "PRIMARY" } });
          await db.student.createMany({
            data: Array.from({ length: size.students }, (_, n) => ({
              id: `${cohortId}-st${n}`,
              institutionId: Q,
              studentCode: `${cohortId}-st${n}`.toUpperCase(),
              firstName: "S",
              lastName: String(n),
            })),
          });
          await db.enrollment.createMany({
            data: Array.from({ length: size.students }, (_, n) => ({ institutionId: Q, studentId: `${cohortId}-st${n}`, cohortId })),
          });
        }
      }
    }
  }
}

/**
 * Statements one read issues. Prisma delivers its query events a moment after
 * the results, so under load the last few can land after the read resolves;
 * the count is taken once it has stopped moving, or they would be charged to
 * whichever page is measured next.
 */
async function measure(read: () => Promise<unknown>): Promise<number> {
  statements = 0;
  await read();
  let seen = -1;
  while (seen !== statements) {
    seen = statements;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return statements;
}

/** Every page's read, keyed by what the page is, for department 0 of the given prefix. */
function reads(prefix: string) {
  const department = `${prefix}-d0`;
  const semester = `${department}-s0`;
  const course = `${semester}-c0`;
  const section = `${course}-x0-g`;
  const sectionIds = { departmentId: department, semesterId: semester, courseId: course, sectionId: section };
  const student = `${section}-st0`;
  return {
    departments: () => service.getDepartmentsOverview(admin),
    department: () => service.getDepartmentDetail(admin, department),
    semester: () => service.getSemesterDetail(admin, department, semester),
    course: () => service.getCourseDetail(admin, department, semester, course),
    section: () => service.getCourseSectionDetail(admin, sectionIds),
    courses: () => service.getCoursesIndex(admin),
    students: () => service.getDepartmentStudents(admin, department),
    faculty: () => service.getDepartmentFaculty(admin, department),
    semesters: () => service.getSemestersIndex(admin),
    // The add-student page: the department's suggestions, a search that
    // matches more than it lists, and an exact student ID.
    addSuggestions: () => service.searchStudentsForSection(admin, sectionIds, ""),
    addSearch: () => service.searchStudentsForSection(admin, sectionIds, "st"),
    addById: () => service.searchStudentsForSection(admin, sectionIds, student.toUpperCase(), student),
    // The department's people pages.
    student: () => service.getDepartmentStudent(admin, department, student),
    studentPick: () => service.getDepartmentStudentPick(admin, department, student),
    departmentSearch: () => service.searchStudentsForDepartment(admin, department, "st"),
    facultyMember: () => service.getDepartmentFacultyMember(admin, department, `${prefix}-t0`),
  };
}

before(async () => {
  if (SKIP || !client) return;
  service = await import("./service.ts");
  await cleanup(client);
  await client.institution.create({ data: { id: Q, name: "Query College", type: "COLLEGE", settings: { attendanceMode: "SUBJECT_WISE" } } });
  await client.academicSession.create({
    data: { id: SESSION, institutionId: Q, name: "2026-27", startDate: new Date("2026-07-01Z"), endDate: new Date("2027-05-31Z"), isCurrent: true },
  });
  const role = await client.role.findFirstOrThrow({ where: { key: "COLLEGE_ADMIN", institutionId: null } });
  await client.user.create({
    data: { id: ADMIN, institutionId: Q, email: `${ADMIN}@test.local`, name: ADMIN, passwordHash: "x", roleAssignments: { create: { roleId: role.id, institutionId: Q } } },
  });
});

after(async () => {
  if (SKIP || !client) return;
  await cleanup(client);
  await client.$disconnect();
});

test("every college page reads the same number of statements for a small college and a large one", { skip: SKIP }, async (t) => {
  // Small, but with two of everything that a page might skip a read for when
  // there is only one.
  await grow(client!, "sm", { departments: 1, semesters: 1, courses: 2, sections: 2, students: 2 });
  const small: Record<string, number> = {};
  for (const [page, read] of Object.entries(reads("sm"))) small[page] = await measure(read);

  // Department 0 of the large set is itself four times wider at every level,
  // and six more departments sit beside it.
  await grow(client!, "lg", { departments: 6, semesters: 4, courses: 4, sections: 3, students: 5 });
  const large: Record<string, number> = {};
  for (const [page, read] of Object.entries(reads("lg"))) large[page] = await measure(read);

  t.diagnostic(`statements per page: ${JSON.stringify(large)}`);
  assert.deepEqual(large, small, "a page read more statements for a larger college");
  for (const [page, count] of Object.entries(large)) {
    assert.ok(count <= 20, `${page} issued ${count} statements`);
  }
});
