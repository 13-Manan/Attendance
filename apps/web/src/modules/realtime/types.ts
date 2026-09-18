import type {
  AttendanceCounts,
  AttendanceRealtimeEvent,
  AttendanceRecordUpdatedEvent,
  AttendanceSessionFinalizedEvent,
  StudentAttendanceUpdatedEvent,
} from "@attendance/shared-types";

export type {
  AttendanceCounts,
  AttendanceRealtimeEvent,
  AttendanceRecordUpdatedEvent,
  AttendanceSessionFinalizedEvent,
  StudentAttendanceUpdatedEvent,
};

/**
 * Two channel families, deliberately separate:
 *
 *   session:<id>  — faculty review boards watching one attendance session.
 *                   Carries whole-class information.
 *   student:<id>  — one student's own portal. Carries only that student's
 *                   own result; a student must never receive the class's
 *                   roster or counts over realtime.
 *
 * Both ride the same transport (SSE, ADR-0004); the split is an
 * authorization boundary, not a performance one.
 */
export interface AttendanceEventPublisher {
  /** Publish to the event's session channel. */
  publish(event: AttendanceRealtimeEvent): void;
  /** Publish to one student's private channel. */
  publishToStudent(studentId: string, event: StudentAttendanceUpdatedEvent): void;
  subscribe(sessionId: string, listener: (event: AttendanceRealtimeEvent) => void): () => void;
  subscribeToStudent(
    studentId: string,
    listener: (event: StudentAttendanceUpdatedEvent) => void,
  ): () => void;
}
