import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findRoleForKey } from "@/modules/faculty/directory-repository";
import { DEPARTMENT_FACULTY_ROLE_KEY } from "@/modules/faculty/directory-types";
import { TEACHING_PERMISSION } from "@/modules/school-setup/repository";
import { ELIGIBLE_TEMPLATE_WHERE } from "@/modules/recognition-results/eligibility";
import type { SessionChoice } from "./types";

/**
 * Reads and writes for college setup.
 *
 * Every query names the institution, so an id taken from another college's
 * URL finds nothing rather than something. Pages read a bounded number of
 * queries however large the college is: the structure (departments,
 * semesters, courses, section names) is one read, a session's sections are
 * one read, and counts are aggregated in the database or over rows already
 * loaded — never one query per department, course or section.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

export { TEACHING_PERMISSION };

/** The role a head of department holds. Its permissions come from `SYSTEM_ROLES`. */
export const HOD_ROLE_KEY = "HOD";

/** The staff roles a head of department's own role replaces, and the one it gives back. */
export const STAFF_ROLE_KEYS = ["FACULTY", "CLASS_TEACHER", "ATTENDANCE_OPERATOR"] as const;
export const RESTORED_ROLE_KEY = "FACULTY";

/**
 * The role of a teacher a head of department adds: it teaches its own
 * department's sections and reads nothing college-wide. Not among the roles a
 * head's role replaces — such an account is never made a head.
 */
export { DEPARTMENT_FACULTY_ROLE_KEY };

/**
 * Serialises structural changes to one college's academic setup — the
 * check-then-write that keeps two administrators from both creating "CSE", or
 * both making someone head, in the same instant. Keyed on the institution, so
 * it never blocks a different college, and released with the transaction.
 */
