import type { AttendanceRecord, AttendanceCorrection, AttendanceResult, CorrectionSource } from "@prisma/client";

export type { AttendanceRecord, AttendanceCorrection, AttendanceResult, CorrectionSource };

export interface CorrectAttendanceRecordInput {
  attendanceRecordId: string;
  newResult: AttendanceResult;
  changedByUserId: string;
  source: CorrectionSource;
  reason?: string;
}
