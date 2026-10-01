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
 * message never reaches the browser.
 */

async function run<T>(step: string, action: () => Promise<T>): Promise<CaptureFlowResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const code = captureFlowErrorCode(error);
    if (code === "unknown") {
      console.error(
        JSON.stringify({
          log: "attendance_capture_flow",
          event: "unexpected_error",
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
  return run("start", () => startCaptureSession(input));
}

export async function checkCapturePhotoFlow(
  input: Parameters<typeof analyzeCaptureImageAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof analyzeCaptureImageAction>>> {
  return run("check_photo", () => analyzeCaptureImageAction(input));
}

export async function processCaptureFlow(
  input: Parameters<typeof processSessionAttendanceAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof processSessionAttendanceAction>>> {
  return run("process", () => processSessionAttendanceAction(input));
}

export async function summarizeCaptureFlow(
  input: Parameters<typeof summarizeCaptureSessionAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof summarizeCaptureSessionAction>>> {
  return run("summarize", () => summarizeCaptureSessionAction(input));
}

export async function markByHandFlow(
  input: Parameters<typeof startManualRollCallAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof startManualRollCallAction>>> {
  return run("mark_by_hand", () => startManualRollCallAction(input));
}

export async function cancelCaptureFlow(
  input: Parameters<typeof cancelCaptureSessionAction>[0],
): Promise<CaptureFlowResult<Awaited2<typeof cancelCaptureSessionAction>>> {
  return run("cancel", () => cancelCaptureSessionAction(input));
}
