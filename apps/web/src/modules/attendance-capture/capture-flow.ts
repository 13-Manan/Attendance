import { ForbiddenError } from "@/modules/authorization/types";
import type { RecognitionAvailability } from "@/modules/recognition-engine/wording";
import type { CameraErrorKind, CameraState } from "./camera";
import type { CaptureImageAnalysis } from "./types";

/**
 * The capture screens' decisions, as plain functions: what a teacher is told
 * in each camera state, what a photo's check says, when "Done" is allowed,
 * what the wait looks like, how a result is summarised and how a failure is
 * explained.
 *
 * Nothing here decides attendance or relaxes a check. "Done" is allowed in
 * exactly the cases "Process attendance" always was; recognition, the per-photo
 * face check and the register are the server's, unchanged. This file only
 * decides the words, and keeps them in a teacher's vocabulary — never the
 * names of the services or models doing the work.
 */

// ---------------------------------------------------------------------------
// Errors, as codes the server can hand back safely
// ---------------------------------------------------------------------------

/**
 * Why a step failed, as a code rather than an exception.
 *
 * Production builds replace a thrown Server Action error's message with a
 * generic one, so a mapping that reads `error.message` in the browser never
 * matches there — teachers saw "Minified React error #441" instead of "this
 * register is already finished". The capture flow's actions catch on the
 * server, where the message is intact, and return one of these instead.
 */
export type CaptureFlowErrorCode =
  | "register_finished"
  | "register_closed"
  | "register_changed"
  | "no_students"
  | "not_allowed"
  | "needs_subject"
  | "matching_slow"
  | "matching_changed"
  | "matching_failed"
  /** The face service did not answer, or answered with a server error: an outage, not this photo. */
  | "matching_unavailable"
  | "photos_invalid"
  /**
   * Browser side only: the request never came back — the phone is offline, or
   * the connection dropped. The server never sends this code.
   */
  | "connection_lost"
  | "unknown";

export type CaptureFlowResult<T> = { ok: true; value: T } | { ok: false; code: CaptureFlowErrorCode };

/** Server side: the tagged error the services throw, as a code. */
export function captureFlowErrorCode(error: unknown): CaptureFlowErrorCode {
  if (error instanceof ForbiddenError) return "not_allowed";
  const raw = error instanceof Error ? error.message : "";
  // The server's own call to the face service failed: unreachable ("fetch
  // failed" — the only outbound request these steps make) or a 5xx from it.
  if ((error instanceof TypeError && /fetch failed/i.test(raw)) || /^face-ai \S+ failed: 5\d\d/.test(raw)) {
    return "matching_unavailable";
  }
  if (raw.startsWith("session_locked:FINALIZED") || raw === "attendance_finalized") {
    return "register_finished";
  }
  if (
    raw.startsWith("session_locked:") ||
    raw === "session_not_found" ||
    raw === "session_cancelled" ||
    raw.startsWith("invalid_transition:") ||
    raw.startsWith("invalid_session_status:")
  ) {
    return "register_closed";
  }
  if (raw === "session_status_conflict" || raw === "daily_session_already_exists") {
    return "register_changed";
  }
  if (raw === "empty_roster" || raw === "no_attendance_records") return "no_students";
  if (
    raw === "subject_wise_mode_requires_subject" ||
    raw === "cohort_subject_mismatch" ||
    raw === "cohort_subject_not_found" ||
    raw === "daily_mode_forbids_subject"
  ) {
    return "needs_subject";
  }
  if (raw === "face_ai_timeout") return "matching_slow";
  if (raw === "face_ai_model_changed" || raw === "merge_model_mismatch") return "matching_changed";
  if (raw.startsWith("face_ai_invalid_embedding:")) return "matching_failed";
  if (raw === "no_images" || raw === "too_many_images" || raw === "duplicate_image_sequence") {
    return "photos_invalid";
  }
  if (raw === "cohort_not_found" || raw === "institution_not_found") return "not_allowed";
  return "unknown";
}

/**
 * Whether a Server Action call failed because the connection did, rather than
 * because the server answered with an error. Browsers word it differently —
 * "Failed to fetch" (Chrome), "Load failed" (Safari), "NetworkError …"
 * (Firefox) — and an offline device says so outright.
 */
export function isConnectionError(error: unknown, online: boolean = true): boolean {
  if (!online) return true;
  if (!(error instanceof TypeError)) return false;
  return /failed to fetch|load failed|networkerror|network request failed|network error/i.test(error.message);
}

export interface FlowErrorCopy {
  message: string;
  /** Whether trying the same thing again is honest advice. */
  canRetry: boolean;
  /** Whether marking the register by hand is the way forward. */
  canMarkByHand: boolean;
}

