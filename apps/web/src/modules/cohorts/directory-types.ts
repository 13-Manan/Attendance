import type {
  AcademicUnitKind,
  CohortFacultyRole,
  EnrollmentStatus,
  InstitutionType,
} from "@prisma/client";

/**
 * Classes, as an administrator works with them.
 *
 * Separate from `types.ts`, which re-exports the Prisma `Cohort` row for the
 * attendance path. A row there is three foreign keys and a name; a row here is
 * the thing a head of year actually looks at — which year it belongs to, where
 * it sits in the structure, how many students are in it, who teaches it, and
 * how many subjects hang off it.
 *
 * ## One word, two institutions
 *
 * The domain object is a Cohort: the group a register is taken for. A school
 * calls it a class (8-A); a college calls it a section of a semester. The
 * shapes are identical because the attendance model is identical — what
 * differs is the wording and, at a college, the subjects attached to it. So
 * there is one module with `COHORT_WORDS` rather than two parallel ones that
 * would drift the first time either is fixed.
 */

export const MAX_COHORT_NAME = 120;
export const MAX_TERM_LABEL = 60;

/** What to call a cohort on screen, per institution type. */
export const COHORT_WORDS: Record<
  InstitutionType,
  { singular: string; plural: string; Singular: string; Plural: string }
> = {
  SCHOOL: { singular: "class", plural: "classes", Singular: "Class", Plural: "Classes" },
  COLLEGE: { singular: "section", plural: "sections", Singular: "Section", Plural: "Sections" },
};

export const COHORT_FACULTY_ROLE_LABEL: Record<CohortFacultyRole, string> = {
  PRIMARY: "Class teacher",
  ASSISTANT: "Additional teacher",
};

/** A member of staff attached to a cohort. */
export interface CohortTeacher {
  /** The `CohortFaculty` row, which is what a removal names. */
  linkId: string;
  userId: string;
  name: string;
  email: string;
  /** The account's own status — a stopped account still shows, and says so. */
  accountStatus: string;
  role: CohortFacultyRole;
}

/** A subject offered to a cohort, and who teaches it. College only. */
export interface CohortSubjectRow {
  /** The `CohortSubject` row, which is what a faculty assignment names. */
  cohortSubjectId: string;
  subjectId: string;
  code: string;
  name: string;
  facultyId: string | null;
  facultyName: string | null;
}

export interface CohortListRow {
  id: string;
  name: string;
  termLabel: string | null;
  createdAt: Date;
  academicUnitId: string;
  academicUnitName: string;
  academicUnitKind: AcademicUnitKind;
  academicUnitCode: string | null;
  /** Of the academic unit: a cohort has no campus of its own. */
  campusName: string | null;
  academicSessionId: string;
  academicSessionName: string;
  academicSessionIsCurrent: boolean;
  academicSessionStartDate: Date;
  /** On roll. A student who left the class is not counted, only kept. */
  studentCount: number;
  teachers: CohortTeacher[];
  subjectCount: number;
}

export interface CohortRosterEntry {
  enrollmentId: string;
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  status: EnrollmentStatus;
}

export interface CohortDetail extends CohortListRow {
  /** On roll now, by surname. */
  roster: CohortRosterEntry[];
  /** How many have left this class. Their registers are kept either way. */
  pastRosterCount: number;
  subjects: CohortSubjectRow[];
  /** Registers already taken for this cohort — what an edit must not rewrite. */
  attendanceSessionCount: number;
}

/** One page of the list, plus what the page needs to describe itself. */
export interface CohortPage {
  rows: CohortListRow[];
  /** Matching the current filters. */
  total: number;
  /** In the institution, ignoring the filters — "none yet" vs "no matches". */
  totalAll: number;
  /** In the current academic year, ignoring the filters. */
  currentYearAll: number;
  page: number;
  pageCount: number;
  pageSize: number;
}

export interface UnitChoice {
  id: string;
  name: string;
  kind: AcademicUnitKind;
  code: string | null;
  campusName: string | null;
}

export interface SessionChoice {
  id: string;
  name: string;
  isCurrent: boolean;
  isActive: boolean;
}

export interface StaffChoice {
  id: string;
  name: string;
  email: string;
}

export interface SubjectChoice {
  id: string;
  code: string;
  name: string;
}

/** The dropdowns the list, the form and the detail page need. */
export interface CohortFormOptions {
  units: UnitChoice[];
  sessions: SessionChoice[];
  staff: StaffChoice[];
  subjects: SubjectChoice[];
  institutionType: InstitutionType;
}

/** A refusal an administrator can act on. Never carries an internal detail. */
export class CohortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CohortError";
  }
}
