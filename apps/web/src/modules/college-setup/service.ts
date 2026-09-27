import { Prisma, type Student } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { pickByStudentCode } from "@/modules/auth-tenancy/student-login-policy";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { enrollStudentInCohortForRequest, unenrollStudentFromCohortForRequest } from "@/modules/enrollment/service";
import {
  deactivateFaculty,
  inviteFaculty,
  reactivateFaculty,
  resetFacultyPassword,
  type InvitedFaculty,
} from "@/modules/faculty/directory-service";
import type { IssuedPassword } from "@/modules/faculty/directory-types";
import { createStudentForRequest, type StudentInput } from "@/modules/students/directory-service";
import * as repo from "./repository";
import {
  courseStatus,
  nameKey,
  parseStudentCodes,
  pickSession,
  sameName,
  sameSectionName,
  sectionGroupName,
  sectionLabel,
  sectionRemovalCheck,
  validateCourseCode,
  validateCourseName,
  validateDepartmentCode,
  validateDepartmentName,
  validateSectionName,
  validateSectionNames,
  validateSemesterName,
  validateSemesterNumber,
} from "./policy";
import { delegate, departmentInScope, requireCollegeAdmin, resolveCollegeScope } from "./scope";
import {
  CollegeSetupError,
  MAX_SECTIONS,
  MAX_STUDENT_CODES_AT_ONCE,
  type CollegeHome,
  type CollegeScope,
  type CourseDetail,
  type CourseRow,
  type CourseSectionDetail,
  type DepartmentDetail,
  type DepartmentFaculty,
  type DepartmentFacultyRow,
  type DepartmentStudentRow,
  type DepartmentStudents,
  type DepartmentsOverview,
  type HeadOfDepartment,
  type SectionPlacement,
  type SemesterDetail,
  type SemesterRow,
  type SessionChoice,
  type StaffChoice,
} from "./types";
import {
  buildTree,
  courseIdOfGroup,
  courseSubjectLink,
  coursesOf,
  currentSemesterIdOf,
  departmentCourses,
  distinctStudents,
  groupsByCourse,
  headUserIdOf,
  sectionNameOfGroup,
  sectionUnitIds,
  semestersOf,
  sortedSectionRows,
  toCourseRef,
  toDepartmentRef,
  toSemesterRef,
  withMetadata,
  childrenOf,
  type Tree,
} from "./view";

/**
 * College academic setup: Academic session → Departments → Head of
 * Department → Semesters → Courses → Sections → Teachers → Students.
 *
 * ## What it writes, and what it does not
 *
 * Only rows the schema already has — see `types.ts`. No migration. A course
 * section set up here is the same group every other screen reads: the
 * teacher's Attendance page, the register, the recognition candidate list,
 * the student's portal and the reports all see it without knowing this module
 * exists. Attendance itself — capture, review, confirmation, correction — is
 * not touched: a section is a class group with one subject, which is what a
 * subject-wise register already is.
 *
 * ## Who may do what
 *
 * `scope.ts` decides. An administrator works on every department; a head of
 * department on theirs, and every id in a request — department, semester,
 * course, section, teacher, student — is checked to sit inside it, through
 * its parents, before anything is read or written. An id from another
 * department or another college reads as "not here", never as "not yours".
 * Creating departments, naming their heads and adding staff accounts are
 * administrator-only.
 *
 * ## Students
 *
 * Adding and removing students goes through the student and enrolment
 * services — the only writers of those tables — with their validation and
 * audit rows. See `delegate` in `scope.ts` for how a head of department, who
 * has no institution-wide student permission, reaches them for one section.
 *
 * ## Concurrency
 *
 * Structural writes run in one transaction behind a per-college advisory lock
 * (`repo.lockCollegeSetup`), so duplicate checks and the writes they guard
 * cannot interleave. Removals also rely on RESTRICT foreign keys: if a student
 * is enrolled between the check and the delete, Postgres refuses the delete.
 */

const TX_OPTIONS = { timeout: 20_000 };
type Tx = Prisma.TransactionClient;

/** What an administrator needs, beyond reading the structure, to change it. */
const STRUCTURE = ["cohort.manage"] as const;

function audit(
  tx: Tx | typeof prisma,
  actor: SessionUser,
  institutionId: string,
  input: {
    action: Parameters<typeof recordAuditLog>[0]["action"];
    entityType: string;
    entityId: string;
    beforeJson?: unknown;
    afterJson?: unknown;
  },
) {
  return recordAuditLog({ ...input, institutionId, actorUserId: actor.userId }, tx);
}

