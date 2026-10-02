"use server";

import { logAttendanceUx } from "@/modules/attendance-capture/ux-events";
import { confirmAttendanceAction, submitReviewDecisionAction } from "./actions";
import { reviewFlowErrorCode, type ReviewFlowResult } from "./review-flow";

/**
 * The review board's Server Actions, returning a result instead of throwing.
 *
 * Each calls the existing action unchanged — the same validation, the same
 * `requireUser`, every permission, ownership and correction-window check. Only
 * the way a failure comes back differs: a thrown message does not survive a
 * production build, so it is read here and returned as a code the board can
 * explain. An unexpected error is logged with its tag; its message never
 * reaches the browser.
 */

async function run<T>(step: string, action: () => Promise<T>): Promise<ReviewFlowResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const code = reviewFlowErrorCode(error);
    if (code === "unknown") {
      console.error(
        JSON.stringify({
          log: "attendance_review_flow",
          event: "unexpected_error",
          step,
          error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "non-error thrown",
        }),
      );
    }
    return { ok: false, code };
  }
}

export async function decideStudentFlow(
  input: Parameters<typeof submitReviewDecisionAction>[0],
): Promise<ReviewFlowResult<Awaited<ReturnType<typeof submitReviewDecisionAction>>>> {
  return run("decide", () => submitReviewDecisionAction(input));
}

export async function finishAttendanceFlow(
  input: Parameters<typeof confirmAttendanceAction>[0],
): Promise<ReviewFlowResult<Awaited<ReturnType<typeof confirmAttendanceAction>>>> {
  const result = await run("finish", () => confirmAttendanceAction(input));
  if (result.ok) {
    logAttendanceUx("attendance_finalize", {
      sessionId: input.sessionId,
      present: result.value.counts.present,
      absent: result.value.counts.absent,
      total: result.value.counts.total,
    });
  }
  return result;
}
