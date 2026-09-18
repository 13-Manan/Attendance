import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AttendanceSession } from "@/modules/sessions/types";

/**
 * Thin Prisma access for the sync engine. No business rules here — the
 * idempotency decision and the conflict policy live in `service.ts`.
 */

/**
 * The session a given (cohort, subject, day) already has, if any.
 *
 * This is the natural key the offline device does *not* need to know a server
 * id for: a school register is one per cohort per day, a college one is one
 * per (cohort, subject) per day. Both are already enforced elsewhere in the
 * attendance engine, which is why a replayed "open the class" cannot create a
 * second register even before the ledger is consulted.
 *
 * The day is compared in UTC, matching `sessionDate`'s own convention across
 * the attendance engine.
 */
export async function findSessionForDay(
  cohortId: string,
  cohortSubjectId: string | null,
  sessionDate: Date,
): Promise<AttendanceSession | null> {
  const dayStart = new Date(sessionDate);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  return prisma.attendanceSession.findFirst({
    where: {
      cohortId,
      cohortSubjectId,
      sessionDate: { gte: dayStart, lt: dayEnd },
    },
  });
}

export async function getSessionById(id: string): Promise<AttendanceSession | null> {
  return prisma.attendanceSession.findUnique({ where: { id } });
}

export async function listStudentNames(
  studentIds: string[],
): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const rows = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  return new Map(rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim()]));
}

/**
 * Reads a session's metadata under a row lock, hands it to `apply`, and writes
 * back whatever that returns — all in one transaction.
 *
 * The lock is the point. Two devices replaying operations against the same
 * register concurrently would otherwise both read a ledger without the other's
 * entry, and the later write would erase the earlier one — losing the record
 * that an operation had been applied, which is the one thing the ledger
 * exists to remember. `SELECT ... FOR UPDATE` serializes them.
 *
 * Note what this does *not* wrap: the attendance writes themselves. Those go
 * through the review module on the normal client, outside this transaction.
 * That is deliberate — holding a row lock across roster generation and a
 * per-student correction loop would serialize every device in the school
 * behind one register. It is safe because every one of those writes is
 * idempotent by a database key the schema already has (`AttendanceRecord`
 * is unique on `(sessionId, studentId)`, and a correction whose new result
 * equals the current one is a no-op), so a replay that slips through the gap
 * between apply and ledger-write changes nothing. See `service.ts`.
 */
export async function withLockedSessionMetadata<T>(
  sessionId: string,
  apply: (metadata: unknown) => Promise<{ metadata: Record<string, unknown>; result: T }>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ metadata: unknown }>>(
      Prisma.sql`SELECT "metadata" FROM "AttendanceSession" WHERE "id" = ${sessionId} FOR UPDATE`,
    );
    if (rows.length === 0) throw new Error("session_not_found");
    const { metadata, result } = await apply(rows[0]?.metadata);
    await tx.attendanceSession.update({
      where: { id: sessionId },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
    return result;
  });
}

/** Reads a session's metadata without locking — for a duplicate pre-check. */
export async function readSessionMetadata(sessionId: string): Promise<unknown> {
  const row = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: { metadata: true },
  });
  return row?.metadata;
}

export async function findRecordForStudent(
  sessionId: string,
  studentId: string,
): Promise<{ id: string; finalResult: string; isManuallyCorrected: boolean } | null> {
  return prisma.attendanceRecord.findUnique({
    where: { sessionId_studentId: { sessionId, studentId } },
    select: { id: true, finalResult: true, isManuallyCorrected: true },
  });
}
