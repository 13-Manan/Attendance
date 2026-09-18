/**
 * The faculty directory: the shapes an administrator works with.
 *
 * Separate from `types.ts` — which exports the Prisma `User` row under the
 * name `Faculty` for the attendance path — because nothing here is a database
 * row. A `FacultyMember` is a person plus what they teach plus whether they
 * can sign in, assembled from four tables, and it deliberately has no field
 * that could carry a credential.
 */

export const MAX_FACULTY_NAME = 120;
export const MAX_EMPLOYEE_CODE = 40;
export const MAX_EMAIL = 254;

/**
 * The roles this screen may grant.
 *
 * A subset of the seeded system roles, and deliberately not all of them: an
 * administrator inviting a colleague must not be able to hand out
 * INSTITUTION_ADMIN — or, worse, PLATFORM_SUPER_ADMIN — from the screen they
 * use to add a chemistry teacher. Promoting someone to an administrator is a
 * different decision with a different blast radius, and this build does not
 * offer it here rather than offering it with a warning nobody reads.
 *
 * STUDENT is absent for the same reason in the other direction: a student
 * account is created by student administration, where it is linked to a
 * Student record, not here where it would be a login attached to nothing.
 */
export const FACULTY_ROLE_KEYS = ["FACULTY", "CLASS_TEACHER", "ATTENDANCE_OPERATOR"] as const;

export type FacultyRoleKey = (typeof FACULTY_ROLE_KEYS)[number];

/**
 * What each role means in a sentence, for the invite form.
 *
 * The role names themselves are editable per institution (`Role.name`), so
 * these describe the *capability*, which is not editable, rather than
 * repeating a label the institution may have renamed.
 */
export const FACULTY_ROLE_DESCRIPTIONS: Record<FacultyRoleKey, string> = {
  FACULTY:
    "Teaches classes: opens a register, runs capture, confirms the result and corrects a mark.",
  CLASS_TEACHER:
    "A teacher who also owns a class: everything above, plus enrolling students and editing their records.",
  ATTENDANCE_OPERATOR:
    "Runs capture for someone else's class. Cannot confirm a register or change a mark — the faculty member who taught it does that.",
};

/** A class this person is the teacher of. */
export interface FacultyClassLink {
  /** The `CohortFaculty` row, which is what a removal names. */
  linkId: string;
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  /** PRIMARY = class teacher / lead faculty; ASSISTANT = additional teacher. */
  role: string;
}

/** A subject this person teaches within a class. */
export interface FacultySubjectLink {
  /** The `CohortSubject` row, which is what an assignment names. */
  cohortSubjectId: string;
  cohortId: string;
  cohortName: string;
  subjectCode: string;
  subjectName: string;
}

export interface FacultyMember {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
  status: "ACTIVE" | "INACTIVE";
  lastLoginAt: Date | null;
  /**
   * Whether a password has been set. Derived from a separate query that
   * selects only ids — see `directory-repository.ts`. The hash itself is never
   * read into this process by anything on this path.
   */
  canSignIn: boolean;
  roleKeys: string[];
  classes: FacultyClassLink[];
  subjects: FacultySubjectLink[];
}

/** A class-subject pairing, for the assignment control. */
export interface CohortSubjectOption {
  cohortSubjectId: string;
  cohortId: string;
  cohortName: string;
  subjectCode: string;
  subjectName: string;
  facultyId: string | null;
  facultyName: string | null;
}

export interface CohortOption {
  id: string;
  name: string;
  termLabel: string | null;
}

export interface FacultyDirectory {
  members: FacultyMember[];
  cohorts: CohortOption[];
  cohortSubjects: CohortSubjectOption[];
}

/**
 * A temporary password, returned once by the call that set it.
 *
 * Not stored in a readable form, not audited, not logged. The notice is
 * carried alongside the value so every screen that shows one says the same
 * thing about it.
 */
export interface IssuedPassword {
  password: string;
  notice: string;
}

/**
 * Says what is true of this build, not what is usually true of a password.
 *
 * There is no self-service password change yet, so the notice does not tell an
 * administrator to ask for one. What it tells them is the thing that is
 * actually available: if this value is lost or shared, issue a new one here,
 * which invalidates the old one.
 */
export const TEMP_PASSWORD_NOTICE =
  "Copy this now — it is shown once and cannot be recovered. Hand it over in person or by a " +
  "channel you trust, not in a shared inbox. If it is lost or seen by anyone else, issue a new " +
  "one from this screen: doing so stops the old one working immediately.";

/** A refusal an administrator can act on. Never carries an internal detail. */
export class FacultyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacultyError";
  }
}
