import { prisma } from "@/lib/prisma";
import type { AttendanceRecord } from "./types";

export function getAttendanceRecordById(id: string): Promise<AttendanceRecord | null> {
  return prisma.attendanceRecord.findUnique({ where: { id } });
}

export function listAttendanceRecordsForSession(sessionId: string): Promise<AttendanceRecord[]> {
  return prisma.attendanceRecord.findMany({ where: { sessionId } });
}
