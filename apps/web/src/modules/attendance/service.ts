import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import type { AttendanceRecord, CorrectAttendanceRecordInput } from "./types";

/**
 * The faculty-correction workflow (e.g. calling roll on the Absent list and
 * marking a student Present). AI output is advisory only, so this is the
 * single place finalResult may change, and it never does so without also
 * writing an append-only AttendanceCorrection row — previous result, new
 * result, who, when, and an optional reason.
 *
 * `aiResult` and `aiConfidence` are never written here. A correction records
 * that a human disagreed with the machine; it must not erase what the
 * machine said.
 *
 * This function is deliberately unauthenticated and unauthorized — it is the
 * storage primitive. Callers go through
 * `modules/attendance-review/service.ts#applyReviewDecision`, which owns the
 * permission checks, the session-state rules, and the realtime publish.
 */
export async function correctAttendanceRecord(
  input: CorrectAttendanceRecordInput,
): Promise<AttendanceRecord> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.attendanceRecord.findUniqueOrThrow({
      where: { id: input.attendanceRecordId },
    });

    // Compare-and-set when the caller supplied a guard. `updateMany` carries
    // the condition into the UPDATE's own WHERE clause, so Postgres evaluates
    // it against the committed row: a second transaction racing this one
    // blocks, re-checks, matches nothing, and writes no duplicate correction.
    // A plain `update` cannot express that — it matches on the id alone, and
    // the state it was deciding against was read in a separate statement.
    const guarded = input.onlyIfCurrentResultIn;
    if (guarded) {
      const claimed = await tx.attendanceRecord.updateMany({
        where: { id: input.attendanceRecordId, finalResult: { in: guarded } },
        data: { finalResult: input.newResult, isManuallyCorrected: true },
      });
      if (claimed.count === 0) {
        // Somebody else decided this row first. Their correction stands and
        // this call is a no-op rather than a second entry for one decision.
        return existing;
      }
    } else {
      await tx.attendanceRecord.update({
        where: { id: input.attendanceRecordId },
        data: { finalResult: input.newResult, isManuallyCorrected: true },
      });
    }
    const updated = await tx.attendanceRecord.findUniqueOrThrow({
      where: { id: input.attendanceRecordId },
    });

    await tx.attendanceCorrection.create({
      data: {
        attendanceRecordId: existing.id,
        previousResult: existing.finalResult,
        newResult: input.newResult,
        changedByUserId: input.changedByUserId,
        source: input.source,
        reason: input.reason,
      },
    });

    await recordAuditLog(
      {
        action: "attendance.corrected",
        entityType: "AttendanceRecord",
        entityId: existing.id,
        institutionId: existing.institutionId,
        actorUserId: input.changedByUserId,
        beforeJson: { finalResult: existing.finalResult },
        afterJson: { finalResult: input.newResult },
      },
      tx,
    );

    return updated;
  });
}