/**
 * What a teacher is told. `stage` matters because marking by hand needs a
 * register to exist: before Start succeeded there is none.
 */
export function describeCaptureFlowError(
  code: CaptureFlowErrorCode,
  stage: "start" | "process" | "markByHand",
): FlowErrorCopy {
  const afterStart = stage !== "start";
  switch (code) {
    case "register_finished":
      return {
        message:
          "Today's attendance for this class is already finished. Open it from the class page if something needs changing.",
        canRetry: false,
        canMarkByHand: false,
      };
    case "register_closed":
      return {
        message: "This attendance was cancelled or has expired. Go back and start again.",
        canRetry: false,
        canMarkByHand: false,
      };
    case "register_changed":
      return {
        message:
          "This attendance was changed on another device at the same moment. Go back and open it again.",
        canRetry: false,
        canMarkByHand: false,
      };
    case "no_students":
      return {
        message:
          "There are no students in this class yet, so there is nobody to mark. Ask your administrator to add them.",
        canRetry: false,
        canMarkByHand: false,
      };
    case "not_allowed":
      return {
        message:
          "You can't take attendance for this class. Ask your administrator to assign it to you.",
        canRetry: false,
        canMarkByHand: false,
      };
    case "needs_subject":
      return {
        message: "Choose the subject for this class first.",
        canRetry: false,
        canMarkByHand: false,
      };
    case "matching_slow":
      return {
        message: "Matching students took too long. Your photos are kept — try again, or mark attendance by hand.",
        canRetry: true,
        canMarkByHand: afterStart,
      };
    case "matching_changed":
      return {
        message:
          "Face matching was updated while this was running, so nobody was matched. Try again, or mark attendance by hand.",
        canRetry: true,
        canMarkByHand: afterStart,
      };
    case "matching_failed":
      return {
        message:
          "Face matching didn't work for these photos. Mark attendance by hand, and let your administrator know.",
        canRetry: true,
        canMarkByHand: afterStart,
      };
    case "matching_unavailable":
      return {
        message: "Face matching isn't responding right now. Try again in a moment, or mark attendance by hand.",
        canRetry: true,
        canMarkByHand: afterStart,
      };
    case "photos_invalid":
      return {
        message: "Something was wrong with the photos. Take them again.",
        canRetry: false,
        canMarkByHand: afterStart,
      };
    case "connection_lost":
      return {
        message:
          stage === "start"
            ? "Attendance hasn't been started. Check the connection, then retry."
            : stage === "process"
              ? "Your photo hasn't been submitted. Check the connection, then retry."
              : "Nothing has been changed. Check the connection, then retry.",
        canRetry: true,
        // Marking by hand needs the server too.
        canMarkByHand: false,
      };
    case "unknown":
      return {
        message: afterStart
          ? "Something went wrong. Try again, or mark attendance by hand."
          : "Something went wrong. Try again in a moment.",
        canRetry: true,
        canMarkByHand: afterStart,
      };
  }
}

/** The large line over a failure: what didn't happen, in a teacher's words. */
export function failureHeadline(
  code: CaptureFlowErrorCode,
  stage: "start" | "process" | "markByHand",
  photoCount = 1,
): string {
  if (code === "connection_lost") return "Connection lost";
  if (stage === "start") return "Couldn't start attendance";
  if (stage === "markByHand") return "Couldn't mark attendance by hand";
  return photoCount > 1 ? "Couldn't finish checking these photos." : "Couldn't finish checking this photo.";
}

/** "Retry" after a dropped connection — the same request again; "Try again" otherwise. */
export function retryLabel(code: CaptureFlowErrorCode): string {
  return code === "connection_lost" ? "Retry" : "Try again";
}

// ---------------------------------------------------------------------------
// The camera, in a teacher's words
// ---------------------------------------------------------------------------

export type CameraStage = "idle" | "requesting" | "ready" | "capturing" | "blocked" | "unavailable";

export function cameraStageOf(state: CameraState): CameraStage {
  switch (state.name) {
    case "idle":
      return "idle";
    case "starting":
      return "requesting";
    case "ready":
      return "ready";
    case "capturing":
      return "capturing";
    case "failed":
      return state.failure.kind === "permission_denied" ? "blocked" : "unavailable";
    case "unsupported":
      return "unavailable";
  }
}

export type DevicePlatform = "ios" | "android" | "other";