function isForeignKeyRefusal(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

const NOT_HERE = {
  department: "That department is not part of this college.",
  semester: "That semester is not part of this department.",
  course: "That course is not part of this semester.",
  section: "That section is not part of this course.",
};

// ---------------------------------------------------------------------------
// Resolving a request's ids through their parents
// ---------------------------------------------------------------------------

interface Chain {
  department: repo.UnitRow;
  semester?: repo.UnitRow;
  course?: repo.UnitRow;
}

/**
 * Loads the named units and checks each one's parent is the one before it,
 * and that the department is inside the scope. Every write starts here.
 */
async function requireChain(
  db: repo.Db,
  scope: CollegeScope,
  ids: { departmentId: string; semesterId?: string; courseId?: string },
): Promise<Chain> {
  const department = await repo.getUnit(db, scope.institutionId, ids.departmentId, "DEPARTMENT");
  if (!department || !departmentInScope(scope, department.id)) {
    throw new CollegeSetupError(NOT_HERE.department);
  }
  if (ids.semesterId === undefined) return { department };

  const semester = await repo.getUnit(db, scope.institutionId, ids.semesterId, "SEMESTER");
  if (!semester || semester.parentId !== department.id) throw new CollegeSetupError(NOT_HERE.semester);
  if (ids.courseId === undefined) return { department, semester };

  const course = await repo.getUnit(db, scope.institutionId, ids.courseId, "COURSE");
  if (!course || course.parentId !== semester.id) throw new CollegeSetupError(NOT_HERE.course);
  return { department, semester, course };
}

/** A section group of this course, with the session it belongs to. */
async function requireSectionOf(
  db: repo.Db,
  scope: CollegeScope,
  course: repo.UnitRow,
  sectionId: string,
): Promise<{ group: repo.GroupRow; session: SessionChoice; sectionUnit: repo.UnitRow | null }> {
  const group = await repo.getGroup(db, scope.institutionId, sectionId);
  if (!group) throw new CollegeSetupError(NOT_HERE.section);
  let sectionUnit: repo.UnitRow | null = null;
  if (group.academicUnitId !== course.id) {
    sectionUnit = await repo.getUnit(db, scope.institutionId, group.academicUnitId, "SECTION");
    if (!sectionUnit || sectionUnit.parentId !== course.id) throw new CollegeSetupError(NOT_HERE.section);
  }
  const session = await repo.getSession(db, scope.institutionId, group.academicSessionId);
  if (!session) throw new CollegeSetupError(NOT_HERE.section);
  return { group, session, sectionUnit };
}

function requireOpenSession(session: SessionChoice): void {
  if (!session.isActive) {
    throw new CollegeSetupError(
      `${session.name} is archived, so its sections can't be changed. Restore it on the Academic sessions page first.`,
    );
  }
}

async function requireOpenSessionById(db: repo.Db, institutionId: string, sessionId: string) {
  const session = await repo.getSession(db, institutionId, sessionId);
  if (!session) throw new CollegeSetupError("That academic session does not belong to this college.");
  requireOpenSession(session);
  return session;
}

/**
 * A teacher the actor may give a section to: active staff who can confirm a
 * register — and, for a head of department, a member of their department.
 */
async function requireTeacher(
  db: repo.Db,
  scope: CollegeScope,
  userId: string,
): Promise<{ id: string; name: string }> {
  const id = userId.trim();
  if (id === "") throw new CollegeSetupError("Choose a teacher.");
  const teacher = await repo.findEligibleTeacher(db, scope.institutionId, id);
  if (!teacher) {
    const person = await repo.getPerson(db, scope.institutionId, id);
    if (!person) throw new CollegeSetupError("That teacher is not part of this college.");
    if (person.status !== "ACTIVE") {
      throw new CollegeSetupError(
        `${person.name}'s access has been stopped, so they can't be given a section. Restore it on the Faculty page first.`,
      );
    }
    throw new CollegeSetupError(
      `${person.name} can't take attendance with their current role, so they can't be given a section.`,
    );
  }
  if (scope.kind === "hod" && teacher.departmentId !== scope.departmentId) {
    throw new CollegeSetupError(
      `${teacher.name} is not in your department. Ask the college administrator to add them to it first.`,
    );
  }
  return teacher;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Loaded {
  scope: CollegeScope;
  tree: Tree;
  sessions: SessionChoice[];
  session: SessionChoice | null;
}

async function load(actor: SessionUser, requestedSessionId?: string): Promise<Loaded> {
  const scope = await resolveCollegeScope(actor);
  const [units, sessions] = await Promise.all([
    repo.listCollegeUnits(prisma, scope.institutionId),
    repo.listSessions(scope.institutionId),
  ]);
  return { scope, tree: buildTree(units), sessions, session: pickSession(sessions, requestedSessionId) };
}

function departmentRow(loaded: Loaded, departmentId: string): repo.UnitRow | null {
  const department = loaded.tree.byId.get(departmentId);
  if (!department || department.kind !== "DEPARTMENT") return null;
  return departmentInScope(loaded.scope, department.id) ? department : null;
}

/** The HOD role and the department agree about this person. */
function isConsistentHead(person: repo.PersonRow | undefined, department: repo.UnitRow): boolean {
  if (!person) return false;
  return (
    person.departmentId === department.id &&
    person.roleAssignments.some((assignment) => assignment.role.key === repo.HOD_ROLE_KEY)
  );
}

function toHead(person: repo.PersonRow, department: repo.UnitRow): HeadOfDepartment {
  return {
    userId: person.id,
    name: person.name,
    email: person.email,
    employeeCode: person.employeeCode,
    status: person.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
    lastLoginAt: person.lastLoginAt,
    consistent: isConsistentHead(person, department),
  };
}

/** Every department the actor may see, with its head and its counts for one session. */
export async function getDepartmentsOverview(
  actor: SessionUser,
  requestedSessionId?: string,
  search = "",
): Promise<DepartmentsOverview> {
  const loaded = await load(actor, requestedSessionId);
  const { scope, tree, sessions, session } = loaded;
  const query = nameKey(search);
  const departments = tree.departments.filter(
    (department) =>
      departmentInScope(scope, department.id) &&
      (query === "" || nameKey(department.name).includes(query) || nameKey(department.code ?? "").includes(query)),
  );

  const headIds = departments.map(headUserIdOf).filter((id): id is string => id !== null);
  const [institutionName, faculty, students, sectionCounts, heads] = await Promise.all([
    repo.getInstitutionName(scope.institutionId),
    repo.countFacultyByDepartment(scope.institutionId),
    session ? repo.countStudentsByDepartment(scope.institutionId, session.id) : Promise.resolve(new Map()),
    session ? repo.countSectionsByUnit(scope.institutionId, session.id) : Promise.resolve([]),
    repo.listPeople(prisma, scope.institutionId, headIds),
  ]);

  const sectionsByDepartment = new Map<string, number>();
  for (const { academicUnitId, sections } of sectionCounts) {
    const courseId = courseIdOfGroup(tree, { academicUnitId });
    const department = courseId ? departmentOfCourse(tree, courseId) : null;
    if (department) sectionsByDepartment.set(department, (sectionsByDepartment.get(department) ?? 0) + sections);
  }
  const headById = new Map(heads.map((person) => [person.id, person]));

  return {
    institutionName,
    session,
    sessions,
    departments: departments.map((department) => {
      const semesters = semestersOf(tree, department.id);
      const headId = headUserIdOf(department);
      const head = headId ? headById.get(headId) : undefined;
      return {
        ...toDepartmentRef(department),
        hod: head
          ? {
              name: head.name,
              status: head.status === "ACTIVE" ? ("ACTIVE" as const) : ("INACTIVE" as const),
              consistent: isConsistentHead(head, department),
            }
          : null,
        semesters: semesters.length,
        courses: semesters.reduce((sum, semester) => sum + coursesOf(tree, semester.id).length, 0),
        sections: sectionsByDepartment.get(department.id) ?? 0,
        faculty: faculty.get(department.id) ?? 0,
        students: students.get(department.id) ?? 0,
      };
    }),
  };
}

function departmentOfCourse(tree: Tree, courseId: string): string | null {
  const course = tree.byId.get(courseId);
  const semester = course?.parentId ? tree.byId.get(course.parentId) : undefined;
  const department = semester?.parentId ? tree.byId.get(semester.parentId) : undefined;
  return department?.kind === "DEPARTMENT" ? department.id : null;
}

/** A department's session groups and who is in them — one read each. */
async function departmentGroups(loaded: Loaded, department: repo.UnitRow) {
  const courses = departmentCourses(loaded.tree, department.id);
  if (!loaded.session) return { courses, groups: [] as repo.GroupRow[], placements: [] };
  const groups = await repo.listSessionGroups(
    prisma,
    loaded.scope.institutionId,
    loaded.session.id,
    sectionUnitIds(loaded.tree, courses.map((course) => course.id)),
  );
  const placements = await repo.listActivePlacements(prisma, groups.map((group) => group.id));
  return { courses, groups, placements };
}

/** Null when the department is not one the actor may see, so the page can 404. */
export async function getDepartmentDetail(
  actor: SessionUser,
  departmentId: string,
  requestedSessionId?: string,
): Promise<DepartmentDetail | null> {
  const loaded = await load(actor, requestedSessionId);
  const department = departmentRow(loaded, departmentId);
  if (!department) return null;
  const { scope, tree } = loaded;

  const headId = headUserIdOf(department);
  const [{ groups, placements }, faculty, head, candidates] = await Promise.all([
    departmentGroups(loaded, department),
    repo.countFacultyByDepartment(scope.institutionId),
    headId ? repo.getPerson(prisma, scope.institutionId, headId) : Promise.resolve(null),
    scope.kind === "admin" ? repo.listHeadCandidates(prisma, scope.institutionId) : Promise.resolve([]),
  ]);

  const byCourse = groupsByCourse(tree, groups);
  const semesters: SemesterRow[] = semestersOf(tree, department.id).map((semester) => {
    const courses = coursesOf(tree, semester.id);
    const semesterGroups = courses.flatMap((course) => byCourse.get(course.id) ?? []);
    return {
      ...toSemesterRef(semester),
      code: semester.code,
      isCurrent: currentSemesterIdOf(tree, department) === semester.id,
      courses: courses.length,
      sections: semesterGroups.length,
      students: distinctStudents(placements, new Set(semesterGroups.map((group) => group.id))),
    };
  });

  // Somebody heading another department is not offered: one department each.
  const headingElsewhere = new Set(
    tree.departments
      .filter((other) => other.id !== department.id)
      .map(headUserIdOf)
      .filter((id): id is string => id !== null),
  );
  const hodCandidates: StaffChoice[] = candidates
    .filter((person) => !headingElsewhere.has(person.id))
    .map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      inDepartment: person.departmentId === department.id,
    }))
    .sort((a, b) => Number(b.inDepartment) - Number(a.inDepartment));

  return {
    ...toDepartmentRef(department),
    hod: head ? toHead(head, department) : null,
    session: loaded.session,
    sessions: loaded.sessions,
    semesters,
    currentSemesterId: currentSemesterIdOf(tree, department),
    counts: {
      semesters: semesters.length,
      courses: semesters.reduce((sum, semester) => sum + semester.courses, 0),
      sections: groups.filter((group) => courseIdOfGroup(tree, group)).length,
      faculty: faculty.get(department.id) ?? 0,
      students: distinctStudents(placements, new Set(groups.map((group) => group.id))),
    },
    hodCandidates,
  };
}

function toCourseRows(
  tree: Tree,
  courses: readonly repo.UnitRow[],
  groups: readonly repo.GroupRow[],
  placements: readonly { studentId: string; cohortId: string }[],
): CourseRow[] {
  const byCourse = groupsByCourse(tree, groups);
  return courses.map((course) => {
    const semester = tree.byId.get(course.parentId!)!;
    const department = tree.byId.get(semester.parentId!)!;
    const courseGroups = byCourse.get(course.id) ?? [];
    const sections = sortedSectionRows(tree, courseGroups);
    return {
      ...toCourseRef(course),
      semester: toSemesterRef(semester),
      department: toDepartmentRef(department),
      sections,
      studentCount: distinctStudents(placements, new Set(courseGroups.map((group) => group.id))),
      status: courseStatus(sections),
    };
  });
}

/** Null when the semester is not in a department the actor may see. */
export async function getSemesterDetail(
  actor: SessionUser,
  departmentId: string,
  semesterId: string,
  requestedSessionId?: string,
): Promise<SemesterDetail | null> {
  const loaded = await load(actor, requestedSessionId);
  const department = departmentRow(loaded, departmentId);
  const semester = loaded.tree.byId.get(semesterId);
  if (!department || semester?.kind !== "SEMESTER" || semester.parentId !== department.id) return null;

  const courses = coursesOf(loaded.tree, semester.id);
  let groups: repo.GroupRow[] = [];
  let placements: { studentId: string; cohortId: string }[] = [];
  if (loaded.session) {
    groups = await repo.listSessionGroups(
      prisma,
      loaded.scope.institutionId,
      loaded.session.id,
      sectionUnitIds(loaded.tree, courses.map((course) => course.id)),
    );
    placements = await repo.listActivePlacements(prisma, groups.map((group) => group.id));
  }

  return {
    ...toSemesterRef(semester),
    code: semester.code,
    isCurrent: currentSemesterIdOf(loaded.tree, department) === semester.id,
    department: toDepartmentRef(department),
    session: loaded.session,
    sessions: loaded.sessions,
    courses: toCourseRows(loaded.tree, courses, groups, placements),
  };
}

/** Teachers a section of this department may be given, by who is asking. */
async function teacherChoices(scope: CollegeScope, departmentId: string): Promise<StaffChoice[]> {
  const rows = await repo.listEligibleTeachers(
    prisma,
    scope.institutionId,
    scope.kind === "hod" ? departmentId : undefined,
  );
  return rows
    .map((row) => ({ id: row.id, name: row.name, email: row.email, inDepartment: row.departmentId === departmentId }))
    .sort((a, b) => Number(b.inDepartment) - Number(a.inDepartment));
}

