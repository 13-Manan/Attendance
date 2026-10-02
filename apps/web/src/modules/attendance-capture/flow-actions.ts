"use server";

import {
  processSessionAttendanceAction,
  startManualRollCallAction,
} from "@/modules/attendance-review/actions";
import {
  analyzeCaptureImageAction,
  cancelCaptureSessionAction,
  startCaptureSession,
  summarizeCaptureSessionAction,
} from "./actions";
import { captureFlowErrorCode, type CaptureFlowResult } from "./capture-flow";
import { logAttendanceUx } from "./ux-events";

/**
 * The capture screens' Server Actions, returning a result instead of throwing.
 *
 * Each one calls the existing action unchanged — the same input validation,
 * the same `requireUser`, the same service and every permission, class and
 * subject check inside it. The only difference is where a failure is read: a
 * thrown error's message does not survive a production build (the browser
 * gets a generic "Minified React error"), so it is read here, on the server,
 * and returned as a code the screen can explain.
 *
 * An unexpected error is logged with its tag and returned as `unknown`; its
 * message never reaches the browser. A step that succeeded writes its UX event
 * (see `ux-events.ts`): ids and counts only.
 */

async function run<T>(step: string, action: () => Promise<T>): Promise<CaptureFlowResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const code = captureFlowErrorCode(error);
    if (code === "unknown" || code === "matching_unavailable") {
      // An outage of the face service is worth a line as much as an unknown
      // error is: the teacher sees a plain sentence, operators need this one.
      console.error(
        JSON.stringify({
          log: "attendance_capture_flow",
          event: code === "unknown" ? "unexpected_error" : "face_ai_unavailable",
          step,
          error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "non-error thrown",
        }),
      );
    }
    return { ok: false, code };
  }
}

type Awaited2<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export async function startCaptureFlow(
  input: Parameters<typeof startCaptureSession>[0],
): Promise<CaptureFlowResult<Awaited2<typeof startCaptureSession>>> {
  const result = await run("start", () => startCaptureSession(input));
  if (result.ok) {
    logAttendanceUx("attendance_start", {
      sessionId: result.value.session.id,
      cohortId: result.value.session.cohortId,
      mode: result.value.attendanceMode,
      resumed: result.value.resumed,
      status: result.value.session.status,
    });
  }
  return result;
}

export async function checkCapturePhotoFlow(
  input: Parameters<typeof analyzeCaptureImageAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof analyzeCaptureImageAction>>> {
  const result = await run("check_photo", () => analyzeCaptureImageAction(input));
  if (result.ok) {
    logAttendanceUx("capture", {
      sessionId: input.sessionId,
      sequenceNumber: input.sequenceNumber,
      faces: result.value.ok ? result.value.faceCount : 0,
    });
  }
  return result;
}

export async function processCaptureFlow(
  input: Parameters<typeof processSessionAttendanceAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof processSessionAttendanceAction>>> {
  const result = await run("process", () => processSessionAttendanceAction(input));
  if (result.ok) {
    const counts = result.value.generation.counts;
    logAttendanceUx("recognition_complete", {
      sessionId: input.sessionId,
      photos: input.images.length,
      merged: input.merge === true,
      present: counts.present,
      needsReview: counts.needsReview,
      total: counts.total,
    });
  }
  return result;
}

export async function summarizeCaptureFlow(
  input: Parameters<typeof summarizeCaptureSessionAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof summarizeCaptureSessionAction>>> {
  return run("summarize", () => summarizeCaptureSessionAction(input));
}

export async function markByHandFlow(
  input: Parameters<typeof startManualRollCallAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof startManualRollCallAction>>> {
  const result = await run("mark_by_hand", () => startManualRollCallAction(input));
  if (result.ok) logAttendanceUx("attendance_manual", { sessionId: input.sessionId, total: result.value.counts.total });
  return result;
}

export async function cancelCaptureFlow(
  input: Parameters<typeof cancelCaptureSessionAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof cancelCaptureSessionAction>>> {
  return run("cancel", () => cancelCaptureSessionAction(input));
}
