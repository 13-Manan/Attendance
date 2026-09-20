import type { AttendanceResult, CorrectionSource } from "@/modules/attendance/types";
import type { AttendanceMode } from "@/modules/institutions/types";
import type { SessionStatus } from "@/modules/sessions/types";

export type { AttendanceMode, AttendanceResult };

/**
 * Phase 7 read models.
 *
 * Everything in this module is **read-only**. It aggregates attendance that
 * Phase 6 already wrote and a faculty member already confirmed; it has no
 * mutation path of its own. The student portal in particular must be unable
 * to alter attendance — the way that is guaranteed is that there is nothing
 * here to call.
 */

/**
 * An attendance percentage that is allowed to not exist.
 *
 * `percentage` is null when `total` is 0. A student who has not had a class
 * yet has *no* attendance percentage; rendering that as "0%" would tell them
 * they missed everything. Same reasoning as the recognition engine's refusal
 * to show a null confidence as 0%.
 *
 * The denominator counts only **decided** results (PRESENT + ABSENT) from
 * **finalized** sessions. Finalization already blocks unresolved rows, so in
 * practice nothing else reaches here; the filter is defence in depth, so a
 * NEEDS_REVIEW row could never silently depress somebody's percentage.
 */
export interface AttendanceRate {
  present: number;
  absent: number;
  total: number;
  percentage: number | null;
}

/** One finalized class from a student's point of view. */
export interface StudentAttendanceItem {
  attendanceRecordId: string;
  sessionId: string;
  /** ISO-8601; the calendar date of the class. */
  sessionDate: string;
  result: AttendanceResult;
  isManuallyCorrected: boolean;
  cohortName: string;
  subjectName: string | null;
  subjectCode: string | null;
}

/** COLLEGE: "Database Management — Present 18 / Total 22 / 81.8%". */
export interface SubjectAttendanceSummary {
  cohortSubjectId: string;
  subjectName: string;
  subjectCode: string;
  facultyName: string | null;
  rate: AttendanceRate;
}

/** SCHOOL: "September 15 — Present". */
export interface DailyAttendanceSummary {
  sessionDate: string;
  cohortName: string;
  result: AttendanceResult;
  attendanceRecordId: string;
  isManuallyCorrected: boolean;
}

/**
 * Where a student actually sits: class, section/department, academic year.
 *
 * The portal could state a percentage before it could state what the
 * percentage was of. This is the other half of that sentence.
 */
export interface StudentEnrollmentContext {
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  /** The academic unit the class hangs off — a section, a department. */
  academicUnitName: string | null;
  academicSessionName: string | null;
  /** True when this is the institution's current academic year. */
  isCurrentSession: boolean;
}

/**
 * One calendar month of the student's own attendance.
 *
 * A trend, not a forecast. Months in which the student had no class are
 * omitted rather than plotted as zero — the same rule `AttendanceRate`
 * already applies to a null percentage, for the same reason.
 */
export interface AttendanceTrendPoint {
  /** `YYYY-MM`, UTC, so it sorts lexicographically. */
  month: string;
  label: string;
  rate: AttendanceRate;
}

export interface StudentDashboard {
  studentId: string;
  studentCode: string;
  fullName: string;
  attendanceMode: AttendanceMode;
  /** The institution's configured low-attendance rule, so the portal can
   * colour a rate against its own institution's policy rather than a built-in
   * one. Shown to the student as guidance, never as a penalty. */
  lowAttendanceThreshold: number;
  /** Today's finalized results. Empty is normal — most of the day, most days. */
  today: StudentAttendanceItem[];
  /**
   * Sessions held today whose register the faculty member has not confirmed
   * yet. Surfaced as a bare count: the student is told that a result is
   * coming, never what it provisionally is.
   */
  todayAwaitingConfirmation: number;
  overall: AttendanceRate;
  /** COLLEGE only; empty in DAILY mode. */
  subjects: SubjectAttendanceSummary[];
  /** SCHOOL view of the same records, newest first. */
  daily: DailyAttendanceSummary[];
  recent: StudentAttendanceItem[];
  /** Active classes, so the portal can say which class these figures are for. */
  enrollments: StudentEnrollmentContext[];
  /** Oldest month first, capped to the most recent few. */
  trend: AttendanceTrendPoint[];
}

