/**
 * College academic setup: the shapes the college screens work with.
 *
 * Nothing here is a new database concept. A college's structure is already
 * stored as the schema's college branch of the academic tree (see the note
 * above `AcademicUnit` in schema.prisma):
 *
 *   AcademicSession               — the academic session, e.g. 2026–27
 *   AcademicUnit (DEPARTMENT)     — "Computer Science", code CSE
 *   AcademicUnit (SEMESTER)       — "4th Semester", under a department
 *   AcademicUnit (COURSE)         — "PHY401 Physics", under a semester
 *   Subject (same code)           — what a register and a student's portal
 *                                   call that course
 *   AcademicUnit (SECTION)        — "A", under a course, reused session on session
 *   Cohort (section unit+session) — that section in one session: what a
 *                                   register, an enrolment and a teacher attach to
 *   CohortSubject                 — the section's course, and who teaches it
 *   CohortFaculty (PRIMARY)       — the same teacher, so the section appears on
 *                                   their Attendance page
 *   Enrollment                    — a student in a section; a student takes
 *                                   several courses, so has several
 *
 * The Head of Department is a staff account holding the HOD role, whose
 * `User.departmentId` is the department and whom the department names in its
 * `metadata.headUserId`. The department's current semester is
 * `metadata.currentSemesterId`. Neither needs a column.
 *
 * The words "unit", "cohort" and "enrollment" never reach the screen from here.
 */

export class CollegeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollegeSetupError";
  }
}

/** Shared with `AcademicUnit.name`'s other uses. */
export const MAX_DEPARTMENT_NAME = 120;
/** "CSE", "ECE", "MECH" — short enough to read in a table column. */
export const MAX_DEPARTMENT_CODE = 16;
export const MAX_SEMESTER_NAME = 60;
/** Ten-semester (five-year) programmes exist; twelve leaves headroom and refuses a typo. */
export const MAX_SEMESTER_NUMBER = 12;
export const MAX_COURSE_NAME = 120;
/** `Subject.code`'s practical length: "PHY401", "CS-301L", "MA 1011". */
export const MAX_COURSE_CODE = 20;
export const MAX_SECTION_NAME = 40;
/** Per course, per session. A large intake runs to ten or so; thirty refuses "300". */
export const MAX_SECTIONS = 30;
/** Students one "add by student ID" box accepts at once. */
export const MAX_STUDENT_CODES_AT_ONCE = 50;

/**
 * Who is looking, as the college service resolved it — never as the browser
 * described it. An administrator (`academicStructure.manage`) reaches every
 * department of their college; a head of department reaches exactly one.
 */
export type CollegeScope =
  | { kind: "admin"; institutionId: string }
  | { kind: "hod"; institutionId: string; departmentId: string };

export interface SessionChoice {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  /** False once archived: an archived session is shown as it was and can't be changed. */
  isActive: boolean;
}

export type SectionStatus = "ready" | "needs_teacher" | "teacher_inactive";

export const SECTION_STATUS_LABEL: Record<SectionStatus, string> = {
  ready: "Ready",
  needs_teacher: "Needs teacher",
  teacher_inactive: "Teacher can't sign in",
};

export type CourseStatus = "no_sections" | "needs_teacher" | "ready";

export const COURSE_STATUS_LABEL: Record<CourseStatus, string> = {
  no_sections: "No sections",
  needs_teacher: "Needs teacher",
  ready: "Ready",
};

export interface DepartmentRef {
  id: string;
  name: string;
  code: string | null;
}

export interface SemesterRef {
  id: string;
  name: string;
  /** The semester's place in the programme, 1–12; what the list is ordered by. */
  number: number;
}

export interface CourseRef {
  id: string;
  code: string | null;
  name: string;
}

/** A person as a list shows them. Never a password, a hash or a token. */
export interface StaffChoice {
  id: string;
  name: string;
  email: string;
  /** Whether they belong to the department being worked on. */
  inDepartment: boolean;
}

export interface HeadOfDepartment {
  userId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  status: "ACTIVE" | "INACTIVE";
  lastLoginAt: Date | null;
  /**
   * Whether the three facts that make someone this department's head still
   * agree: the department names them, their department is this one, and they
   * hold the HOD role. When they do not — their department was changed on the
   * Faculty page, say — the scope check refuses them everywhere, and the
   * department page says so rather than showing a head who cannot act.
   */
  consistent: boolean;
}

export interface DepartmentSummary extends DepartmentRef {
  hod: { name: string; status: "ACTIVE" | "INACTIVE"; consistent: boolean } | null;
  semesters: number;
  courses: number;
  /** Sections of the chosen session. */
  sections: number;
  faculty: number;
  /** Distinct students in the department's sections in the chosen session. */
  students: number;
}