/** From the browser's user agent. Only ever used to pick which help to show. */
export function platformOf(userAgent: string): DevicePlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  // iPadOS reports itself as a Mac; a Mac with a touch screen is an iPad.
  if (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

export interface CameraHelp {
  /** Always "Camera isn't available": one headline, whatever the cause. */
  title: string;
  /** The cause, in one short sentence. */
  reason: string;
  steps: string[];
  canRetry: boolean;
  /** Offer marking the register by hand instead. */
  offerMarkByHand: boolean;
}

const CAMERA_UNAVAILABLE = "Camera isn't available";

/**
 * What to do when the camera does not start. Specific to the device in hand,
 * because "allow it in your address bar" means nothing on a phone whose
 * address bar is hidden.
 */
export function cameraHelp(
  kind: CameraErrorKind | "unsupported",
  platform: DevicePlatform,
): CameraHelp {
  switch (kind) {
    case "permission_denied":
      return {
        title: CAMERA_UNAVAILABLE,
        reason: "Camera access is turned off for this site.",
        steps:
          platform === "ios"
            ? [
                "Open Settings, then Safari (or your browser), then Camera.",
                "Choose Allow, come back here and tap Try again.",
              ]
            : platform === "android"
              ? [
                  "Tap the icon next to the web address, then Permissions, then Camera.",
                  "Choose Allow, then tap Try again.",
                ]
              : [
                  "Click the camera or lock icon in the address bar and allow the camera.",
                  "Then click Try again.",
                ],
        canRetry: true,
        offerMarkByHand: true,
      };
    case "no_device":
      return {
        title: CAMERA_UNAVAILABLE,
        reason: "No camera was found on this device.",
        steps: ["Use a phone or tablet with a camera, or mark attendance by hand."],
        canRetry: true,
        offerMarkByHand: true,
      };
    case "device_in_use":
      return {
        title: CAMERA_UNAVAILABLE,
        reason: "Another app is using the camera.",
        steps: ["Close any other app using the camera, such as a video call.", "Then tap Try again."],
        canRetry: true,
        offerMarkByHand: true,
      };
    case "insecure_context":
      return {
        title: CAMERA_UNAVAILABLE,
        reason: "The camera only works on the site's secure address.",
        steps: ["Open the attendance site using its https:// address."],
        canRetry: false,
        offerMarkByHand: true,
      };
    case "unsupported":
      return {
        title: CAMERA_UNAVAILABLE,
        reason: "This browser can't use the camera.",
        steps: ["Open this page in Chrome or Safari, or mark attendance by hand."],
        canRetry: false,
        offerMarkByHand: true,
      };
    case "unknown":
      return {
        title: CAMERA_UNAVAILABLE,
        reason: "The camera didn't start.",
        steps: ["Tap Try again, or mark attendance by hand."],
        canRetry: true,
        offerMarkByHand: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export interface FlowShot {
  sequenceNumber: 1 | 2 | 3;
  checking?: boolean;
  analysis?: Pick<CaptureImageAnalysis, "faceCount" | "qualityLabel">;
  /** `connection`: the photo never reached the server; `service`: it did, and the check failed. */
  failure?: { message: string; kind?: "connection" | "service" };
}

/** The lowest free photo slot. A retaken photo reuses the slot it gave up. */
export function nextSequenceNumber(shots: Array<Pick<FlowShot, "sequenceNumber">>): 1 | 2 | 3 | null {
  const used = new Set(shots.map((s) => s.sequenceNumber));
  for (const n of [1, 2, 3] as const) if (!used.has(n)) return n;
  return null;
}

export type PhotoTone = "checking" | "good" | "warning" | "bad";

export interface PhotoStatus {
  tone: PhotoTone;
  label: string;
  detail: string | null;
}

function faces(n: number): string {
  return `${n} face${n === 1 ? "" : "s"}`;
}

/**
 * One photo's face check, as a chip and a line of advice.
 *
 * `offline`: the connection is down. A check still in flight then has not
 * reached the server — the framework holds it and sends it, once, when the
 * connection returns — so it reads "Connection lost" rather than a spinner
 * that never ends.
 */
export function photoStatusOf(shot: FlowShot, options: { offline?: boolean } = {}): PhotoStatus {
  if (shot.checking && options.offline) {
    return { tone: "bad", label: "Connection lost", detail: "Your photo hasn't been submitted. It will be sent once the connection is back." };
  }
  if (shot.checking) return { tone: "checking", label: "Checking faces…", detail: null };
  if (shot.failure) {
    return shot.failure.kind === "connection"
      ? { tone: "bad", label: "Connection lost", detail: "Your photo hasn't been submitted." }
      : { tone: "bad", label: "Couldn't finish checking this photo", detail: shot.failure.message };
  }
  const analysis = shot.analysis;
  if (!analysis) return { tone: "checking", label: "Not checked yet", detail: null };
  switch (analysis.qualityLabel) {
    case "good":
      return { tone: "good", label: `${faces(analysis.faceCount)} found`, detail: null };
    case "acceptable":
      return {
        tone: "warning",
        label: `${faces(analysis.faceCount)} found`,
        detail: "Some faces may be blurred. Add another photo from a different angle if anyone is hidden.",
      };
    case "poor":
      return {
        tone: "warning",
        label: `Only ${faces(analysis.faceCount)} clear`,
        detail: "Retake closer to the class, or with more light.",
      };
    case "no_faces":
      return {
        tone: "bad",
        label: "No faces found",
        detail: "Move closer or brighten the room, then retake.",
      };
  }
}

export interface DoneState {
  enabled: boolean;
  /** Why not, in a teacher's words; null when enabled. */
  reason: string | null;
}

/**
 * When the photos can be sent for matching. Exactly the rule "Process
 * attendance" has always had: at least one photo, every check finished, none
 * failed. A photo with no faces in it still counts — the register then asks
 * the teacher about everyone, which is the existing, deliberate behaviour.
 */
export function doneStateOf(shots: FlowShot[], options: { offline?: boolean } = {}): DoneState {
  if (shots.length === 0) return { enabled: false, reason: "Take a photo of the class first." };
  if (shots.some((s) => s.checking)) {
    // Held for the connection, not being checked: say what it is waiting for.
    return { enabled: false, reason: options.offline ? "Waiting for the connection" : "Checking faces…" };
  }
  if (shots.some((s) => s.failure)) {
    return { enabled: false, reason: "Retake or remove the photo that couldn't be checked." };
  }
  return { enabled: true, reason: null };
}

// ---------------------------------------------------------------------------
// The wait
// ---------------------------------------------------------------------------

export type ProcessingPhase = "matching" | "preparing";

export const PROCESSING_LABEL: Record<ProcessingPhase, string> = {
  matching: "Matching students…",
  preparing: "Preparing your list…",
};

/** "8 s", "1 min 05 s" — how long the teacher has been waiting. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export type MatchingAvailability = RecognitionAvailability;

export interface ReadyInput {
  /** Students in today's register. */
  total: number;
  /**
   * The register's own count of present students, once it is written — the
   * recognised, plus anyone a teacher already marked in an earlier round.
   * Falls back to the recognition run's count when there is no register.
   */
  present?: number;
  recognition: {
    recognised: number;
    lookAlikes: number;
    detectedFaces: number;
    unknownFaces: number;
    comparableStudents: number;
    needReenrolment: number;
    recommendRetake: boolean;
  } | null;
  availability: MatchingAvailability | null;
}

export interface ReadySummary {
  total: number;
  /** Present: recognised by the camera (recorded present) or already marked. */
  present: number;
  /** Everyone else: waiting for the teacher's decision. */
  toCheck: number;
  notices: Array<{ tone: "info" | "warning"; text: string }>;
}

function students(n: number): string {
  return `${n} student${n === 1 ? "" : "s"}`;
}

/**
 * "Attendance ready", summed up. Recognised students are recorded present;
 * everyone else waits for the teacher on the next screen. Nobody is ever
 * counted absent here — only a person marks a student absent.
 */
export function readySummaryOf(input: ReadyInput): ReadySummary {
  const recognised = Math.min(input.recognition?.recognised ?? 0, input.total);
  const present = Math.min(input.present ?? recognised, input.total);
  const notices: ReadySummary["notices"] = [];
  const r = input.recognition;

  if (input.availability && input.availability !== "ready") {
    notices.push({
      tone: "warning",
      text: "Face matching isn't fully available right now. Check every student yourself on the next screen.",
    });
  }
  if (r) {
    if (r.detectedFaces === 0) {
      notices.push({
        tone: "warning",
        text: "No faces were found in the photos, so nobody was recognised. Everyone is waiting for you to mark them.",
      });
    } else if (recognised === 0 && present === 0) {
      notices.push({
        tone: "warning",
        text:
          r.comparableStudents === 0
            ? "Nobody in this class has a face photo on file yet, so nobody could be recognised."
            : "Nobody was recognised clearly enough. Check each student on the next screen.",
      });
    }
    if (r.recommendRetake) {
      notices.push({
        tone: "info",
        text: "Some faces were too small to recognise. A closer photo of the back rows helps — you can add one on the next screen.",
      });
    }
    if (r.lookAlikes > 0) {
      notices.push({
        tone: "info",
        text: `${students(r.lookAlikes)} looked too alike, or appeared twice, to be sure — check them yourself.`,
      });
    }
    if (r.needReenrolment > 0) {
      notices.push({
        tone: "info",
        text: `${students(r.needReenrolment)} need a new face photo before they can be recognised.`,
      });
    }
    if (r.unknownFaces > 0) {
      notices.push({
        tone: "info",
        text: `${faces(r.unknownFaces)} didn't match anyone in this class.`,
      });
    }
  }
  return { total: input.total, present, toCheck: Math.max(0, input.total - present), notices };
}