/** Null when the course is not in a department the actor may see. */
export async function getCourseDetail(
  actor: SessionUser,
  departmentId: string,
  semesterId: string,
  courseId: string,
  requestedSessionId?: string,
): Promise<CourseDetail | null> {
  const loaded = await load(actor, requestedSessionId);
  const department = departmentRow(loaded, departmentId);
  const semester = loaded.tree.byId.get(semesterId);
  const course = loaded.tree.byId.get(courseId);
  if (
    !department ||
    semester?.kind !== "SEMESTER" ||
    semester.parentId !== department.id ||
    course?.kind !== "COURSE" ||
    course.parentId !== semester.id
  ) {
    return null;
  }

  const [groups, teachers] = await Promise.all([
    loaded.session
      ? repo.listSessionGroups(
          prisma,
          loaded.scope.institutionId,
          loaded.session.id,
          sectionUnitIds(loaded.tree, [course.id]),
        )
      : Promise.resolve([]),
    teacherChoices(loaded.scope, department.id),
  ]);

  return {
    ...toCourseRef(course),
    department: toDepartmentRef(department),
    semester: toSemesterRef(semester),
    session: loaded.session,
    sessions: loaded.sessions,
    sections: sortedSectionRows(loaded.tree, groups),
    teachers,
    canHaveSections: Boolean(course.code),
  };
}

/** Null when the section is not in a course the actor may see. */
export async function getCourseSectionDetail(
  actor: SessionUser,
  ids: { departmentId: string; semesterId: string; courseId: string; sectionId: string },
): Promise<CourseSectionDetail | null> {
  const loaded = await load(actor);
  const department = departmentRow(loaded, ids.departmentId);
  const semester = loaded.tree.byId.get(ids.semesterId);
  const course = loaded.tree.byId.get(ids.courseId);
  if (
    !department ||
    semester?.kind !== "SEMESTER" ||
    semester.parentId !== department.id ||
    course?.kind !== "COURSE" ||
    course.parentId !== semester.id
  ) {
    return null;
  }
  const { scope, tree } = loaded;

  const group = await repo.getGroup(prisma, scope.institutionId, ids.sectionId);
  if (!group || courseIdOfGroup(tree, group) !== course.id) return null;
  const session = loaded.sessions.find((candidate) => candidate.id === group.academicSessionId);
  if (!session) return null;

  const courseLink = courseSubjectLink(group, course.code);
  const [enrolled, teachers, blockers, others] = await Promise.all([
    repo.listSectionStudents(prisma, [group.id]),
    teacherChoices(scope, department.id),
    repo.countSectionRemovalBlockers(prisma, scope.institutionId, group.id, courseLink?.subjectId ?? null),
    repo.listStudentsInGroupsExcept(
      prisma,
      scope.institutionId,
      session.id,
      sectionUnitIds(tree, departmentCourses(tree, department.id).map((unit) => unit.id)),
      group.id,
    ),
  ]);
  const faces = await repo.listStudentIdsWithFaces(
    prisma,
    enrolled.map((row) => row.student.id),
  );

  const inSection = new Set(enrolled.map((row) => row.student.id));
  const departmentStudents = others
    .filter((student) => !inSection.has(student.id))
    .map((student) => ({
      id: student.id,
      studentCode: student.studentCode,
      name: `${student.firstName} ${student.lastName}`.trim(),
    }));

  return {
    department: toDepartmentRef(department),
    semester: toSemesterRef(semester),
    course: toCourseRef(course),
    session,
    section: sortedSectionRows(tree, [group])[0],
    students: enrolled.map((row) => ({
      studentId: row.student.id,
      studentCode: row.student.studentCode,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      faceEnrolled: faces.has(row.student.id),
      hasLogin: row.student.userId !== null,
    })),
    teachers,
    departmentStudents: departmentStudents.sort((a, b) =>
      a.studentCode.localeCompare(b.studentCode, "en", { numeric: true }),
    ),
    removal: sectionRemovalCheck(blockers, session),
  };
}

/** Where a new student from this section will be placed — for the add-student page. */
export async function getSectionPlacement(
  actor: SessionUser,
  ids: { departmentId: string; semesterId: string; courseId: string; sectionId: string },
): Promise<SectionPlacement | null> {
  const scope = await resolveCollegeScope(actor);
  try {
    const chain = await requireChain(prisma, scope, ids);
    const { group, session, sectionUnit } = await requireSectionOf(prisma, scope, chain.course!, ids.sectionId);
    return {
      department: toDepartmentRef(chain.department),
      semester: toSemesterRef(chain.semester!),
      course: toCourseRef(chain.course!),
      session,
      section: {
        id: group.id,
        name: sectionUnit?.name ?? group.name,
        label: sectionUnit ? sectionLabel(sectionUnit.name) : group.name,
        groupName: group.name,
      },
    };
  } catch (error) {
    if (error instanceof CollegeSetupError) return null;
    throw error;
  }
}

const STUDENT_LIST_LIMIT = 500;

/** The department's students this session: everyone in one of its sections. */
export async function getDepartmentStudents(
  actor: SessionUser,
  departmentId: string,
  filters: { sessionId?: string; q?: string; courseId?: string } = {},
): Promise<DepartmentStudents | null> {
  const loaded = await load(actor, filters.sessionId);
  const department = departmentRow(loaded, departmentId);
  if (!department) return null;

  const { groups } = await departmentGroups(loaded, department);
  const byGroup = new Map(groups.map((group) => [group.id, group]));
  const rows = await repo.listSectionStudents(prisma, groups.map((group) => group.id));

  const students = new Map<string, DepartmentStudentRow>();
  for (const row of rows) {
    const group = byGroup.get(row.cohortId);
    const courseId = group ? courseIdOfGroup(loaded.tree, group) : null;
    const course = courseId ? loaded.tree.byId.get(courseId) : undefined;
    if (!group || !course?.parentId) continue;
    const entry =
      students.get(row.student.id) ??
      ({
        studentId: row.student.id,
        studentCode: row.student.studentCode,
        firstName: row.student.firstName,
        lastName: row.student.lastName,
        faceEnrolled: false,
        hasLogin: row.student.userId !== null,
        sections: [],
      } satisfies DepartmentStudentRow);
    entry.sections.push({ sectionId: group.id, groupName: group.name, courseId: course.id, semesterId: course.parentId });
    students.set(row.student.id, entry);
  }

  const query = nameKey(filters.q ?? "");
  const matched = [...students.values()]
    .filter(
      (student) =>
        query === "" ||
        nameKey(`${student.firstName} ${student.lastName}`).includes(query) ||
        nameKey(student.studentCode).includes(query),
    )
    .filter((student) => !filters.courseId || student.sections.some((section) => section.courseId === filters.courseId))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const listed = matched.slice(0, STUDENT_LIST_LIMIT);
  const faces = await repo.listStudentIdsWithFaces(prisma, listed.map((student) => student.studentId));
  for (const student of listed) student.faceEnrolled = faces.has(student.studentId);

  return {
    department: toDepartmentRef(department),
    session: loaded.session,
    sessions: loaded.sessions,
    courses: departmentCourses(loaded.tree, department.id).map(toCourseRef),
    students: listed,
    truncated: matched.length > listed.length,
  };
}

/** The department's staff, and anyone else teaching one of its sections this session. */
export async function getDepartmentFaculty(
  actor: SessionUser,
  departmentId: string,
  requestedSessionId?: string,
): Promise<DepartmentFaculty | null> {
  const loaded = await load(actor, requestedSessionId);
  const department = departmentRow(loaded, departmentId);
  if (!department) return null;

  const [{ groups }, members] = await Promise.all([
    departmentGroups(loaded, department),
    prisma.user.findMany({
      where: { institutionId: loaded.scope.institutionId, departmentId: department.id, studentProfile: { is: null } },
      select: { id: true },
    }),
  ]);
  const teaching = new Map<string, DepartmentFacultyRow["sections"]>();
  for (const group of groups) {
    const courseId = courseIdOfGroup(loaded.tree, group);
    const course = courseId ? loaded.tree.byId.get(courseId) : undefined;
    if (!course?.parentId) continue;
    for (const link of group.facultyLinks) {
      if (link.role !== "PRIMARY") continue;
      teaching.set(link.user.id, [
        ...(teaching.get(link.user.id) ?? []),
        { sectionId: group.id, groupName: group.name, courseId: course.id, semesterId: course.parentId },
      ]);
    }
  }
  const memberIds = new Set(members.map((member) => member.id));
  const people = await repo.listPeople(prisma, loaded.scope.institutionId, [
    ...new Set([...memberIds, ...teaching.keys()]),
  ]);
  const headId = headUserIdOf(department);

  const faculty: DepartmentFacultyRow[] = people
    .map((person) => ({
      userId: person.id,
      name: person.name,
      email: person.email,
      employeeCode: person.employeeCode,
      status: person.status === "ACTIVE" ? ("ACTIVE" as const) : ("INACTIVE" as const),
      isHead: person.id === headId && isConsistentHead(person, department),
      member: memberIds.has(person.id),
      sections: (teaching.get(person.id) ?? []).sort((a, b) =>
        a.groupName.localeCompare(b.groupName, "en", { numeric: true }),
      ),
    }))
    .sort((a, b) => Number(b.isHead) - Number(a.isHead) || Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));

  return {
    department: toDepartmentRef(department),
    session: loaded.session,
    sessions: loaded.sessions,
    faculty,
  };
}

/** Semesters for the index page: every department the actor may see, each with its semesters. */
export async function getSemestersIndex(actor: SessionUser) {
  const loaded = await load(actor);
  const { tree, scope } = loaded;
  return {
    scope: scope.kind,
    departments: tree.departments
      .filter((department) => departmentInScope(scope, department.id))
      .map((department) => ({
        ...toDepartmentRef(department),
        currentSemesterId: currentSemesterIdOf(tree, department),
        semesters: semestersOf(tree, department.id).map((semester) => ({
          ...toSemesterRef(semester),
          courses: coursesOf(tree, semester.id).length,
        })),
      })),
  };
}

