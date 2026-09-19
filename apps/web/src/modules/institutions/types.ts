import type { Institution } from "@prisma/client";

export type { Institution };

/** Shape of Institution.settings.academicUnitLabels — UI labels per AcademicUnitKind. */
export interface AcademicUnitLabels {
  DEPARTMENT: string;
  GRADE: string;
  SEMESTER: string;
  COURSE: string;
  SECTION: string;
  GENERIC: string;
}

/**
 * The wording a school gets before anybody customises it.
 *
 * In `types.ts` rather than beside its resolver in `service.ts` for the reason
 * spelled out under `DEFAULT_LOW_ATTENDANCE_THRESHOLD` below: this file
 * imports nothing but a type, so a form, a component or a pure policy module
 * can compare against the defaults without dragging Prisma into the bundle or
 * into the test runner. `service.ts` re-exports it, so existing import paths
 * are unchanged.
 */
export const DEFAULT_ACADEMIC_UNIT_LABELS: AcademicUnitLabels = {
  DEPARTMENT: "Department",
  GRADE: "Grade",
  SEMESTER: "Semester",
  COURSE: "Course",
  SECTION: "Section",
  GENERIC: "Group",
};

/** The keys of `AcademicUnitLabels`, in the order a form should show them. */
export const ACADEMIC_UNIT_LABEL_KEYS = [
  "DEPARTMENT",
  "GRADE",
  "SEMESTER",
  "COURSE",
  "SECTION",
  "GENERIC",
] as const;

export interface ConfidenceThresholds {
  /** aiConfidence >= presentMin => PRESENT */
  presentMin: number;
  /** reviewMin <= aiConfidence < presentMin => NEEDS_REVIEW; below reviewMin => ABSENT */
  reviewMin: number;
}

/**
 * DAILY = school-style one attendance session per class per day
 * (AttendanceSession.cohortSubjectId is null). SUBJECT_WISE = college-style
 * subject/lecture-specific sessions (cohortSubjectId is required). One
 * attendance engine, branching on this configuration value plus the
 * presence of cohortSubjectId — never two parallel models. See
 * ARCHITECTURE.md and CohortSubject's doc comment in schema.prisma.
 */
export type AttendanceMode = "DAILY" | "SUBJECT_WISE";

export interface InstitutionSettings {
  academicUnitLabels?: Partial<AcademicUnitLabels>;
  confidenceThresholds?: Partial<ConfidenceThresholds>;
  attendanceMode?: AttendanceMode;
  /**
   * Percentage below which a student is listed as low attendance, e.g. 75.
   *
   * Configurable because the number is an institutional policy, not a
   * property of this software — 75% is common in Indian higher education and
   * is the default, but it is not universal and several boards use 80% or a
   * per-subject rule. Resolved in exactly one place,
   * `resolveLowAttendanceThreshold`, so the figure is never written into a
   * query, a component, or a report heading.
   */
  lowAttendanceThreshold?: number;
}

/**
 * The fallback low-attendance threshold, as a percentage.
 *
 * This is the *only* literal 75 in the codebase. Everything that needs the
 * figure — the admin report, the low-attendance export, a progress bar on a
 * portal card — reaches it through `resolveLowAttendanceThreshold` or through
 * this constant, so an institution that runs an 80% rule changes one settings
 * value and every surface agrees.
 *
 * It lives in `types.ts` rather than beside its resolver in `service.ts`
 * because presentational components need it too, and this file imports
 * nothing but a type — importing the service into a component would drag
 * Prisma into the client bundle.
 */
export const DEFAULT_LOW_ATTENDANCE_THRESHOLD = 75;
