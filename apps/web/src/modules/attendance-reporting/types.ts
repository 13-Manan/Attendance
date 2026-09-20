import type { AttendanceResult } from "@/modules/attendance/types";
import type { AttendanceRate } from "@/modules/attendance-analytics/types";
import type { AttendanceMode } from "@/modules/institutions/types";

export type { AttendanceMode, AttendanceRate, AttendanceResult };

/**
 * Phase 8 reporting.
 *
 * Read-only, like `attendance-analytics`, and for the same reason: a report
 * that can write is a report that can be argued with. The difference between
 * the two modules is *where the arithmetic happens*. The portals in Phase 7
 * aggregate one student's or one class's rows in JavaScript, which is correct
 * at that size. Institution-wide reporting cannot: measured on a seeded
 * 482,760-record institution, fetching the window's rows to roll them up in
 * Node took 5.5 s and 238 MB, while the same answer aggregated in SQL took
 * 29 ms (see `scripts/report-bench/`). Everything here therefore returns
 * rollups and pages, never raw result sets.
 */

/**
 * What a report groups by.
 *
 * The five academic-unit dimensions — `department`, `semester`, `course`,
 * `grade`, `section` — are one implementation, parameterized by
 * `AcademicUnitKind`. School "class-wise" is `grade`, school "section-wise"
 * is `section`, college "course-wise" is `course`; they are different levels
 * of the same tree rather than different reports, which is why the schema
 * models them as one self-referencing table.
 */
export type ReportDimension =
  | "cohort"
  | "department"
  | "semester"
  | "course"
  | "grade"
  | "section"
  | "subject"
  | "faculty"
  | "student"
  | "day"
  | "month";

export const REPORT_DIMENSIONS: readonly ReportDimension[] = [
  "cohort",
  "department",
  "semester",
  "course",
  "grade",
  "section",
  "subject",
  "faculty",
  "student",
  "day",
  "month",
] as const;

export function isReportDimension(value: string): value is ReportDimension {
  return (REPORT_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Report filters, after validation.
 *
 * `from`/`to` are a half-open UTC range `[from, to)` — the same day boundary
 * the attendance engine uses to decide which calendar day a session belongs
 * to. A report is always bounded by one; there is no "all time" option,
 * because an unbounded institution-wide scan is not a report, it is an
 * incident.
 */
export interface ReportFilters {
  from: Date;
  to: Date;
  /** Explicit classes. */
  cohortIds?: string[];
  /**
   * Any level of the academic tree. A cohort matches when the selected unit
   * is the cohort's unit *or any of its ancestors*, so filtering on "Grade 8"
   * includes 8A, 8B and 8C without the caller enumerating them.
   */
  academicUnitIds?: string[];
  subjectIds?: string[];
  facultyIds?: string[];
  studentIds?: string[];
  /**
   * Attendance status. Applies to the **record listing only**, never to the
   * rollups: a percentage computed over "the absent rows" is 0% by
   * construction, which is a false statement rather than a filtered one.
   */
  results?: AttendanceResult[];
}

export interface ReportPageRequest {
  page: number;
  pageSize: number;
}

export interface ReportPage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  /** Total matching groups (or records), before paging. */
  totalRows: number;
  hasMore: boolean;
}

/** One row of a rollup, whatever it was grouped by. */
export interface ReportRollupRow {
  key: string;
  label: string;
  sublabel: string | null;
  rate: AttendanceRate;
  /**
   * Registers that contributed. Null for the `student` dimension, where the
   * count of sessions a student sat is already `rate.total` and a separate
   * figure would invite two different answers to the same question.
   */
  sessionCount: number | null;
  /**
   * Rows still awaiting a human decision. Always 0 for a finalized-only
   * report; carried so a caller can prove that rather than assume it.
   */
  unresolved: number;
}

/** One attendance record, flat, for history and raw export. */
export interface ReportRecordRow {
  attendanceRecordId: string;
  sessionId: string;
  sessionDate: string;
  studentId: string;
  studentCode: string;
  studentName: string;
  cohortName: string;
  subjectName: string | null;
  subjectCode: string | null;
  facultyName: string | null;
  result: AttendanceResult;
  isManuallyCorrected: boolean;
}

export interface LowAttendanceRow {
  studentId: string;
  studentCode: string;
  studentName: string;
  cohortName: string;
  rate: AttendanceRate;
}

/** The headline block on the admin report. */
export interface InstitutionOverview {
  /**
   * Whose figures these are. "assigned" means every number on the page is
   * restricted to the classes and subjects the viewer teaches — which has to
   * be stated, because "82% attendance" reads as an institution's figure
   * unless something says otherwise.
   */
  scope: "institution" | "assigned";
  institutionId: string;
  institutionName: string;
  attendanceMode: AttendanceMode;
  windowStart: string;
  windowEnd: string;
  /** Every enrolled student, not only those with attendance in the window. */
  totalStudents: number;
  totalCohorts: number;
  finalizedSessions: number;
  sessionsAwaitingReview: number;
  /** Across the whole window. */
  overall: AttendanceRate;
  /** Confirmed registers for the current UTC day only. */
  today: AttendanceRate;
  /** Sessions held today whose register is not confirmed yet. */
  todayAwaitingConfirmation: number;
  lowAttendanceThreshold: number;
  lowAttendanceCount: number;
}

export type ExportFormat = "csv" | "xlsx";

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}