/**
 * One subject, opened, for the student who studies it.
 *
 * The drill-down behind a subject row: the same rate the summary showed, plus
 * the individual classes it was computed from. Reached by `cohortSubjectId`,
 * but that id is *not* the authorization — the sessions are selected from the
 * caller's own finalized records, so a `cohortSubjectId` belonging to a
 * subject the caller does not study resolves to nothing at all.
 */
export interface StudentSubjectDetail {
  cohortSubjectId: string;
  subjectName: string;
  subjectCode: string;
  facultyName: string | null;
  cohortName: string;
  lowAttendanceThreshold: number;
  rate: AttendanceRate;
  /** Newest first. Every one of these is a finalized, confirmed register. */
  sessions: StudentAttendanceItem[];
}

/** One correction as history renders it. */
export interface AttendanceCorrectionEntry {
  id: string;
  previousResult: AttendanceResult;
  newResult: AttendanceResult;
  reason: string | null;
  source: CorrectionSource;
  changedAt: string;
  changedByName: string | null;
}

/**
 * One record, opened. What a student may see about their own attendance.
 *
 * Deliberately absent: `aiConfidence`, the matched embedding, and anything
 * else about the biometric comparison. A similarity score is information
 * about a face template, and Phase 5's rule — do not expose unnecessary
 * biometric information to the browser — does not stop applying because the
 * browser belongs to the data subject. What a student needs is the result,
 * who is accountable for it, and how it changed.
 */
export interface StudentAttendanceDetail {
  attendanceRecordId: string;
  sessionId: string;
  sessionDate: string;
  startedAt: string;
  endedAt: string | null;
  cohortName: string;
  subjectName: string | null;
  subjectCode: string | null;
  facultyName: string | null;
  result: AttendanceResult;
  isManuallyCorrected: boolean;
  /** Present only when the register was confirmed, which is the only state a
   * student can see at all. */
  finalizedAt: string | null;
  /** "recognition" or "manual" — how the register was built. A student is
   * entitled to know a camera was not involved in their absence. */
  generationSource: "recognition" | "manual" | null;
  captureCount: number;
  corrections: AttendanceCorrectionEntry[];
}

// ---------------------------------------------------------------------------
// Faculty
// ---------------------------------------------------------------------------

export interface SessionCounts {
  total: number;
  present: number;
  absent: number;
  /** NEEDS_REVIEW + NOT_EVALUATED — everything a human still owes a decision on. */
  needsReview: number;
}

export interface FacultySessionSummary {
  sessionId: string;
  cohortId: string;
  cohortName: string;
  subjectName: string | null;
  subjectCode: string | null;
  sessionDate: string;
  startedAt: string;
  status: SessionStatus;
  counts: SessionCounts;
  facultyName: string | null;
}

export interface FacultyCohortSummary {
  cohortId: string;
  name: string;
  termLabel: string | null;
  studentCount: number;
  /** PRIMARY is the class teacher of a school class; ASSISTANT teaches it. */
  facultyRole: "PRIMARY" | "ASSISTANT" | "ADMIN";
  lastSessionDate: string | null;
}

export interface FacultySubjectSummary {
  cohortSubjectId: string;
  cohortId: string;
  cohortName: string;
  subjectName: string;
  subjectCode: string;
}

export interface FacultyDashboard {
  attendanceMode: AttendanceMode;
  /** "assigned" for faculty, "institution" for an admin who sees everything. */
  scope: "assigned" | "institution";
  today: FacultySessionSummary[];
  cohorts: FacultyCohortSummary[];
  subjects: FacultySubjectSummary[];
  /** Registers sitting in REVIEW. The queue that owes students an answer. */
  pendingReview: FacultySessionSummary[];
  recent: FacultySessionSummary[];
  /** True when the actor is PRIMARY faculty on at least one cohort. */
  isClassTeacher: boolean;
}