/**
 * Courses across the departments the actor may see, for the Courses and
 * Sections index pages: one structure read, one read of the session's groups
 * and one of who is in them.
 */
export async function getCoursesIndex(
  actor: SessionUser,
  filters: { sessionId?: string; departmentId?: string; semesterId?: string; q?: string } = {},
) {
  const loaded = await load(actor, filters.sessionId);
  const { tree, scope } = loaded;
  const departments = tree.departments.filter((department) => departmentInScope(scope, department.id));
  const departmentFilter = departments.find((department) => department.id === filters.departmentId) ?? null;

  let courses = (departmentFilter ? [departmentFilter] : departments).flatMap((department) =>
    departmentCourses(tree, department.id),
  );
  if (filters.semesterId) courses = courses.filter((course) => course.parentId === filters.semesterId);
  const query = nameKey(filters.q ?? "");
  if (query) {
    courses = courses.filter(
      (course) => nameKey(course.name).includes(query) || nameKey(course.code ?? "").includes(query),
    );
  }

  let groups: repo.GroupRow[] = [];
  let placements: { studentId: string; cohortId: string }[] = [];
  if (loaded.session && courses.length > 0) {
    groups = await repo.listSessionGroups(
      prisma,
      scope.institutionId,
      loaded.session.id,
      sectionUnitIds(tree, courses.map((course) => course.id)),
    );
    placements = await repo.listActivePlacements(prisma, groups.map((group) => group.id));
  }

  return {
    scope: scope.kind,
    session: loaded.session,
    sessions: loaded.sessions,
    departments: departments.map((department) => ({
      ...toDepartmentRef(department),
      semesters: semestersOf(tree, department.id).map(toSemesterRef),
    })),
    selectedDepartmentId: departmentFilter?.id ?? null,
    courses: toCourseRows(tree, courses, groups, placements),
  };
}

/** A head of department's home screen: their department at a glance. */
export async function getCollegeHome(actor: SessionUser): Promise<CollegeHome | null> {
  const loaded = await load(actor);
  if (loaded.scope.kind !== "hod") return null;
  const department = departmentRow(loaded, loaded.scope.departmentId);
  if (!department) return null;

  const [{ groups, placements }, faculty, institutionName] = await Promise.all([
    departmentGroups(loaded, department),
    repo.countFacultyByDepartment(loaded.scope.institutionId),
    repo.getInstitutionName(loaded.scope.institutionId),
  ]);
  const sections = sortedSectionRows(
    loaded.tree,
    groups.filter((group) => courseIdOfGroup(loaded.tree, group)),
  );
  const currentId = currentSemesterIdOf(loaded.tree, department);
  const current = currentId ? loaded.tree.byId.get(currentId) : undefined;
  const semesters = semestersOf(loaded.tree, department.id);

  return {
    institutionName,
    department: toDepartmentRef(department),
    session: loaded.session,
    currentSemester: current ? toSemesterRef(current) : null,
    counts: {
      semesters: semesters.length,
      courses: departmentCourses(loaded.tree, department.id).length,
      sections: sections.length,
      faculty: faculty.get(department.id) ?? 0,
      students: distinctStudents(placements, new Set(sections.map((section) => section.id))),
    },
    sectionsNeedingTeacher: sections.filter((section) => section.status !== "ready").length,
  };
}

/** The department a head of department heads — for links that name no department. */
export async function getOwnDepartmentId(actor: SessionUser): Promise<string | null> {
  const scope = await resolveCollegeScope(actor);
  return scope.kind === "hod" ? scope.departmentId : null;
}

// ---------------------------------------------------------------------------
// Departments — administrators only
// ---------------------------------------------------------------------------

function refuseDuplicateDepartment(
  departments: readonly repo.UnitRow[],
  name: string,
  code: string,
  exceptId?: string,
) {
  for (const other of departments) {
    if (other.id === exceptId) continue;
    if (other.code && nameKey(other.code) === nameKey(code)) {
      throw new CollegeSetupError(`${other.name} already uses the code ${other.code}. Choose a different code.`);
    }
    if (sameName(other.name, name)) {
      throw new CollegeSetupError(`This college already has a department called ${other.name}.`);
    }
  }
}

export async function createDepartment(
  actor: SessionUser,
  input: { name: string; code: string },
): Promise<{ departmentId: string; name: string }> {
  const scope = await requireCollegeAdmin(actor, STRUCTURE);
  const name = validateDepartmentName(input.name);
  const code = validateDepartmentCode(input.code);

  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const units = await repo.listCollegeUnits(tx, scope.institutionId);
    refuseDuplicateDepartment(
      units.filter((unit) => unit.kind === "DEPARTMENT"),
      name,
      code,
    );
    const department = await tx.academicUnit.create({
      data: { institutionId: scope.institutionId, campusId: actor.campusId ?? null, kind: "DEPARTMENT", name, code },
      select: { id: true },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.created",
      entityType: "AcademicUnit",
      entityId: department.id,
      afterJson: { kind: "DEPARTMENT", name, code },
    });
    return { departmentId: department.id, name };
  }, TX_OPTIONS);
}

export async function updateDepartment(
  actor: SessionUser,
  input: { departmentId: string; name: string; code: string },
): Promise<{ name: string }> {
  const scope = await requireCollegeAdmin(actor, STRUCTURE);
  const name = validateDepartmentName(input.name);
  const code = validateDepartmentCode(input.code);

  await prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { department } = await requireChain(tx, scope, { departmentId: input.departmentId });
    if (department.name === name && department.code === code) {
      throw new CollegeSetupError("Nothing to change: the name and code are already these.");
    }
    const units = await repo.listCollegeUnits(tx, scope.institutionId);
    refuseDuplicateDepartment(
      units.filter((unit) => unit.kind === "DEPARTMENT"),
      name,
      code,
      department.id,
    );
    await tx.academicUnit.update({ where: { id: department.id }, data: { name, code } });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: department.id,
      beforeJson: { name: department.name, code: department.code },
      afterJson: { name, code },
    });
  }, TX_OPTIONS);
  return { name };
}

// ---------------------------------------------------------------------------
// Head of department — administrators only
// ---------------------------------------------------------------------------

const ROLE_NOT_SET_UP =
  "The Head of Department role is not set up in this system yet. Ask the platform administrator to run the " +
  "system role sync (bootstrap:system), then try again.";

async function roleKeysOf(tx: Tx, institutionId: string, userId: string): Promise<string[]> {
  const rows = await tx.userRoleAssignment.findMany({
    where: { userId, OR: [{ institutionId }, { institutionId: null }] },
    select: { role: { select: { key: true } } },
  });
  return rows.map((row) => row.role.key).sort();
}

/** Takes the HOD role away and gives the ordinary teaching role back if they have no other. */
async function stepDown(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  userId: string,
  departmentId: string,
): Promise<void> {
  const person = await repo.getPerson(tx, institutionId, userId);
  if (!person) return;
  const before = await roleKeysOf(tx, institutionId, userId);
  const hodAssignments = person.roleAssignments.filter((assignment) => assignment.role.key === repo.HOD_ROLE_KEY);
  if (hodAssignments.length === 0) return;

  await tx.userRoleAssignment.deleteMany({ where: { id: { in: hodAssignments.map((a) => a.id) } } });
  const stillTeaches = person.roleAssignments.some(
    (assignment) => assignment.role.key !== repo.HOD_ROLE_KEY,
  );
  if (!stillTeaches) {
    const faculty = await repo.findRoleByKey(tx, institutionId, repo.RESTORED_ROLE_KEY);
    if (faculty) {
      await tx.userRoleAssignment.create({
        data: { userId, roleId: faculty.id, institutionId, campusId: null },
      });
    }
  }
  await audit(tx, actor, institutionId, {
    action: "user.role_changed",
    entityType: "User",
    entityId: userId,
    beforeJson: { roles: before, headOfDepartmentId: departmentId },
    afterJson: { roles: await roleKeysOf(tx, institutionId, userId), headOfDepartmentId: null },
  });
}

/**
 * Makes an existing member of staff this department's head.
 *
 * In one transaction: their department becomes this one; their teaching role
 * is replaced by the HOD role, which can still teach but cannot read the
 * college-wide directories; the department names them; and a previous head
 * steps down to an ordinary teaching role. Each part is audited. They keep
 * their login and password; the change applies from their next page load.
 */