export interface DepartmentsOverview {
  institutionName: string;
  session: SessionChoice | null;
  sessions: SessionChoice[];
  departments: DepartmentSummary[];
}

export interface SemesterRow extends SemesterRef {
  code: string | null;
  isCurrent: boolean;
  courses: number;
  /** In the chosen session. */
  sections: number;
  students: number;
}

export interface DepartmentDetail extends DepartmentRef {
  hod: HeadOfDepartment | null;
  session: SessionChoice | null;
  sessions: SessionChoice[];
  semesters: SemesterRow[];
  currentSemesterId: string | null;
  counts: { semesters: number; courses: number; sections: number; faculty: number; students: number };
  /** Staff who could be made head: active, able to teach, not an administrator, not heading elsewhere. */
  hodCandidates: StaffChoice[];
}

export interface SectionTeacher {
  userId: string;
  name: string;
  active: boolean;
}

export interface SectionRow {
  /** The section in this session (a `Cohort`). Every action on a section names this. */
  id: string;
  /** What the college calls it: "A". */
  name: string;
  /**
   * How a screen names it: "Section A" — or, for a class group set up on the
   * older screens and hung straight off the course, that group's own name.
   */
  label: string;
  /** The name registers and reports show: "PHY401-A". */
  groupName: string;
  teacher: SectionTeacher | null;
  studentCount: number;
  status: SectionStatus;
}

export interface CourseRow extends CourseRef {
  semester: SemesterRef;
  department: DepartmentRef;
  sections: SectionRow[];
  studentCount: number;
  status: CourseStatus;
}

export interface SemesterDetail extends SemesterRef {
  code: string | null;
  isCurrent: boolean;
  department: DepartmentRef;
  session: SessionChoice | null;
  sessions: SessionChoice[];
  courses: CourseRow[];
}

export interface CourseDetail extends CourseRef {
  department: DepartmentRef;
  semester: SemesterRef;
  session: SessionChoice | null;
  sessions: SessionChoice[];
  sections: SectionRow[];
  teachers: StaffChoice[];
  /** False when the course has no code yet, so no section can carry it onto a register. */
  canHaveSections: boolean;
}

export interface SectionStudent {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  /** Whether a face template the running model can compare exists — the "enrolled" of the face screens. */
  faceEnrolled: boolean;
  hasLogin: boolean;
}

export interface RemovalCheck {
  allowed: boolean;
  /** Every reason removal is blocked, in words, so all of them can be fixed at once. */
  reasons: string[];
}

export interface CourseSectionDetail {
  department: DepartmentRef;
  semester: SemesterRef;
  course: CourseRef;
  session: SessionChoice;
  section: SectionRow;
  students: SectionStudent[];
  teachers: StaffChoice[];
  /** Other students of this department's sections this session, to add from a list. */
  departmentStudents: { id: string; studentCode: string; name: string }[];
  removal: RemovalCheck;
}

export interface DepartmentStudentRow {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  faceEnrolled: boolean;
  hasLogin: boolean;
  /** "PHY401-A" and where it lives, for each of this department's sections they are in. */
  sections: {
    sectionId: string;
    groupName: string;
    courseId: string;
    semesterId: string;
  }[];
}

export interface DepartmentStudents {
  department: DepartmentRef;
  session: SessionChoice | null;
  sessions: SessionChoice[];
  /** The department's courses, for the course filter. */
  courses: CourseRef[];
  students: DepartmentStudentRow[];
  /** More matched than are listed; the search box narrows it. */
  truncated: boolean;
}

export interface DepartmentFacultyRow {
  userId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  status: "ACTIVE" | "INACTIVE";
  isHead: boolean;
  /** Whether this person's department is this one, or they only teach one of its sections. */
  member: boolean;
  sections: { sectionId: string; groupName: string; courseId: string; semesterId: string }[];
}

export interface DepartmentFaculty {
  department: DepartmentRef;
  session: SessionChoice | null;
  sessions: SessionChoice[];
  faculty: DepartmentFacultyRow[];
}

export interface CollegeHome {
  institutionName: string;
  department: DepartmentRef;
  session: SessionChoice | null;
  currentSemester: SemesterRef | null;
  counts: { semesters: number; courses: number; sections: number; faculty: number; students: number };
  /** Sections this session with no teacher, for the "needs attention" line. */
  sectionsNeedingTeacher: number;
}

/** A section the add-student page is placing a new student in, with where it sits. */
export interface SectionPlacement {
  department: DepartmentRef;
  semester: SemesterRef;
  course: CourseRef;
  session: SessionChoice;
  section: { id: string; name: string; label: string; groupName: string };
}