/** Every attendance session status, in the order a register moves through them. */
export const SESSION_STATUSES = [
  "OPEN",
  "CAPTURING",
  "PROCESSING",
  "REVIEW",
  "FINALIZED",
  "CANCELLED",
] as const;

export type SessionStatusFilter = (typeof SESSION_STATUSES)[number];

/**
 * The faculty session list's query, normalized.
 *
 * Every field is nullable and means "no constraint" when null. `today` is not
 * a shorthand for a date range that the page then has to reproduce — it is
 * resolved against the server's clock, so "today" cannot drift with a stale
 * bookmark the way `?from=2026-09-20` silently does tomorrow.
 */
export interface FacultySessionFilters {
  today: boolean;
  /** Inclusive ISO date (YYYY-MM-DD). Ignored when `today` is set. */
  from: string | null;
  /** Inclusive ISO date (YYYY-MM-DD). Ignored when `today` is set. */
  to: string | null;
  cohortId: string | null;
  cohortSubjectId: string | null;
  status: SessionStatusFilter | null;
}

export interface FacultySessionList {
  attendanceMode: AttendanceMode;
  scope: "assigned" | "institution";
  filters: FacultySessionFilters;
  /** The classes and subjects this actor may filter by — their own scope. */
  cohorts: FacultyCohortSummary[];
  subjects: FacultySubjectSummary[];
  sessions: FacultySessionSummary[];
  /** True when the result hit the cap and there are older sessions unshown. */
  truncated: boolean;
}

/** An absent student on one session, for the class-teacher view. */
export interface AbsentStudentEntry {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  isManuallyCorrected: boolean;
}

export interface CohortAttendanceHistoryEntry extends FacultySessionSummary {
  rate: AttendanceRate;
  absentStudents: AbsentStudentEntry[];
  isFinalized: boolean;
}

export interface CohortAttendanceHistory {
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  attendanceMode: AttendanceMode;
  /** The institution's configured low-attendance rule, so the page can colour
   * a rate against its own institution's policy rather than a built-in one. */
  lowAttendanceThreshold: number;
  studentCount: number;
  /** Across every finalized session in the window. */
  overall: AttendanceRate;
  sessions: CohortAttendanceHistoryEntry[];
  corrections: CohortCorrectionEntry[];
}

export interface CohortCorrectionEntry extends AttendanceCorrectionEntry {
  studentCode: string;
  studentName: string;
  sessionDate: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Institution admin
// ---------------------------------------------------------------------------

export interface CohortReportRow {
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  studentCount: number;
  sessionCount: number;
  rate: AttendanceRate;
}

export interface LowAttendanceStudent {
  studentId: string;
  studentCode: string;
  fullName: string;
  cohortName: string;
  rate: AttendanceRate;
}

export interface InstitutionAttendanceReport {
  institutionId: string;
  institutionName: string;
  attendanceMode: AttendanceMode;
  /** Inclusive ISO date bounds of the window this report covers. Reports are
   * always windowed — an institution-wide "all time" scan is an unbounded
   * query, and a number with no stated period is not a report. */
  windowStart: string;
  windowEnd: string;
  windowDays: number;
  totals: {
    students: number;
    cohorts: number;
    finalizedSessions: number;
    sessionsAwaitingReview: number;
  };
  overall: AttendanceRate;
  cohorts: CohortReportRow[];
  /**
   * Students under `lowAttendanceThreshold`. This is a **filter**, not a
   * compliance determination — every institution's shortage rule differs
   * (and usually depends on periods, not sessions).
   */
  lowAttendanceThreshold: number;
  lowAttendance: LowAttendanceStudent[];
}
