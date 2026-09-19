import type { EnrollmentStatus } from "@prisma/client";

/**
 * The student directory: the shapes an administrator works with.
 *
 * Separate from `types.ts` — which re-exports the Prisma `Student` row for the
 * attendance and integration paths — because nothing here is a database row. A
 * `StudentListRow` is a person plus where they are placed, assembled from four
 * tables, and the detail shape adds the history of those placements.
 *
 * `EnrollmentStatus` is reused rather than redefined: the same four values mean
 * the same four things on a `Student` and on an `Enrollment`, and a second enum
 * that had to be kept in step with the first is a bug waiting for the day
 * somebody adds a fifth.
 */

export const MAX_STUDENT_NAME = 120;
export const MAX_STUDENT_CODE = 40;
export const MAX_ADMISSION_NUMBER = 40;
export const MAX_STUDENT_EMAIL = 254;
export const MAX_STUDENT_PHONE = 32;

export type StudentStatus = EnrollmentStatus;

/**
 * Declared in the order the dropdown offers them, which is the order they
 * happen in: here now, then the three ways of not being here.
 */
export const STUDENT_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "TRANSFERRED",
  "COMPLETED",
] as const satisfies readonly StudentStatus[];

/**
 * A `Record` keyed by the enum rather than a lookup with a fallback: adding a
 * fifth status to the schema stops the build here, where somebody has to decide
 * what to call it, instead of rendering the raw `SUSPENDED` to a clerk.
 */
export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Archived",
  TRANSFERRED: "Transferred",
  COMPLETED: "Completed",
};

/**
 * What choosing each one means, for the form that changes it.
 *
 * "Archived" rather than "deleted" everywhere, because that is what happens: a
 * student who has left keeps every register they ever appeared in, and a
 * register that lost its students would stop being evidence of anything.
 */
export const STUDENT_STATUS_DESCRIPTION: Record<StudentStatus, string> = {
  ACTIVE: "Here now. Appears on class lists and in every register that is taken.",
  INACTIVE:
    "No longer attending. Kept, with all past attendance intact, and left off new class lists.",
  TRANSFERRED: "Left for another institution. Kept the same way an archived student is.",
  COMPLETED: "Finished their programme. Kept, and not offered for new classes.",
};

/** True when a student in this status should appear on new class lists. */
export function isStudentOnRoll(status: StudentStatus): boolean {
  return status === "ACTIVE";
}

/** A class a student is, or was, placed in. */
export interface StudentClassLink {
  /** The `Enrollment` row, which is what a removal names. */
  enrollmentId: string;
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  academicSessionId: string;
  academicSessionName: string;
  /** Whether that year is the institution's current one. */
  academicSessionIsCurrent: boolean;
  status: EnrollmentStatus;
  enrolledAt: Date;
  unenrolledAt: Date | null;
}

export interface StudentListRow {
  id: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  admissionNumber: string | null;
  admissionDate: Date | null;
  status: StudentStatus;
  campusId: string | null;
  campusName: string | null;
  /** Only the placements that are still current. The detail view has the rest. */
  classes: StudentClassLink[];
}

export interface StudentDetail extends StudentListRow {
  createdAt: Date;
  updatedAt: Date;
  /** Every placement, current and past, newest first. */
  allClasses: StudentClassLink[];
  /**
   * How many face samples are on file, and how many of those are still in use.
   *
   * A count, never an embedding. Nothing on this path reads the vector itself —
   * the directory needs to answer "is this student enrolled for recognition?"
   * and that question is answered by a number.
   */
  faceSampleCount: number;
  activeFaceSampleCount: number;
}

/** One page of the directory, plus what the page needs to describe itself. */
export interface StudentPage {
  rows: StudentListRow[];
  /** Matching the current filters. */
  total: number;
  /** In the institution, ignoring the filters — "no students" vs "no matches". */
  totalAll: number;
  /** On roll in the institution, ignoring the filters. */
  activeAll: number;
  /** The page actually shown, which may be clamped down from the one asked for. */
  page: number;
  pageCount: number;
  pageSize: number;
}

/** A class to place a student in. */
export interface CohortChoice {
  id: string;
  name: string;
  termLabel: string | null;
  academicSessionId: string;
  academicSessionName: string;
  academicSessionIsCurrent: boolean;
}

export interface CampusChoice {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
}

/** The dropdowns the directory and its forms need. */
export interface StudentFormOptions {
  campuses: CampusChoice[];
  cohorts: CohortChoice[];
}

/** A refusal an administrator can act on. Never carries an internal detail. */
export class StudentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudentError";
  }
}