export async function assignDepartmentHead(
  actor: SessionUser,
  input: { departmentId: string; userId: string },
): Promise<{ name: string; replaced: string | null }> {
  const scope = await requireCollegeAdmin(actor, ["role.assign", "user.update"]);
  const userId = input.userId.trim();
  if (userId === "") throw new CollegeSetupError("Choose who will head the department.");

  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { department } = await requireChain(tx, scope, { departmentId: input.departmentId });

    const teacher = await repo.findEligibleTeacher(tx, scope.institutionId, userId);
    if (!teacher) {
      const person = await repo.getPerson(tx, scope.institutionId, userId);
      if (!person) throw new CollegeSetupError("That person is not part of this college.");
      if (person.status !== "ACTIVE") {
        throw new CollegeSetupError(`${person.name}'s access has been stopped. Restore it on the Faculty page first.`);
      }
      throw new CollegeSetupError(`${person.name} can't teach with their current role, so they can't head a department.`);
    }
    if (await repo.holdsAdministratorRole(tx, teacher.id)) {
      throw new CollegeSetupError(
        `${teacher.name} is a college administrator and already manages every department. Choose a member of the teaching staff.`,
      );
    }
    const role = await repo.findRoleByKey(tx, scope.institutionId, repo.HOD_ROLE_KEY);
    if (!role) throw new CollegeSetupError(ROLE_NOT_SET_UP);

    const elsewhere = (await repo.listDepartmentsHeadedBy(tx, scope.institutionId, teacher.id)).filter(
      (other) => other.id !== department.id,
    );
    if (elsewhere.length > 0) {
      throw new CollegeSetupError(
        `${teacher.name} already heads ${elsewhere[0].name}. A person heads one department; change ${elsewhere[0].name}'s head first.`,
      );
    }

    const person = (await repo.getPerson(tx, scope.institutionId, teacher.id))!;
    const previousHeadId = headUserIdOf(department);
    if (previousHeadId === teacher.id && isConsistentHead(person, department)) {
      throw new CollegeSetupError(`${teacher.name} already heads ${department.name}.`);
    }

    let replaced: string | null = null;
    if (previousHeadId && previousHeadId !== teacher.id) {
      const previous = await repo.getPerson(tx, scope.institutionId, previousHeadId);
      await stepDown(tx, actor, scope.institutionId, previousHeadId, department.id);
      replaced = previous?.name ?? null;
    }

    if (person.departmentId !== department.id) {
      await tx.user.update({ where: { id: person.id }, data: { departmentId: department.id } });
      await audit(tx, actor, scope.institutionId, {
        action: "user.updated",
        entityType: "User",
        entityId: person.id,
        beforeJson: { departmentId: person.departmentId },
        afterJson: { departmentId: department.id },
      });
    }

    const before = await roleKeysOf(tx, scope.institutionId, person.id);
    const replacedAssignments = person.roleAssignments.filter((assignment) =>
      (repo.STAFF_ROLE_KEYS as readonly string[]).includes(assignment.role.key),
    );
    if (replacedAssignments.length > 0) {
      await tx.userRoleAssignment.deleteMany({ where: { id: { in: replacedAssignments.map((a) => a.id) } } });
    }
    if (!person.roleAssignments.some((assignment) => assignment.role.key === repo.HOD_ROLE_KEY)) {
      await tx.userRoleAssignment.create({
        data: { userId: person.id, roleId: role.id, institutionId: scope.institutionId, campusId: null },
      });
    }
    await audit(tx, actor, scope.institutionId, {
      action: "user.role_changed",
      entityType: "User",
      entityId: person.id,
      beforeJson: { roles: before },
      afterJson: { roles: await roleKeysOf(tx, scope.institutionId, person.id), headOfDepartmentId: department.id },
    });

    await tx.academicUnit.update({
      where: { id: department.id },
      data: { metadata: withMetadata(department, "headUserId", person.id) },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: department.id,
      beforeJson: { headUserId: previousHeadId },
      afterJson: { headUserId: person.id },
    });

    return { name: person.name, replaced };
  }, TX_OPTIONS);
}

/** The department has no head: the current one steps down to an ordinary teaching role. */
export async function removeDepartmentHead(
  actor: SessionUser,
  departmentId: string,
): Promise<{ name: string | null }> {
  const scope = await requireCollegeAdmin(actor, ["role.assign", "user.update"]);
  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { department } = await requireChain(tx, scope, { departmentId });
    const headId = headUserIdOf(department);
    if (!headId) throw new CollegeSetupError(`${department.name} has no head to remove.`);
    const person = await repo.getPerson(tx, scope.institutionId, headId);
    await stepDown(tx, actor, scope.institutionId, headId, department.id);
    await tx.academicUnit.update({
      where: { id: department.id },
      data: { metadata: withMetadata(department, "headUserId", null) },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: department.id,
      beforeJson: { headUserId: headId },
      afterJson: { headUserId: null },
    });
    return { name: person?.name ?? null };
  }, TX_OPTIONS);
}

/**
 * A new staff account, made this department's head.
 *
 * The account comes from `inviteFaculty` — the one place a staff password is
 * set — in this department, with the teaching role, and is then made head.
 * Two steps, as on the school Classes screen: if the second fails, the
 * password is still returned, because this is the only time it can be shown.
 */
export async function createDepartmentHead(
  actor: SessionUser,
  input: { departmentId: string; name: string; email: string; employeeCode?: string },
): Promise<{ invited: InvitedFaculty; assignError: string | null }> {
  const scope = await requireCollegeAdmin(actor, ["user.invite", "role.assign", "user.update"]);
  const { department } = await requireChain(prisma, scope, { departmentId: input.departmentId });
  if (!(await repo.findRoleByKey(prisma, scope.institutionId, repo.HOD_ROLE_KEY))) {
    throw new CollegeSetupError(ROLE_NOT_SET_UP);
  }

  const invited = await inviteFaculty(actor, {
    name: input.name,
    email: input.email,
    employeeCode: input.employeeCode,
    departmentId: department.id,
    roleKey: repo.RESTORED_ROLE_KEY,
  });
  try {
    await assignDepartmentHead(actor, { departmentId: department.id, userId: invited.member.id });
    return { invited, assignError: null };
  } catch (error) {
    return {
      invited,
      assignError:
        error instanceof CollegeSetupError
          ? error.message
          : "The account was created, but could not be made head. Try again from the department page.",
    };
  }
}

async function requireHeadOf(actor: SessionUser, departmentId: string): Promise<{ userId: string; name: string }> {
  const scope = await requireCollegeAdmin(actor);
  const { department } = await requireChain(prisma, scope, { departmentId });
  const headId = headUserIdOf(department);
  const person = headId ? await repo.getPerson(prisma, scope.institutionId, headId) : null;
  if (!person) throw new CollegeSetupError(`${department.name} has no head.`);
  return { userId: person.id, name: person.name };
}

/**
 * A new temporary password for the head: shown once, never stored in a form
 * anyone can read back, and every session they had is ended. The Faculty
 * service does it — the one place a staff password is set.
 */
export async function resetDepartmentHeadPassword(
  actor: SessionUser,
  departmentId: string,
): Promise<IssuedPassword & { name: string }> {
  const head = await requireHeadOf(actor, departmentId);
  const issued = await resetFacultyPassword(actor, head.userId);
  return { ...issued, name: head.name };
}

/** Stops or restores the head's ability to sign in, through the Faculty service. */
export async function setDepartmentHeadActive(
  actor: SessionUser,
  departmentId: string,
  active: boolean,
): Promise<{ name: string }> {
  const head = await requireHeadOf(actor, departmentId);
  if (active) await reactivateFaculty(actor, head.userId);
  else await deactivateFaculty(actor, head.userId);
  return { name: head.name };
}

// ---------------------------------------------------------------------------
// Semesters — administrators, and the department's head
// ---------------------------------------------------------------------------

function refuseDuplicateSemester(
  semesters: readonly repo.UnitRow[],
  number: number,
  name: string,
  exceptId?: string,
) {
  for (const other of semesters) {
    if (other.id === exceptId) continue;
    if (other.sortOrder === number) {
      throw new CollegeSetupError(`This department already has semester ${number} (${other.name}).`);
    }
    if (sameName(other.name, name)) {
      throw new CollegeSetupError(`This department already has a semester called ${other.name}.`);
    }
  }
}

export async function createSemester(
  actor: SessionUser,
  input: { departmentId: string; number: string | number; name?: string },
): Promise<{ semesterId: string; name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  const number = validateSemesterNumber(input.number);
  const name = validateSemesterName(input.name, number);

  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { department } = await requireChain(tx, scope, { departmentId: input.departmentId });
    const siblings = (await repo.listCollegeUnits(tx, scope.institutionId)).filter(
      (unit) => unit.kind === "SEMESTER" && unit.parentId === department.id,
    );
    refuseDuplicateSemester(siblings, number, name);
    const semester = await tx.academicUnit.create({
      data: {
        institutionId: scope.institutionId,
        campusId: actor.campusId ?? null,
        parentId: department.id,
        kind: "SEMESTER",
        name,
        code: `S${number}`,
        sortOrder: number,
      },
      select: { id: true },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.created",
      entityType: "AcademicUnit",
      entityId: semester.id,
      afterJson: { kind: "SEMESTER", name, number, parentId: department.id },
    });
    return { semesterId: semester.id, name };
  }, TX_OPTIONS);
}

export async function updateSemester(
  actor: SessionUser,
  input: { departmentId: string; semesterId: string; number: string | number; name?: string },
): Promise<{ name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  const number = validateSemesterNumber(input.number);
  const name = validateSemesterName(input.name, number);

  await prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { department, semester } = await requireChain(tx, scope, {
      departmentId: input.departmentId,
      semesterId: input.semesterId,
    });
    if (semester!.name === name && semester!.sortOrder === number) {
      throw new CollegeSetupError("Nothing to change: the semester is already called that.");
    }
    const siblings = (await repo.listCollegeUnits(tx, scope.institutionId)).filter(
      (unit) => unit.kind === "SEMESTER" && unit.parentId === department.id,
    );
    refuseDuplicateSemester(siblings, number, name, semester!.id);
    await tx.academicUnit.update({
      where: { id: semester!.id },
      data: { name, sortOrder: number, code: `S${number}` },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: semester!.id,
      beforeJson: { name: semester!.name, number: semester!.sortOrder },
      afterJson: { name, number },
    });
  }, TX_OPTIONS);
  return { name };
}

