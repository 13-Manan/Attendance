/**
 * School academic setup: the shapes the Classes screens work with.
 *
 * Nothing here is a new database concept. A school's structure is already
 * stored as
 *
 *   AcademicSession            — the academic year
 *   AcademicUnit (GRADE)       — a class, e.g. "Class 8"
 *   AcademicUnit (SECTION)     — a section under it, e.g. "A", reused year on year
 *   Cohort (section unit+year) — that section in one academic year; what a
 *                                register, an enrolment and a teacher attach to
 *   CohortFaculty (PRIMARY)    — the section's teacher
 *
 * and this module only presents it in those words. The words "unit", "cohort"
 * and "enrollment" never reach the screen from here.
 */

export class SchoolSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchoolSetupError";
  }
}

/** A class name and a section name share the limit `AcademicUnit.name` already has. */
export const MAX_CLASS_NAME = 120;
export const MAX_SECTION_NAME = 40;

/**
 * Enough for any real school — the largest single-grade intakes run to about
 * twenty sections — and small enough that a mistyped "100" is refused rather
 * than creating a hundred sections in one transaction.
 */
export const MAX_SECTIONS = 30;

export type SectionStatus = "ready" | "needs_teacher" | "teacher_inactive";

export const SECTION_STATUS_LABEL: Record<SectionStatus, string> = {
  ready: "Ready",
  needs_teacher: "Needs teacher",
  teacher_inactive: "Teacher can't sign in",
};

export interface SectionTeacher {
  /** The `CohortFaculty` row, which is what "remove teacher" names. */
  linkId: string;
  userId: string;
  name: string;
  active: boolean;
}

export interface SectionRow {
  /** The section-in-this-year (a `Cohort`). Every action on a section names this. */
  id: string;
  /** What the school calls the section: "A", "Rose", "Science". */
  name: string;
  /** The full group name shown elsewhere in the product: "8-A". */
  groupName: string;
  teacher: SectionTeacher | null;
  /** Additional teachers set up from the Faculty page; shown, not managed, here. */
  otherTeachers: SectionTeacher[];
  /** Students currently in the section. */
  studentCount: number;
  status: SectionStatus;
}

export interface YearChoice {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  /** False once archived: an archived year is read-only on these screens. */
  isActive: boolean;
}

export interface ClassSummary {
  /** The class (a GRADE `AcademicUnit`). */
  id: string;
  name: string;
  sections: SectionRow[];
  studentCount: number;
  needsTeacher: number;
}

/** A class that exists from an earlier year but has no sections this year. */
export interface ClassNotSetUp {
  id: string;
  name: string;
  /** The section names it used before, offered as the starting point. */
  sectionNames: string[];
}

export interface ClassesOverview {
  institutionName: string;
  year: YearChoice | null;
  years: YearChoice[];
  classes: ClassSummary[];
  notSetUp: ClassNotSetUp[];
  /**
   * Groups in this year that do not sit under a class in the usual way —
   * set up by hand on the older screens. Counted so the page can say they
   * exist rather than silently leaving them out.
   */
  otherGroups: number;
}

export interface StaffChoice {
  id: string;
  name: string;
  email: string;
}

export interface ClassDetail {
  id: string;
  name: string;
  year: YearChoice;
  years: YearChoice[];
  sections: SectionRow[];
  teachers: StaffChoice[];
}

export interface RemovalCheck {
  allowed: boolean;
  /** Every reason removal is blocked, in words, so all of them can be fixed at once. */
  reasons: string[];
}

export interface SectionDetail {
  classId: string;
  className: string;
  year: YearChoice;
  section: SectionRow;
  /** Whether this section's name is also used by the class in another year. */
  sharedAcrossYears: boolean;
  /** How many sections the class has in this year, this one included. */
  sectionsInYear: number;
  teachers: StaffChoice[];
  removal: RemovalCheck;
}

export interface NewClassContext {
  /** Null when the school has no open academic year to add a class to. */
  year: YearChoice | null;
  years: YearChoice[];
  teachers: StaffChoice[];
  /** Set when an existing class is being set up for this year. */
  from: ClassNotSetUp | null;
}

export interface NewSectionInput {
  name: string;
  /** Optional: a teacher can be chosen now or later. */
  teacherId?: string;
}

export interface CreatedClass {
  classId: string;
  sectionIds: string[];
}
