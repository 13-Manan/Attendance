import type { AttendanceRecord, AttendanceCorrection, AttendanceResult, CorrectionSource } from "@prisma/client";

export type { AttendanceRecord, AttendanceCorrection, AttendanceResult, CorrectionSource };

export interface CorrectAttendanceRecordInput {
  attendanceRecordId: string;
  newResult: AttendanceResult;
  changedByUserId: string;
  source: CorrectionSource;
  reason?: string;
  /**
   * Optimistic-concurrency guard: apply the change only while the row is
   * still in one of these states.
   *
   * Without it the write is read-then-update, and two callers acting on the
   * same row at the same time — a double-clicked button, two teachers on two
   * devices, two Confirm presses — both read the old value and both write.
   * The final result comes out the same, but the audit trail records one
   * decision two or three times, which is the opposite of what an audit trail
   * is for. Measured: three concurrent confirmations produced five correction
   * rows for two students.
   *
   * Omit it and the write is unconditional, which is the previous behaviour.
   */
  onlyIfCurrentResultIn?: AttendanceResult[];
}
