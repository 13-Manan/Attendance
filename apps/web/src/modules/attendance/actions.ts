"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { applyReviewDecision } from "@/modules/attendance-review/service";
import type { ReviewDecisionResult } from "@/modules/attendance-review/types";

/**
 * Faculty correction from the review board.
 *
 * `changedByUserId` is deliberately NOT part of the input: the actor is
 * derived from the server session. A client that could name the actor could
 * attribute its own correction to somebody else, and the AttendanceCorrection
 * row is meant to be evidence.
 *
 * `source` is likewise server-decided (FACULTY_REVIEW during review,
 * ADMIN_OVERRIDE after finalization) — see
 * modules/attendance-review/service.ts#applyReviewDecision, which owns the
 * authorization and session-state rules this action delegates to.
 */
const inputSchema = z.object({
  attendanceRecordId: z.string().min(1),
  newResult: z.enum(["PRESENT", "ABSENT", "NEEDS_REVIEW"]),
  reason: z.string().max(500).optional(),
});

export async function correctAttendanceRecord(
  input: z.infer<typeof inputSchema>,
): Promise<ReviewDecisionResult> {
  const actor = await requireUser();
  const parsed = inputSchema.parse(input);
  return applyReviewDecision(actor, parsed);
}