/** Marks one of the department's semesters as the current one, or clears it with an empty id. */
export async function setCurrentSemester(
  actor: SessionUser,
  input: { departmentId: string; semesterId: string },
): Promise<{ name: string | null }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const semesterId = input.semesterId.trim();
    const chain = semesterId
      ? await requireChain(tx, scope, { departmentId: input.departmentId, semesterId })
      : await requireChain(tx, scope, { departmentId: input.departmentId });
    const department = chain.department;
    const previous = readMetadataId(department, "currentSemesterId");
    if ((previous ?? "") === semesterId) {
      throw new CollegeSetupError(
        chain.semester ? `${chain.semester.name} is already the current semester.` : "No semester is marked current.",
      );
    }
    await tx.academicUnit.update({
      where: { id: department.id },
      data: { metadata: withMetadata(department, "currentSemesterId", semesterId || null) },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: department.id,
      beforeJson: { currentSemesterId: previous },
      afterJson: { currentSemesterId: semesterId || null },
    });
    return { name: chain.semester?.name ?? null };
  }, TX_OPTIONS);
}

function readMetadataId(unit: repo.UnitRow, key: string): string | null {
  const value =
    unit.metadata && typeof unit.metadata === "object" && !Array.isArray(unit.metadata)
      ? (unit.metadata as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Removes a semester set up by mistake — only while it has no courses. */
export async function removeSemester(
  actor: SessionUser,
  input: { departmentId: string; semesterId: string },
): Promise<{ name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { department, semester } = await requireChain(tx, scope, {
      departmentId: input.departmentId,
      semesterId: input.semesterId,
    });
    if (await repo.unitStillInUse(tx, semester!.id)) {
      throw new CollegeSetupError(`${semester!.name} has courses. Remove them first, or keep the semester.`);
    }
    await tx.academicUnit.delete({ where: { id: semester!.id } });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.deleted",
      entityType: "AcademicUnit",
      entityId: semester!.id,
      beforeJson: { kind: "SEMESTER", name: semester!.name, number: semester!.sortOrder, parentId: department.id },
    });
    if (readMetadataId(department, "currentSemesterId") === semester!.id) {
      await tx.academicUnit.update({
        where: { id: department.id },
        data: { metadata: withMetadata(department, "currentSemesterId", null) },
      });
    }
    return { name: semester!.name };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

/**
 * The subject that carries a course onto its registers: the one with its
 * code, created if there is none yet, and kept named as the course is.
 */
async function courseSubject(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  course: { code: string; name: string },
): Promise<{ id: string }> {
  const existing = await repo.findSubjectByCode(tx, institutionId, course.code);
  if (existing) {
    if (existing.name !== course.name || existing.code !== course.code) {
      await tx.subject.update({ where: { id: existing.id }, data: { name: course.name, code: course.code } });
      await audit(tx, actor, institutionId, {
        action: "subject.updated",
        entityType: "Subject",
        entityId: existing.id,
        beforeJson: { code: existing.code, name: existing.name },
        afterJson: { code: course.code, name: course.name },
      });
    }
    return { id: existing.id };
  }
  const subject = await tx.subject.create({
    data: { institutionId, code: course.code, name: course.name },
    select: { id: true },
  });
  await audit(tx, actor, institutionId, {
    action: "subject.created",
    entityType: "Subject",
    entityId: subject.id,
    afterJson: { code: course.code, name: course.name },
  });
  return subject;
}

function refuseDuplicateCourseCode(units: readonly repo.UnitRow[], code: string, exceptId?: string) {
  const clash = units.find(
    (unit) => unit.kind === "COURSE" && unit.id !== exceptId && unit.code && nameKey(unit.code) === nameKey(code),
  );
  if (clash) {
    throw new CollegeSetupError(
      `The code ${clash.code} is already used by ${clash.name}. Course codes are unique across the college.`,
    );
  }
}

export async function createCourse(
  actor: SessionUser,
  input: { departmentId: string; semesterId: string; code: string; name: string },
): Promise<{ courseId: string; name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  const code = validateCourseCode(input.code);
  const name = validateCourseName(input.name);

  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { semester } = await requireChain(tx, scope, {
      departmentId: input.departmentId,
      semesterId: input.semesterId,
    });
    const units = await repo.listCollegeUnits(tx, scope.institutionId);
    refuseDuplicateCourseCode(units, code);
    const siblings = units.filter((unit) => unit.kind === "COURSE" && unit.parentId === semester!.id);
    const course = await tx.academicUnit.create({
      data: {
        institutionId: scope.institutionId,
        campusId: actor.campusId ?? null,
        parentId: semester!.id,
        kind: "COURSE",
        name,
        code,
        sortOrder: siblings.reduce((max, unit) => Math.max(max, unit.sortOrder), -1) + 1,
      },
      select: { id: true },
    });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.created",
      entityType: "AcademicUnit",
      entityId: course.id,
      afterJson: { kind: "COURSE", name, code, parentId: semester!.id },
    });
    await courseSubject(tx, actor, scope.institutionId, { code, name });
    return { courseId: course.id, name };
  }, TX_OPTIONS);
}

/**
 * Renames a course or changes its code. Its subject follows, so registers and
 * the student portal show the new name; the session's section groups are
 * renamed where their name was the generated "CODE-A". Past sessions keep the
 * name they were taught under, which is what their registers print.
 */
export async function updateCourse(
  actor: SessionUser,
  input: { departmentId: string; semesterId: string; courseId: string; code: string; name: string; sessionId?: string },
): Promise<{ name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  const code = validateCourseCode(input.code);
  const name = validateCourseName(input.name);

  await prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { course } = await requireChain(tx, scope, {
      departmentId: input.departmentId,
      semesterId: input.semesterId,
      courseId: input.courseId,
    });
    if (course!.name === name && course!.code === code) {
      throw new CollegeSetupError("Nothing to change: the course is already called that.");
    }
    const units = await repo.listCollegeUnits(tx, scope.institutionId);
    refuseDuplicateCourseCode(units, code, course!.id);

    const oldCode = course!.code;
    const subject = oldCode ? await repo.findSubjectByCode(tx, scope.institutionId, oldCode) : null;
    if (oldCode === null || nameKey(oldCode) !== nameKey(code)) {
      const taken = await repo.findSubjectByCode(tx, scope.institutionId, code);
      if (taken && taken.id !== subject?.id) {
        throw new CollegeSetupError(
          `A subject with the code ${taken.code} already exists. Choose a different code for this course.`,
        );
      }
    }

    await tx.academicUnit.update({ where: { id: course!.id }, data: { name, code } });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: course!.id,
      beforeJson: { name: course!.name, code: oldCode },
      afterJson: { name, code },
    });
    if (subject) {
      await tx.subject.update({ where: { id: subject.id }, data: { code, name } });
      await audit(tx, actor, scope.institutionId, {
        action: "subject.updated",
        entityType: "Subject",
        entityId: subject.id,
        beforeJson: { code: subject.code, name: subject.name },
        afterJson: { code, name },
      });
    } else {
      await courseSubject(tx, actor, scope.institutionId, { code, name });
    }

    const session = input.sessionId ? await repo.getSession(tx, scope.institutionId, input.sessionId) : null;
    if (session?.isActive && oldCode) {
      const tree = buildTree(units);
      const groups = await repo.listSessionGroups(tx, scope.institutionId, session.id, sectionUnitIds(tree, [course!.id]));
      for (const group of groups) {
        const section = sectionNameOfGroup(tree, group);
        if (group.name !== sectionGroupName(oldCode, section)) continue;
        const next = sectionGroupName(code, section);
        await tx.cohort.update({ where: { id: group.id }, data: { name: next } });
        await audit(tx, actor, scope.institutionId, {
          action: "cohort.updated",
          entityType: "Cohort",
          entityId: group.id,
          beforeJson: { name: group.name },
          afterJson: { name: next },
        });
      }
    }
  }, TX_OPTIONS);
  return { name };
}

/** Removes a course set up by mistake — only while it has never had a section. */
export async function removeCourse(
  actor: SessionUser,
  input: { departmentId: string; semesterId: string; courseId: string },
): Promise<{ name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { course } = await requireChain(tx, scope, input);
    if (await repo.unitStillInUse(tx, course!.id)) {
      throw new CollegeSetupError(
        `${course!.name} has had sections, and a course that has been taught is kept. Its registers stay linked to it.`,
      );
    }
    await tx.academicUnit.delete({ where: { id: course!.id } });
    await audit(tx, actor, scope.institutionId, {
      action: "academic_unit.deleted",
      entityType: "AcademicUnit",
      entityId: course!.id,
      beforeJson: { kind: "COURSE", name: course!.name, code: course!.code, parentId: course!.parentId },
    });
    return { name: course!.name };
  }, TX_OPTIONS);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The SECTION unit a new group should hang off: the course's section of the
 * same name that is free this session, or a new one. Reusing it is what lets
 * PHY401-A in 2027–28 be recognisably the section it was in 2026–27.
 */
async function sectionUnitFor(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  input: { courseId: string; sessionId: string; name: string; sortOrder: number },
): Promise<string> {
  const existing = await tx.academicUnit.findMany({
    where: { institutionId, kind: "SECTION", parentId: input.courseId },
    select: { id: true, name: true, cohorts: { select: { academicSessionId: true } } },
  });
  const reusable = existing.find(
    (section) =>
      sameSectionName(section.name, input.name) &&
      !section.cohorts.some((group) => group.academicSessionId === input.sessionId),
  );
  if (reusable) return reusable.id;
  const created = await tx.academicUnit.create({
    data: {
      institutionId,
      campusId: actor.campusId ?? null,
      parentId: input.courseId,
      kind: "SECTION",
      name: input.name,
      sortOrder: input.sortOrder,
    },
    select: { id: true },
  });
  await audit(tx, actor, institutionId, {
    action: "academic_unit.created",
    entityType: "AcademicUnit",
    entityId: created.id,
    afterJson: { kind: "SECTION", name: input.name, parentId: input.courseId },
  });
  return created.id;
}

