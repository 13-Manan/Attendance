import { prisma } from "@/lib/prisma";
import type { AttendanceSession, SessionStatus } from "./types";

export function getSessionWithImages(id: string) {
  return prisma.attendanceSession.findUnique({
    where: { id },
    include: { images: { orderBy: { sequenceNumber: "asc" } } },
  });
}

export function createSession(
  input: Pick<AttendanceSession, "institutionId" | "cohortId" | "facultyId" | "sessionDate"> & {
    cohortSubjectId?: string | null;
  },
): Promise<AttendanceSession> {
  return prisma.attendanceSession.create({
    data: {
      institutionId: input.institutionId,
      cohortId: input.cohortId,
      facultyId: input.facultyId,
      sessionDate: input.sessionDate,
      cohortSubjectId: input.cohortSubjectId ?? null,
    },
  });
}

export function getSessionById(id: string) {
  return prisma.attendanceSession.findUnique({ where: { id } });
}

/**
 * Compare-and-set status change: the row only moves if it is still in
 * `from`. Two devices racing to advance the same session cannot both
 * succeed, and a stale client cannot force a status backwards.
 *
 * The legality of `from -> to` is the service layer's call
 * (`canTransitionSessionStatus`); this function only guarantees atomicity.
 */
export async function transitionSessionStatus(
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
): Promise<AttendanceSession> {
  const result = await prisma.attendanceSession.updateMany({
    where: { id: sessionId, status: from },
    data: { status: to },
  });
  if (result.count === 0) throw new Error("session_status_conflict");
  return prisma.attendanceSession.findUniqueOrThrow({ where: { id: sessionId } });
}

/**
 * Existence probe for the "one daily attendance session per cohort per date"
 * invariant that DAILY-mode (school) institutions require. Uses a
 * 24-hour half-open range so the check is timezone-agnostic at this layer —
 * timezone canonicalization is the caller's job.
 *
 * A CANCELLED session is not "today's session". Discarding keeps the row for
 * the audit trail, but it holds no register, so it must not stop the class
 * teacher starting again — every other reader of "today" (analytics, review,
 * reporting) already skips it. A FINALIZED register still counts: re-taking a
 * confirmed register is a correction, not a new session.
 */
export function findExistingDailySession(
  cohortId: string,
  sessionDate: Date,
): Promise<AttendanceSession | null> {
  const dayStart = new Date(sessionDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return prisma.attendanceSession.findFirst({
    where: {
      cohortId,
      cohortSubjectId: null,
      sessionDate: { gte: dayStart, lt: dayEnd },
      status: { not: "CANCELLED" },
    },
  });
}
