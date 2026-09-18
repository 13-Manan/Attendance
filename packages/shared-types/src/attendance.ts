/**
 * Shared enums/types mirroring apps/web/prisma/schema.prisma, used at API
 * boundaries (public integration API responses, SSE event payloads) so
 * consumers outside the Prisma client still get typed values.
 */

export type InstitutionType = "SCHOOL" | "COLLEGE";

export type AcademicUnitKind =
  | "DEPARTMENT"
  | "GRADE"
  | "SEMESTER"
  | "COURSE"
  | "SECTION"
  | "GENERIC";

export type SessionStatus =
  | "OPEN"
  | "CAPTURING"
  | "PROCESSING"
  | "REVIEW"
  | "FINALIZED"
  | "CANCELLED";

export type AttendanceResult = "PRESENT" | "ABSENT" | "NEEDS_REVIEW" | "NOT_EVALUATED";

export type CorrectionSource = "FACULTY_REVIEW" | "ROLL_CALL" | "ADMIN_OVERRIDE" | "PUBLIC_API";

export interface AttendanceRecordDTO {
  id: string;
  sessionId: string;
  studentId: string;
  aiResult: AttendanceResult;
  aiConfidence: number | null;
  finalResult: AttendanceResult;
  isManuallyCorrected: boolean;
}

/**
 * Counts shown on the faculty review board and in the pre-finalization
 * confirmation. `total` is the enrolled roster size, so
 * present + absent + needsReview + notEvaluated === total at all times —
 * a student can never be dropped from the tally by a correction.
 */
export interface AttendanceCounts {
  total: number;
  present: number;
  absent: number;
  needsReview: number;
  notEvaluated: number;
}

/**
 * Published to the session channel whenever a record's `finalResult`
 * changes. Carries the whole record so a review board can apply the update
 * without re-fetching, and `counts` so every connected reviewer sees the
 * same totals without recomputing from a partial list.
 */
export interface AttendanceRecordUpdatedEvent {
  type: "attendance-record-updated";
  sessionId: string;
  record: AttendanceRecordDTO;
  counts: AttendanceCounts;
  occurredAt: string;
}

/** Published to the session channel when faculty confirms attendance. */
export interface AttendanceSessionFinalizedEvent {
  type: "attendance-session-finalized";
  sessionId: string;
  counts: AttendanceCounts;
  finalizedByUserId: string;
  finalizedAt: string;
  occurredAt: string;
}

/**
 * Published to a single student's channel. Deliberately narrow: a student
 * learns their own result and nothing about the rest of the class — the
 * session-channel events above are for faculty only.
 */
export interface StudentAttendanceUpdatedEvent {
  type: "student-attendance-updated";
  sessionId: string;
  studentId: string;
  finalResult: AttendanceResult;
  /** False while the session is still under faculty review. A portal must
   * not show a provisional result as though it were final. */
  isFinalized: boolean;
  occurredAt: string;
}

/** Payload published on the realtime SSE channels. */
export type AttendanceRealtimeEvent =
  | AttendanceRecordUpdatedEvent
  | AttendanceSessionFinalizedEvent
  | StudentAttendanceUpdatedEvent;