/** Makes `teacherId` the section's teacher: its class teacher and its course's teacher. */
async function linkTeacher(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  group: { id: string; subjects: { id: string; subjectId: string; facultyId: string | null }[] },
  courseSubjectId: string | null,
  teacherId: string,
  previousRole: string | null,
) {
  const link = await tx.cohortFaculty.upsert({
    where: { cohortId_userId: { cohortId: group.id, userId: teacherId } },
    create: { cohortId: group.id, userId: teacherId, role: "PRIMARY" },
    update: { role: "PRIMARY" },
    select: { id: true },
  });
  await audit(tx, actor, institutionId, {
    action: "cohort_faculty.assigned",
    entityType: "CohortFaculty",
    entityId: link.id,
    beforeJson: previousRole ? { role: previousRole } : undefined,
    afterJson: { cohortId: group.id, userId: teacherId, role: "PRIMARY" },
  });
  for (const subject of group.subjects) {
    if (subject.subjectId !== courseSubjectId || subject.facultyId === teacherId) continue;
    await tx.cohortSubject.update({ where: { id: subject.id }, data: { facultyId: teacherId } });
    await audit(tx, actor, institutionId, {
      action: "cohort_subject.faculty_assigned",
      entityType: "CohortSubject",
      entityId: subject.id,
      beforeJson: { facultyId: subject.facultyId },
      afterJson: { facultyId: teacherId },
    });
  }
}

/**
 * Adds sections to a course for a session — "A, B, C" in one go — each with
 * its course link and, optionally, its teacher. All or nothing.
 */
export async function addCourseSections(
  actor: SessionUser,
  input: {
    departmentId: string;
    semesterId: string;
    courseId: string;
    sessionId: string;
    sections: readonly { name: string; teacherId?: string }[];
  },
): Promise<{ sectionIds: string[]; names: string[] }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  const names = validateSectionNames(input.sections.map((section) => section.name));
  const teacherIds = input.sections.map((section) => section.teacherId?.trim() || null);

  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { course } = await requireChain(tx, scope, input);
    if (!course!.code) {
      throw new CollegeSetupError(`Give ${course!.name} a course code first: it is what its registers show.`);
    }
    const session = await requireOpenSessionById(tx, scope.institutionId, input.sessionId);

    const units = await repo.listCollegeUnits(tx, scope.institutionId);
    const tree = buildTree(units);
    const existing = await repo.listSessionGroups(tx, scope.institutionId, session.id, sectionUnitIds(tree, [course!.id]));
    if (existing.length + names.length > MAX_SECTIONS) {
      throw new CollegeSetupError(`A course can have at most ${MAX_SECTIONS} sections in a session.`);
    }
    for (const name of names) {
      const clash = existing.find((group) => sameSectionName(sectionNameOfGroup(tree, group), name));
      if (clash) {
        throw new CollegeSetupError(
          `${course!.name} already has ${sectionLabel(sectionNameOfGroup(tree, clash))} in ${session.name}.`,
        );
      }
    }
    const teachers = new Map<string, { id: string; name: string }>();
    for (const id of teacherIds) {
      if (id && !teachers.has(id)) teachers.set(id, await requireTeacher(tx, scope, id));
    }

    const subject = await courseSubject(tx, actor, scope.institutionId, { code: course!.code, name: course!.name });
    let nextOrder =
      childrenOf(tree, course!.id, "SECTION").reduce((max, unit) => Math.max(max, unit.sortOrder), -1) + 1;
    const sectionIds: string[] = [];
    for (const [index, name] of names.entries()) {
      const sectionUnitId = await sectionUnitFor(tx, actor, scope.institutionId, {
        courseId: course!.id,
        sessionId: session.id,
        name,
        sortOrder: nextOrder++,
      });
      const groupName = sectionGroupName(course!.code, name);
      const group = await tx.cohort.create({
        data: {
          institutionId: scope.institutionId,
          academicUnitId: sectionUnitId,
          academicSessionId: session.id,
          name: groupName,
        },
        select: { id: true },
      });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort.created",
        entityType: "Cohort",
        entityId: group.id,
        afterJson: { name: groupName, academicUnitId: sectionUnitId, academicSessionId: session.id },
      });
      const teacherId = teacherIds[index];
      const link = await tx.cohortSubject.create({
        data: { cohortId: group.id, subjectId: subject.id, facultyId: teacherId },
        select: { id: true, subjectId: true, facultyId: true },
      });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort_subject.attached",
        entityType: "CohortSubject",
        entityId: link.id,
        afterJson: { cohortId: group.id, subjectId: subject.id, facultyId: teacherId },
      });
      if (teacherId) {
        await linkTeacher(tx, actor, scope.institutionId, { id: group.id, subjects: [link] }, subject.id, teacherId, null);
      }
      sectionIds.push(group.id);
    }
    return { sectionIds, names };
  }, TX_OPTIONS);
}

interface SectionIds {
  departmentId: string;
  semesterId: string;
  courseId: string;
  sectionId: string;
}

/**
 * Renames a section for its session. A section name shared with another
 * session is moved onto a unit of the new name instead, so last session keeps
 * "A"; nothing that points at the group — students, registers, teachers —
 * moves.
 */
export async function renameCourseSection(
  actor: SessionUser,
  input: SectionIds & { name: string },
): Promise<{ name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  const name = validateSectionName(input.name);

  await prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { course } = await requireChain(tx, scope, input);
    const { group, session, sectionUnit } = await requireSectionOf(tx, scope, course!, input.sectionId);
    requireOpenSession(session);
    const oldName = sectionUnit?.name ?? group.name;
    if (oldName === name) throw new CollegeSetupError(`The section is already called ${name}.`);

    const tree = buildTree(await repo.listCollegeUnits(tx, scope.institutionId));
    const siblings = (
      await repo.listSessionGroups(tx, scope.institutionId, session.id, sectionUnitIds(tree, [course!.id]))
    ).filter((other) => other.id !== group.id);
    const clash = siblings.find((other) => sameSectionName(sectionNameOfGroup(tree, other), name));
    if (clash) {
      throw new CollegeSetupError(
        `${course!.name} already has ${sectionLabel(sectionNameOfGroup(tree, clash))} in ${session.name}.`,
      );
    }

    let sectionUnitId = group.academicUnitId;
    if (sectionUnit) {
      const shared = (await tx.cohort.count({ where: { academicUnitId: sectionUnit.id, id: { not: group.id } } })) > 0;
      if (shared) {
        sectionUnitId = await sectionUnitFor(tx, actor, scope.institutionId, {
          courseId: course!.id,
          sessionId: session.id,
          name,
          sortOrder: sectionUnit.sortOrder,
        });
      } else {
        await tx.academicUnit.update({ where: { id: sectionUnit.id }, data: { name } });
        await audit(tx, actor, scope.institutionId, {
          action: "academic_unit.updated",
          entityType: "AcademicUnit",
          entityId: sectionUnit.id,
          beforeJson: { name: oldName },
          afterJson: { name },
        });
      }
    }
    const generated = course!.code ? sectionGroupName(course!.code, oldName) : null;
    const nextGroupName =
      !sectionUnit ? name : group.name === generated && course!.code ? sectionGroupName(course!.code, name) : group.name;
    if (sectionUnitId !== group.academicUnitId || nextGroupName !== group.name) {
      await tx.cohort.update({ where: { id: group.id }, data: { name: nextGroupName, academicUnitId: sectionUnitId } });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort.updated",
        entityType: "Cohort",
        entityId: group.id,
        beforeJson: { name: group.name, academicUnitId: group.academicUnitId },
        afterJson: { name: nextGroupName, academicUnitId: sectionUnitId },
      });
    }
  }, TX_OPTIONS);
  return { name };
}

/**
 * Removes a section — only if nothing has happened in it (see
 * `sectionRemovalCheck`). Its course link and teacher go with it, and its
 * section name if no other session uses it.
 */
export async function removeCourseSection(
  actor: SessionUser,
  input: SectionIds,
): Promise<{ name: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  try {
    return await prisma.$transaction(async (tx) => {
      await repo.lockCollegeSetup(tx, scope.institutionId);
      const { course } = await requireChain(tx, scope, input);
      const { group, session, sectionUnit } = await requireSectionOf(tx, scope, course!, input.sectionId);
      const link = courseSubjectLink(group, course!.code);
      const check = sectionRemovalCheck(
        await repo.countSectionRemovalBlockers(tx, scope.institutionId, group.id, link?.subjectId ?? null),
        session,
      );
      const name = sectionUnit?.name ?? group.name;
      if (!check.allowed) {
        throw new CollegeSetupError(`${sectionLabel(name)} can't be removed. ${check.reasons.join(" ")}`);
      }

      for (const subject of group.subjects) {
        await tx.cohortSubject.delete({ where: { id: subject.id } });
      }
      for (const faculty of group.facultyLinks) {
        await tx.cohortFaculty.delete({ where: { id: faculty.id } });
        await audit(tx, actor, scope.institutionId, {
          action: "cohort_faculty.removed",
          entityType: "CohortFaculty",
          entityId: faculty.id,
          beforeJson: { cohortId: group.id, userId: faculty.user.id, role: faculty.role },
        });
      }
      await tx.cohort.delete({ where: { id: group.id } });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort.deleted",
        entityType: "Cohort",
        entityId: group.id,
        beforeJson: {
          name: group.name,
          section: name,
          course: course!.code,
          academicUnitId: group.academicUnitId,
          academicSessionId: session.id,
          sessionName: session.name,
          subjectIds: group.subjects.map((subject) => subject.subjectId),
        },
      });
      if (sectionUnit && !(await repo.unitStillInUse(tx, sectionUnit.id))) {
        await tx.academicUnit.delete({ where: { id: sectionUnit.id } });
        await audit(tx, actor, scope.institutionId, {
          action: "academic_unit.deleted",
          entityType: "AcademicUnit",
          entityId: sectionUnit.id,
          beforeJson: { kind: "SECTION", name, parentId: course!.id },
        });
      }
      return { name };
    }, TX_OPTIONS);
  } catch (error) {
    if (isForeignKeyRefusal(error)) {
      throw new CollegeSetupError(
        "Something was added to this section while it was being removed, so it has been kept. Reload the page to see what changed.",
      );
    }
    throw error;
  }
}