export async function lockCollegeSetup(tx: Prisma.TransactionClient, institutionId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`college-setup:${institutionId}`}))`;
}

export async function getInstitutionName(institutionId: string): Promise<string> {
  const row = await prisma.institution.findUnique({ where: { id: institutionId }, select: { name: true } });
  return row?.name ?? "";
}

const SESSION_SELECT = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  isCurrent: true,
  isActive: true,
} satisfies Prisma.AcademicSessionSelect;

export async function listSessions(institutionId: string): Promise<SessionChoice[]> {
  return prisma.academicSession.findMany({
    where: { institutionId },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
    select: SESSION_SELECT,
  });
}

export async function getSession(db: Db, institutionId: string, id: string): Promise<SessionChoice | null> {
  return db.academicSession.findFirst({ where: { id, institutionId }, select: SESSION_SELECT });
}

// ---------------------------------------------------------------------------
// The structure: departments, semesters, courses and section names
// ---------------------------------------------------------------------------

const UNIT_SELECT = {
  id: true,
  kind: true,
  name: true,
  code: true,
  parentId: true,
  sortOrder: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AcademicUnitSelect;

export type UnitRow = Prisma.AcademicUnitGetPayload<{ select: typeof UNIT_SELECT }>;

/**
 * The college's whole academic tree, in one read. Bounded by the size of the
 * college's structure — departments, their semesters, courses and section
 * names — which is what every college page is a view of. A section name is
 * reused session on session, so this does not grow with the years.
 */
export async function listCollegeUnits(db: Db, institutionId: string): Promise<UnitRow[]> {
  return db.academicUnit.findMany({
    where: { institutionId, kind: { in: ["DEPARTMENT", "SEMESTER", "COURSE", "SECTION"] } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: UNIT_SELECT,
  });
}

export async function getUnit(
  db: Db,
  institutionId: string,
  id: string,
  kind: "DEPARTMENT" | "SEMESTER" | "COURSE" | "SECTION",
): Promise<UnitRow | null> {
  return db.academicUnit.findFirst({ where: { id, institutionId, kind }, select: UNIT_SELECT });
}

/** The departments whose metadata names this person as head. Normally zero or one. */
export async function listDepartmentsHeadedBy(db: Db, institutionId: string, userId: string) {
  return db.academicUnit.findMany({
    where: { institutionId, kind: "DEPARTMENT", metadata: { path: ["headUserId"], equals: userId } },
    select: { id: true, name: true },
  });
}

// ---------------------------------------------------------------------------
// Sections in a session
// ---------------------------------------------------------------------------

const GROUP_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  academicSessionId: true,
  academicUnitId: true,
  facultyLinks: {
    orderBy: { id: "asc" },
    select: { id: true, role: true, user: { select: { id: true, name: true, status: true } } },
  },
  subjects: {
    orderBy: { createdAt: "asc" },
    select: { id: true, subjectId: true, facultyId: true, subject: { select: { code: true } } },
  },
  _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
} satisfies Prisma.CohortSelect;

export type GroupRow = Prisma.CohortGetPayload<{ select: typeof GROUP_SELECT }>;

/** The groups of one session that hang off any of these units, with their teachers and counts. */
export async function listSessionGroups(
  db: Db,
  institutionId: string,
  sessionId: string,
  unitIds: readonly string[],
): Promise<GroupRow[]> {
  if (unitIds.length === 0) return [];
  return db.cohort.findMany({
    where: { institutionId, academicSessionId: sessionId, academicUnitId: { in: [...unitIds] } },
    orderBy: [{ createdAt: "asc" }],
    select: GROUP_SELECT,
  });
}

export async function getGroup(db: Db, institutionId: string, id: string): Promise<GroupRow | null> {
  return db.cohort.findFirst({ where: { id, institutionId }, select: GROUP_SELECT });
}

/**
 * (student, section) pairs for students currently in any of these sections —
 * what distinct-student counts are taken over. One read for a whole page.
 */
export async function listActivePlacements(
  db: Db,
  cohortIds: readonly string[],
): Promise<{ studentId: string; cohortId: string }[]> {
  if (cohortIds.length === 0) return [];
  return db.enrollment.findMany({
    where: { cohortId: { in: [...cohortIds] }, status: "ACTIVE", student: { status: "ACTIVE" } },
    select: { studentId: true, cohortId: true },
  });
}

/**
 * Distinct students per department in one session, counted in the database.
 *
 * A section's group hangs off a SECTION unit whose ancestors are the course,
 * the semester and the department; a group set up on the older screens may
 * hang one or two levels higher. The department is the first ancestor, at any
 * of those depths, whose kind says DEPARTMENT.
 */
export async function countStudentsByDepartment(
  institutionId: string,
  sessionId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ departmentId: string; students: bigint }[]>`
    SELECT dept."departmentId", count(DISTINCT e."studentId") AS students
    FROM "Enrollment" e
    JOIN "Cohort" c ON c.id = e."cohortId"
    JOIN "Student" st ON st.id = e."studentId" AND st.status = 'ACTIVE'
    JOIN "AcademicUnit" u1 ON u1.id = c."academicUnitId"
    LEFT JOIN "AcademicUnit" u2 ON u2.id = u1."parentId"
    LEFT JOIN "AcademicUnit" u3 ON u3.id = u2."parentId"
    LEFT JOIN "AcademicUnit" u4 ON u4.id = u3."parentId"
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        CASE WHEN u1.kind = 'DEPARTMENT' THEN u1.id END,
        CASE WHEN u2.kind = 'DEPARTMENT' THEN u2.id END,
        CASE WHEN u3.kind = 'DEPARTMENT' THEN u3.id END,
        CASE WHEN u4.kind = 'DEPARTMENT' THEN u4.id END
      ) AS "departmentId"
    ) dept
    WHERE c."institutionId" = ${institutionId}
      AND c."academicSessionId" = ${sessionId}
      AND e.status = 'ACTIVE'
      AND dept."departmentId" IS NOT NULL
    GROUP BY dept."departmentId"
  `;
  return new Map(rows.map((row) => [row.departmentId, Number(row.students)]));
}

/** Sections per department in one session, counted from the same ancestry. */
export async function countSectionsByUnit(
  institutionId: string,
  sessionId: string,
): Promise<{ academicUnitId: string; sections: number }[]> {
  const rows = await prisma.cohort.groupBy({
    by: ["academicUnitId"],
    where: { institutionId, academicSessionId: sessionId },
    _count: { _all: true },
  });
  return rows.map((row) => ({ academicUnitId: row.academicUnitId, sections: row._count._all }));
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Staff per department, counted in the database. Students never carry a department. */
export async function countFacultyByDepartment(institutionId: string): Promise<Map<string, number>> {
  const rows = await prisma.user.groupBy({
    by: ["departmentId"],
    where: { institutionId, departmentId: { not: null }, studentProfile: { is: null } },
    _count: { _all: true },
  });
  return new Map(
    rows.filter((row) => row.departmentId !== null).map((row) => [row.departmentId!, row._count._all]),
  );
}

const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  employeeCode: true,
  status: true,
  lastLoginAt: true,
  departmentId: true,
  roleAssignments: { select: { id: true, institutionId: true, role: { select: { id: true, key: true } } } },
} satisfies Prisma.UserSelect;

export type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

export async function listPeople(db: Db, institutionId: string, ids: readonly string[]): Promise<PersonRow[]> {
  if (ids.length === 0) return [];
  return db.user.findMany({ where: { institutionId, id: { in: [...ids] } }, select: PERSON_SELECT });
}

export async function getPerson(db: Db, institutionId: string, id: string): Promise<PersonRow | null> {
  return db.user.findFirst({ where: { institutionId, id }, select: PERSON_SELECT });
}

/** A teacher with their department and roles — which say whether they are a head's department faculty. */
const TEACHER_SELECT = {
  id: true,
  name: true,
  email: true,
  departmentId: true,
  roleAssignments: { select: { role: { select: { key: true } } } },
} satisfies Prisma.UserSelect;

export type TeacherRow = Prisma.UserGetPayload<{ select: typeof TEACHER_SELECT }>;

/**
 * Active staff at this college whose role lets them confirm a register — the
 * school screens' rule (`TEACHING_PERMISSION`), with the department attached —
 * and who are not students. `departmentId` narrows to one department.
 */
export async function listEligibleTeachers(db: Db, institutionId: string, departmentId?: string): Promise<TeacherRow[]> {
  return db.user.findMany({
    where: { ...eligibleTeacherWhere(institutionId), ...(departmentId ? { departmentId } : {}) },
    orderBy: [{ name: "asc" }],
    select: TEACHER_SELECT,
  });
}

export async function findEligibleTeacher(db: Db, institutionId: string, userId: string): Promise<TeacherRow | null> {
  return db.user.findFirst({
    where: { id: userId, ...eligibleTeacherWhere(institutionId) },
    select: TEACHER_SELECT,
  });
}

function eligibleTeacherWhere(institutionId: string): Prisma.UserWhereInput {
  return {
    institutionId,
    status: "ACTIVE",
    roleAssignments: {
      some: {
        institutionId,
        role: { permissions: { some: { permission: TEACHING_PERMISSION } } },
      },
      none: { role: { key: "STUDENT" } },
    },
    studentProfile: { is: null },
  };
}

/**
 * Staff who could be made a department's head: able to teach, active, not a
 * student, and holding no administrator permission — an administrator
 * already runs every department, and a head's role would sit oddly beside it.
 * Nor a teacher a head added to their department: that account's password
 * was in a head's hands, so it is never made a head itself.
 */
export async function listHeadCandidates(db: Db, institutionId: string) {
  return db.user.findMany({
    where: {
      ...eligibleTeacherWhere(institutionId),
      NOT: {
        roleAssignments: {
          some: {
            OR: [
              { role: { permissions: { some: { permission: "academicStructure.manage" } } } },
              { role: { key: DEPARTMENT_FACULTY_ROLE_KEY } },
            ],
          },
        },
      },
    },
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, email: true, departmentId: true },
  });
}

/**
 * Of these people, who holds a role that administers the whole college — one
 * read for a whole faculty list. Such an account is the Director's to manage,
 * never a head of department's, even when it is in the department.
 */
export async function administratorIds(db: Db, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.userRoleAssignment.findMany({
    where: {
      userId: { in: [...userIds] },
      role: { permissions: { some: { permission: "academicStructure.manage" } } },
    },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

/**
 * Who last stopped each of these accounts, from the audit trail — one read for
 * a whole list. A head of department restores only an account they stopped
 * themselves; one the Director stopped stays stopped until the Director says.
 */
export async function lastDeactivatorsOf(
  db: Db,
  institutionId: string,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.auditLog.findMany({
    where: { institutionId, entityType: "User", action: "user.deactivated", entityId: { in: [...userIds] } },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, actorUserId: true },
  });
  const last = new Map<string, string | null>();
  for (const row of rows) if (!last.has(row.entityId)) last.set(row.entityId, row.actorUserId);
  return last;
}

/** Whether this person holds any role that administers the whole college. */
export async function holdsAdministratorRole(db: Db, userId: string): Promise<boolean> {
  const count = await db.userRoleAssignment.count({
    where: { userId, role: { permissions: { some: { permission: "academicStructure.manage" } } } },
  });
  return count > 0;
}

/**
 * What the Faculty page's account service would grant for this role key —
 * the very role it picks (`findRoleForKey`), read here so a check of what is
 * granted is a check of what will be. Null if it is not set up yet.
 */
export async function grantedRolePermissions(institutionId: string, key: string): Promise<string[] | null> {
  const role = await findRoleForKey(institutionId, key);
  if (!role) return null;
  const rows = await prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permission: true } });
  return rows.map((row) => row.permission);
}

export async function findRoleByKey(db: Db, institutionId: string, key: string) {
  return db.role.findFirst({
    where: { key, OR: [{ institutionId }, { institutionId: null }] },
    // An institution's own role wins over the platform-wide seeded one, as on the Faculty page.
    orderBy: { institutionId: "desc" },
    select: { id: true, key: true },
  });
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

const STUDENT_SELECT = {
  id: true,
  studentCode: true,
  firstName: true,
  lastName: true,
  admissionNumber: true,
  status: true,
  userId: true,
} satisfies Prisma.StudentSelect;

export type StudentRow = Prisma.StudentGetPayload<{ select: typeof STUDENT_SELECT }>;

/** Current students of these sections, with the section each row came from. */
export async function listSectionStudents(db: Db, cohortIds: readonly string[]) {
  if (cohortIds.length === 0) return [];
  return db.enrollment.findMany({
    where: { cohortId: { in: [...cohortIds] }, status: "ACTIVE", student: { status: "ACTIVE" } },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
    select: { cohortId: true, student: { select: STUDENT_SELECT } },
  });
}

/** How many of the rest of its department's students a section's add page reads to suggest from. */
const DEPARTMENT_CHOICE_LIMIT = 2000;

/**
 * Students on roll in any of a session's groups hanging off these units who
 * are not in one group — the section being added to — each once. One read,
 * whatever the department's size; what the add-student page suggests before
 * anything is searched.
 */
export async function listStudentsInGroupsExcept(
  db: Db,
  institutionId: string,
  sessionId: string,
  unitIds: readonly string[],
  exceptGroupId: string,
) {
  if (unitIds.length === 0) return [];
  const rows = await db.enrollment.findMany({
    where: {
      status: "ACTIVE",
      student: { status: "ACTIVE", enrollments: { none: { cohortId: exceptGroupId, status: "ACTIVE" } } },
      cohort: {
        institutionId,
        academicSessionId: sessionId,
        academicUnitId: { in: [...unitIds] },
        id: { not: exceptGroupId },
      },
    },
    distinct: ["studentId"],
    orderBy: { studentId: "asc" },
    take: DEPARTMENT_CHOICE_LIMIT,
    select: { student: { select: STUDENT_SELECT } },
  });
  return rows.map((row) => row.student);
}

/** Of these students, which have a face template the running recognition would compare. */
export async function listStudentIdsWithFaces(db: Db, studentIds: readonly string[]): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await db.faceEmbedding.findMany({
    where: { studentId: { in: [...studentIds] }, ...ELIGIBLE_TEMPLATE_WHERE },
    distinct: ["studentId"],
    select: { studentId: true },
  });
  return new Set(rows.map((row) => row.studentId));
}

/** Students of this college with these codes, any letter case. */
export async function findStudentsByCodes(db: Db, institutionId: string, codes: readonly string[]) {
  if (codes.length === 0) return [];
  return db.student.findMany({
    where: {
      institutionId,
      OR: codes.map((code) => ({ studentCode: { equals: code, mode: "insensitive" as const } })),
    },
    select: STUDENT_SELECT,
  });
}

/**
 * Students of this college matching every term, each term anywhere in the
 * student ID, either name or the admission number. On-roll students first,
 * then by name. `take` bounds it: a search is narrowed by typing more, never
 * paged through.
 */
export async function searchStudents(
  db: Db,
  institutionId: string,
  terms: readonly string[],
  take: number,
): Promise<StudentRow[]> {
  if (terms.length === 0) return [];
  return db.student.findMany({
    where: {
      institutionId,
      AND: terms.map((term) => ({
        OR: [
          { studentCode: { contains: term, mode: "insensitive" as const } },
          { firstName: { contains: term, mode: "insensitive" as const } },
          { lastName: { contains: term, mode: "insensitive" as const } },
          { admissionNumber: { contains: term, mode: "insensitive" as const } },
        ],
      })),
    },
    orderBy: [{ status: "asc" }, { lastName: "asc" }, { firstName: "asc" }, { studentCode: "asc" }],
    take,
    select: STUDENT_SELECT,
  });
}

/** One student of this college, or null — never another college's. */
export async function getStudent(db: Db, institutionId: string, studentId: string): Promise<StudentRow | null> {
  return db.student.findFirst({ where: { id: studentId, institutionId }, select: STUDENT_SELECT });
}

/** Which of these students are currently in this section. One read for a whole list. */
export async function studentsCurrentlyIn(
  db: Db,
  cohortId: string,
  studentIds: readonly string[],
): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await db.enrollment.findMany({
    where: { cohortId, status: "ACTIVE", studentId: { in: [...studentIds] } },
    select: { studentId: true },
  });
  return new Set(rows.map((row) => row.studentId));
}

/** One student of this college with the details their department page shows — contact fields included. */
export async function getStudentDetail(db: Db, institutionId: string, studentId: string) {
  return db.student.findFirst({
    where: { id: studentId, institutionId },
    select: { ...STUDENT_SELECT, email: true, phone: true, user: { select: { status: true } } },
  });
}

/** Whether each of these sign-in accounts is switched on. One read for a whole list. */
export async function loginStatusesOf(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, status: true } });
  return new Map(rows.map((row) => [row.id, row.status]));
}

/**
 * How many face samples a student has in use, and when the latest was taken.
 * A count and a date — no template, no vector, no image.
 */
export async function faceSummaryOf(db: Db, studentId: string) {
  const row = await db.faceEmbedding.aggregate({
    where: { studentId, isActive: true },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  return { active: row._count._all, lastEnrolledAt: row._max.createdAt };
}

/**
 * Whether a student is currently in any group hanging off these units, in any
 * session — what makes them one of a department's students — or, with
 * `openSessionsOnly`, in a session that has not been archived: what lets their
 * face be enrolled from the department.
 */
export async function hasPlacementIn(
  db: Db,
  institutionId: string,
  studentId: string,
  unitIds: readonly string[],
  options: { openSessionsOnly?: boolean } = {},
): Promise<boolean> {
  if (unitIds.length === 0) return false;
  const row = await db.enrollment.findFirst({
    where: {
      studentId,
      status: "ACTIVE",
      cohort: {
        institutionId,
        academicUnitId: { in: [...unitIds] },
        ...(options.openSessionsOnly ? { academicSession: { isActive: true } } : {}),
      },
    },
    select: { cohortId: true },
  });
  return row !== null;
}

/** (student, section) pairs for these students currently in any of these sections. One read. */
export async function placementsOf(
  db: Db,
  studentIds: readonly string[],
  cohortIds: readonly string[],
): Promise<{ studentId: string; cohortId: string }[]> {
  if (studentIds.length === 0 || cohortIds.length === 0) return [];
  return db.enrollment.findMany({
    where: { studentId: { in: [...studentIds] }, cohortId: { in: [...cohortIds] }, status: "ACTIVE" },
    select: { studentId: true, cohortId: true },
  });
}

/**
 * A course's groups in one session — its sections, and an older group hung
 * straight off the course — with what each is called. What "another section
 * of the same course" is checked against.
 */
export async function listCourseGroups(db: Db, institutionId: string, sessionId: string, courseId: string) {
  return db.cohort.findMany({
    where: {
      institutionId,
      academicSessionId: sessionId,
      OR: [{ academicUnitId: courseId }, { academicUnit: { parentId: courseId, kind: "SECTION" } }],
    },
    select: { id: true, name: true, academicUnit: { select: { kind: true, name: true } } },
  });
}

export async function getEnrollmentStatus(db: Db, studentId: string, cohortId: string) {
  return db.enrollment.findUnique({
    where: { studentId_cohortId: { studentId, cohortId } },
    select: { status: true },
  });
}

/**
 * Everything that would stop a course section being removed. Enrolments of
 * any status count: a student moved out still has the section in their
 * history, and their old registers point at it.
 */
export async function countSectionRemovalBlockers(
  db: Db,
  institutionId: string,
  groupId: string,
  courseSubjectId: string | null,
) {
  const [students, currentStudents, registers, subjectEnrollments, subjects, externalLinks] =
    await Promise.all([
      db.enrollment.count({ where: { cohortId: groupId } }),
      db.enrollment.count({ where: { cohortId: groupId, status: "ACTIVE" } }),
      db.attendanceSession.count({ where: { cohortId: groupId } }),
      db.studentSubjectEnrollment.count({ where: { cohortSubject: { cohortId: groupId } } }),
      db.cohortSubject.count({
        where: { cohortId: groupId, ...(courseSubjectId ? { subjectId: { not: courseSubjectId } } : {}) },
      }),
      db.externalIdentity.count({ where: { institutionId, entityType: "COHORT", internalId: groupId } }),
    ]);
  return { students, currentStudents, registers, subjectEnrollments, otherSubjects: subjects, externalLinks };
}

/** Whether a unit is still referenced by anything — a group, a child unit, or a member of staff. */
export async function unitStillInUse(db: Db, unitId: string): Promise<boolean> {
  const [groups, children, staff] = await Promise.all([
    db.cohort.count({ where: { academicUnitId: unitId } }),
    db.academicUnit.count({ where: { parentId: unitId } }),
    db.user.count({ where: { departmentId: unitId } }),
  ]);
  return groups + children + staff > 0;
}

export async function findSubjectByCode(db: Db, institutionId: string, code: string) {
  return db.subject.findFirst({
    where: { institutionId, code: { equals: code, mode: "insensitive" } },
    select: { id: true, code: true, name: true },
  });
}