/**
 * Gives a section its teacher, or changes who it is: one teacher per section
 * here, the previous one's assignment removed in the same transaction.
 * Additional teachers set up on the Faculty page are left as they were.
 */
export async function setCourseSectionTeacher(
  actor: SessionUser,
  input: SectionIds & { teacherId: string },
): Promise<{ teacherName: string; replaced: string[] }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  if (input.teacherId.trim() === "") throw new CollegeSetupError("Choose a teacher.");

  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { course } = await requireChain(tx, scope, input);
    const { group, session } = await requireSectionOf(tx, scope, course!, input.sectionId);
    requireOpenSession(session);
    const teacher = await requireTeacher(tx, scope, input.teacherId);

    const primaries = group.facultyLinks.filter((link) => link.role === "PRIMARY");
    const others = primaries.filter((link) => link.user.id !== teacher.id);
    if (primaries.length > 0 && others.length === 0) {
      throw new CollegeSetupError(`${teacher.name} already teaches this section.`);
    }
    for (const link of others) {
      await tx.cohortFaculty.delete({ where: { id: link.id } });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort_faculty.removed",
        entityType: "CohortFaculty",
        entityId: link.id,
        beforeJson: { cohortId: group.id, userId: link.user.id, role: link.role },
      });
    }
    const existing = group.facultyLinks.find((link) => link.user.id === teacher.id);
    const courseLink = courseSubjectLink(group, course!.code);
    await linkTeacher(tx, actor, scope.institutionId, group, courseLink?.subjectId ?? null, teacher.id, existing?.role ?? null);
    return { teacherName: teacher.name, replaced: others.map((link) => link.user.name) };
  }, TX_OPTIONS);
}

export async function removeCourseSectionTeacher(
  actor: SessionUser,
  input: SectionIds,
): Promise<{ teacherName: string }> {
  const scope = await resolveCollegeScope(actor, STRUCTURE);
  return prisma.$transaction(async (tx) => {
    await repo.lockCollegeSetup(tx, scope.institutionId);
    const { course } = await requireChain(tx, scope, input);
    const { group, session } = await requireSectionOf(tx, scope, course!, input.sectionId);
    requireOpenSession(session);
    const primaries = group.facultyLinks.filter((link) => link.role === "PRIMARY");
    if (primaries.length === 0) throw new CollegeSetupError("This section has no teacher to remove.");
    for (const link of primaries) {
      await tx.cohortFaculty.delete({ where: { id: link.id } });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort_faculty.removed",
        entityType: "CohortFaculty",
        entityId: link.id,
        beforeJson: { cohortId: group.id, userId: link.user.id, role: link.role },
      });
    }
    const courseLink = courseSubjectLink(group, course!.code);
    if (courseLink?.facultyId) {
      await tx.cohortSubject.update({ where: { id: courseLink.id }, data: { facultyId: null } });
      await audit(tx, actor, scope.institutionId, {
        action: "cohort_subject.faculty_assigned",
        entityType: "CohortSubject",
        entityId: courseLink.id,
        beforeJson: { facultyId: courseLink.facultyId },
        afterJson: { facultyId: null },
      });
    }
    return { teacherName: primaries.map((link) => link.user.name).join(", ") };
  }, TX_OPTIONS);
}

/**
 * A new teacher's account, given this section — administrators only, since it
 * creates a login. The account comes from `inviteFaculty`, in the section's
 * department with the teaching role; if the section cannot then be assigned,
 * the password is still returned, because it is the only time it can be shown.
 */
export async function inviteTeacherForCourseSection(
  actor: SessionUser,
  input: SectionIds & { name: string; email: string; employeeCode?: string },
): Promise<{ invited: InvitedFaculty; assignError: string | null }> {
  const scope = await requireCollegeAdmin(actor, ["cohort.manage", "user.invite"]);
  const { department, course } = await requireChain(prisma, scope, input);
  const { session } = await requireSectionOf(prisma, scope, course!, input.sectionId);
  requireOpenSession(session);

  const invited = await inviteFaculty(actor, {
    name: input.name,
    email: input.email,
    employeeCode: input.employeeCode,
    departmentId: department.id,
    roleKey: repo.RESTORED_ROLE_KEY,
  });
  try {
    await setCourseSectionTeacher(actor, { ...input, teacherId: invited.member.id });
    return { invited, assignError: null };
  } catch (error) {
    return {
      invited,
      assignError:
        error instanceof CollegeSetupError
          ? error.message
          : "The account was created, but the section could not be assigned. Try assigning it again.",
    };
  }
}

// ---------------------------------------------------------------------------
// Students in a section
// ---------------------------------------------------------------------------

/** The section, checked to be the actor's to change, with its session open. */
async function requireWritableSection(actor: SessionUser, input: SectionIds) {
  const scope = await resolveCollegeScope(actor, ["enrollment.manage"]);
  const { course } = await requireChain(prisma, scope, input);
  const { group, session } = await requireSectionOf(prisma, scope, course!, input.sectionId);
  requireOpenSession(session);
  return { scope, group };
}

/**
 * Who the student and enrolment services see as the caller. An administrator
 * is passed through unchanged, so their own role's permissions decide; only a
 * head of department — already confined to this section — is lent the
 * permissions the one call needs.
 */
function callerFor(
  actor: SessionUser,
  scope: CollegeScope,
  permissions: Parameters<typeof delegate>[1],
): SessionUser {
  return scope.kind === "hod" ? delegate(actor, permissions) : actor;
}

/**
 * Admits a new student straight into this section, through the student
 * service — its validation, its duplicate-code check and its audit rows. The
 * only class the new student can be placed in is this section.
 */
export async function addNewStudentToSection(
  actor: SessionUser,
  ids: SectionIds,
  input: Omit<StudentInput, "cohortId" | "status">,
): Promise<Student> {
  const { scope, group } = await requireWritableSection(actor, ids);
  return createStudentForRequest(callerFor(actor, scope, ["student.create", "enrollment.manage"]), {
    ...input,
    cohortId: group.id,
  });
}

/**
 * Adds existing students to this section by student ID — a student already in
 * Physics A being added to Chemistry B, say. Each ID is reported: added, not
 * found, ambiguous, not on roll, or already here. Placement goes through the
 * enrolment service, the only writer of that table.
 *
 * An ID is matched the way student sign-in matches it: exactly as typed if a
 * student has it, otherwise ignoring case if exactly one student does. Codes
 * are unique only as written, so "CSE2601" and "cse2601" can be two people;
 * a guess between them is refused rather than made.
 */
export async function addStudentsToSection(
  actor: SessionUser,
  ids: SectionIds,
  rawCodes: string,
): Promise<{ added: string[]; skipped: string[] }> {
  const { scope, group } = await requireWritableSection(actor, ids);
  const codes = parseStudentCodes(rawCodes, MAX_STUDENT_CODES_AT_ONCE);
  const found = await repo.findStudentsByCodes(prisma, scope.institutionId, codes);
  const caller = callerFor(actor, scope, ["enrollment.manage"]);

  const added: string[] = [];
  const skipped: string[] = [];
  for (const code of codes) {
    const matches = found.filter((row) => nameKey(row.studentCode) === nameKey(code));
    if (matches.length === 0) {
      skipped.push(`No student has the ID ${code}.`);
      continue;
    }
    const student = pickByStudentCode(code, matches);
    if (!student) {
      skipped.push(`More than one student has an ID like ${code}. Enter it exactly as it is written.`);
      continue;
    }
    const label = `${student.firstName} ${student.lastName} (${student.studentCode})`.trim();
    if (student.status !== "ACTIVE") {
      skipped.push(`${label} is not on roll.`);
      continue;
    }
    const current = await repo.getEnrollmentStatus(prisma, student.id, group.id);
    if (current?.status === "ACTIVE") {
      skipped.push(`${label} is already in ${group.name}.`);
      continue;
    }
    await enrollStudentInCohortForRequest(caller, { studentId: student.id, cohortId: group.id });
    added.push(label);
  }
  return { added, skipped };
}

/**
 * Takes a student out of this section. Their registers in it are kept; the
 * enrolment is marked ended rather than deleted, by the enrolment service.
 */
export async function removeStudentFromSection(
  actor: SessionUser,
  ids: SectionIds,
  studentId: string,
): Promise<{ name: string }> {
  const { scope, group } = await requireWritableSection(actor, ids);
  const row = (await repo.listSectionStudents(prisma, [group.id])).find((entry) => entry.student.id === studentId);
  if (!row) throw new CollegeSetupError("That student is not in this section.");
  await unenrollStudentFromCohortForRequest(callerFor(actor, scope, ["enrollment.manage"]), {
    studentId: row.student.id,
    cohortId: group.id,
  });
  return { name: `${row.student.firstName} ${row.student.lastName}`.trim() };
}

