import {
  MAX_IMAGE_BASE64_CHARS,
  MIN_IMAGE_BASE64_CHARS,
  detectImageFormat,
} from "@/lib/image-validation";

/**
 * The classroom camera, as decisions rather than as markup.
 *
 * ## Why this file exists at all
 *
 * The camera used to be four `useState` calls and an inline `getUserMedia`
 * inside the capture wizard. That arrangement has one property that matters
 * more than its tidiness: nothing in it could be tested. A webcam cannot be
 * summoned in CI, so every camera behaviour — what a denied permission does,
 * whether a stream is released when the teacher navigates away, what happens
 * when the button is pressed twice — was verified by hand, once, and then
 * assumed.
 *
 * Everything here is pure and DOM-free. The state machine below decides what
 * the camera *is doing*; `camera-source.ts` owns the one impure act of asking
 * the browser for a stream, behind an interface a fixture can satisfy. The
 * production path still calls `navigator.mediaDevices.getUserMedia` — this is
 * not a fake camera, it is the real camera with a seam in front of it.
 *
 * ## What it deliberately does not do
 *
 * Decide anything about attendance. A frame captured here is bytes; whether
 * those bytes contain a student, and which one, is the server's question.
 */

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * Why the camera is not running.
 *
 * A closed set rather than a string, because the five cases need five
 * different things from the person holding the device and the UI has to be
 * able to tell them apart — "allow it in settings" is useless advice to
 * somebody whose laptop has no camera.
 *
 * Matched on `DOMException.name`, which is specified, rather than on the
 * message text, which is not and differs between browsers.
 */
export type CameraErrorKind =
  /** The user, the OS, or a policy said no. Recoverable by the user. */
  | "permission_denied"
  /** There is no camera, or none matching the constraints. */
  | "no_device"
  /** Another application holds the camera. */
  | "device_in_use"
  /** `getUserMedia` does not exist here — an insecure origin, usually. */
  | "insecure_context"
  /** Anything else. Always retryable, because we cannot say it is not. */
  | "unknown";

export interface CameraFailure {
  kind: CameraErrorKind;
  /** Shown to the faculty member. Says what to do, not what went wrong. */
  message: string;
  /** Whether offering a "Try again" button is honest. */
  retryable: boolean;
}

const FAILURES: Record<CameraErrorKind, Omit<CameraFailure, "kind">> = {
  permission_denied: {
    message:
      "Camera access was blocked. Allow the camera for this site in your browser's address bar or settings, then try again.",
    retryable: true,
  },
  no_device: {
    message:
      "No camera was found on this device. Connect a webcam, or use a phone or tablet to take attendance.",
    retryable: true,
  },
  device_in_use: {
    message:
      "Another application is using the camera. Close it — video calls are the usual culprit — and try again.",
    retryable: true,
  },
  insecure_context: {
    message:
      "The camera needs a secure (HTTPS) connection. Open this page over HTTPS to capture attendance.",
    retryable: false,
  },
  unknown: {
    message: "The camera could not be started. Try again, or use a different device.",
    retryable: true,
  },
};

export function classifyCameraError(error: unknown): CameraErrorKind {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission_denied";
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return "no_device";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "device_in_use";
    case "TypeError":
      // `getUserMedia` is undefined on an insecure origin, so calling it
      // throws a TypeError rather than a DOMException.
      return "insecure_context";
    default:
      return "unknown";
  }
}

export function describeCameraFailure(error: unknown): CameraFailure {
  const kind = classifyCameraError(error);
  return { kind, ...FAILURES[kind] };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface CameraDevice {
  deviceId: string;
  label: string;
}

/**
 * Every state the camera can be in, and nothing else.
 *
 * The Phase 4 spec enumerates camera states down to "permission prompt" and
 * "no camera device"; they are listed separately here because each one renders
 * differently and, more importantly, because a state that has no name tends to
 * render as a blank box with a spinner in it.
 *
 * `unsupported` is distinct from the `unavailable` failure: the first means
 * this browser has no camera API at all (so the UI should not offer a retry),
 * the second means an attempt was made and failed.
 */
export type CameraState =
  /** `navigator.mediaDevices` is absent. Nothing to retry. */
  | { name: "unsupported" }
  /** Supported, never started. The resting state. */
  | { name: "idle" }
  /** `getUserMedia` is in flight; the permission prompt may be on screen. */
  | { name: "starting" }
  /** Streaming to the preview. The only state a capture may be taken from. */
  | { name: "ready"; deviceId: string | null; deviceLabel: string | null }
  /** A frame is being encoded. Brief, but it disables the shutter. */
  | { name: "capturing"; deviceId: string | null; deviceLabel: string | null }
  /** Stopped after a failure. Carries what to tell the user. */
  | { name: "failed"; failure: CameraFailure };

export type CameraEvent =
  | { type: "unsupported" }
  | { type: "start" }
  | { type: "started"; deviceId: string | null; deviceLabel: string | null }
  | { type: "capture" }
  | { type: "captured" }
  | { type: "fail"; failure: CameraFailure }
  | { type: "stop" };

/**
 * The transition table.
 *
 * Written as a reducer so the awkward sequences — press capture twice, fail
 * while starting, stop while capturing — are assertions in a test file rather
 * than a hope. Unknown transitions return the current state unchanged: an
 * event arriving in the wrong state is a race, not a bug to crash on, and the
 * camera should carry on doing whatever it was doing.
 */
export function cameraReducer(state: CameraState, event: CameraEvent): CameraState {
  switch (event.type) {
    case "unsupported":
      return { name: "unsupported" };

    case "start":
      // A browser with no camera API must never reach `starting` — there is
      // nothing to wait for, and the UI would show "allow access if your
      // browser asks" to somebody who will never be asked.
      if (state.name === "unsupported") return state;
      // Guard against a second start while one is in flight. Two overlapping
      // `getUserMedia` calls return two MediaStreams, only one of which any
      // reference survives — the other keeps the camera light on until the tab
      // closes. Ignoring the second press is the whole fix.
      if (state.name === "starting" || state.name === "ready" || state.name === "capturing") {
        return state;
      }
      return { name: "starting" };

    case "started":
      // A stream that arrives after the user already pressed stop is dropped
      // by the caller; reaching `ready` from anywhere but `starting` would
      // mean showing a preview nobody asked for.
      if (state.name !== "starting") return state;
      return { name: "ready", deviceId: event.deviceId, deviceLabel: event.deviceLabel };

    case "capture":
      if (state.name !== "ready") return state;
      return { name: "capturing", deviceId: state.deviceId, deviceLabel: state.deviceLabel };

    case "captured":
      if (state.name !== "capturing") return state;
      return { name: "ready", deviceId: state.deviceId, deviceLabel: state.deviceLabel };

    case "fail":
      if (state.name === "unsupported") return state;
      return { name: "failed", failure: event.failure };

    case "stop":
      if (state.name === "unsupported") return state;
      return { name: "idle" };
  }
}

export const INITIAL_CAMERA_STATE: CameraState = { name: "idle" };

/** True only where taking a photograph is meaningful. */
export function canCapture(state: CameraState): boolean {
  return state.name === "ready";
}

/** True where offering a "start the camera" control makes sense. */
export function canStart(state: CameraState): boolean {
  return state.name === "idle" || (state.name === "failed" && state.failure.retryable);
}

/** The line of text that belongs over the viewfinder in each state. */
export function cameraStatusLabel(state: CameraState): string {
  switch (state.name) {
    case "unsupported":
      return "This browser cannot open a camera";
    case "idle":
      return "Camera not started";
    case "starting":
      return "Starting the camera — allow access if your browser asks";
    case "ready":
      return state.deviceLabel ? `Ready · ${state.deviceLabel}` : "Camera ready";
    case "capturing":
      return "Capturing…";
    case "failed":
      return state.failure.message;
  }
}

// ---------------------------------------------------------------------------
// Capture geometry
// ---------------------------------------------------------------------------

/**
 * The longest edge a classroom capture is scaled down to.
 *
 * Deliberately larger than the 1280 used for enrollment, and for a reason that
 * is about the subject rather than the file size: an enrollment photograph is
 * one face filling the frame, while this is thirty faces across a room. At
 * 1280 the back row lands at roughly forty pixels across, which is at or below
 * what a detector will find. 1920 keeps the far side of an ordinary classroom
 * detectable.
 *
 * Capping at all matters because a phone or a 4K webcam will otherwise hand
 * over a frame several times this size — the whole of which travels over the
 * network, through `MAX_IMAGE_BASE64_CHARS`, and into a decoder.
 */
export const MAX_CLASSROOM_CAPTURE_EDGE = 1920;

/**
 * JPEG quality for a classroom capture.
 *
 * Lower than enrollment's 0.92, because this frame is 2.25× the area and the
 * budget is the same. At 0.82 a 1920×1080 classroom photograph encodes to a
 * few hundred kilobytes — comfortably inside the payload bound with room for
 * three of them — and compression artefacts stay well below the scale of a
 * face.
 */
export const CLASSROOM_JPEG_QUALITY = 0.82;

/**
 * Scales a frame so its longest edge is at most `maxEdge`, preserving aspect
 * ratio and never scaling *up* — enlarging a 640×480 webcam frame invents no
 * detail and costs bytes.
 */
export function classroomCaptureDimensions(
  videoWidth: number,
  videoHeight: number,
  maxEdge: number = MAX_CLASSROOM_CAPTURE_EDGE,
): { width: number; height: number } {
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(videoWidth, videoHeight);
  if (longest <= maxEdge) {
    return { width: Math.round(videoWidth), height: Math.round(videoHeight) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface CapturedFrame {
  /** Raw base64, no `data:` prefix — what the wire contract wants. */
  imageBase64: string;
  /** The same bytes as a data URL, for the local `<img>` preview only. */
  dataUrl: string;
  width: number;
  height: number;
  approximateBytes: number;
}

export type CaptureFrameProblem =
  | "no_frame"
  | "encoder_unavailable"
  | "encode_failed"
  | "too_large"
  | "not_an_image";

export type CaptureFrameResult =
  | ({ ok: true } & CapturedFrame)
  | { ok: false; problem: CaptureFrameProblem; message: string };

const FRAME_PROBLEMS: Record<CaptureFrameProblem, string> = {
  no_frame:
    "The camera has not produced a frame yet. Give it a second and press capture again.",
  encoder_unavailable:
    "This browser could not read a frame from the camera. Try a different browser or device.",
  encode_failed: "The captured frame could not be encoded. Try again.",
  too_large:
    "That capture is too large to send. It will be retried at a lower resolution — press capture again.",
  not_an_image: "The captured frame was not a usable image. Try again.",
};

function frameProblem(problem: CaptureFrameProblem): CaptureFrameResult {
  return { ok: false, problem, message: FRAME_PROBLEMS[problem] };
}

/**
 * Splits a canvas data URL into the raw base64 the contract wants.
 *
 * Requires the header to end in `;base64` and splits on the *first* comma —
 * `data:text/plain,;base64,x` would otherwise yield the literal text after a
 * comma that is not the separator. Returns null rather than a plausible-looking
 * empty string, because the server refuses a `data:` prefix rather than quietly
 * repairing one and a silent mismatch here would surface as a validation error
 * with no useful message attached.
 */
export function splitDataUrl(dataUrl: string): string | null {
  if (!dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  if (!dataUrl.slice(0, comma).endsWith(";base64")) return null;
  const payload = dataUrl.slice(comma + 1);
  return payload.length > 0 ? payload : null;
}

/**
 * Validates an encoded frame before it is allowed anywhere near the network.
 *
 * Shares `MIN_IMAGE_BASE64_CHARS`, `MAX_IMAGE_BASE64_CHARS` and
 * `detectImageFormat` with the server's `inspectImageBase64`, so the two
 * cannot disagree about what an image is. The server remains the authority and
 * checks again; what this buys is that a teacher whose 4K webcam produced an
 * oversized frame is told to press capture again, rather than watching a Zod
 * error go past.
 *
 * `decodePrefix` is injected so this stays testable in Node, where `atob`
 * exists but the browser build's shape does not.
 */
export function inspectCapturedFrame(
  dataUrl: string,
  decodePrefix: (base64: string) => Uint8Array | null,
): CaptureFrameResult {
  const imageBase64 = splitDataUrl(dataUrl);
  if (!imageBase64) return frameProblem("encode_failed");
  if (imageBase64.length < MIN_IMAGE_BASE64_CHARS) return frameProblem("no_frame");
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) return frameProblem("too_large");

  const prefix = decodePrefix(imageBase64);
  if (!prefix || !detectImageFormat(prefix)) return frameProblem("not_an_image");

  return {
    ok: true,
    imageBase64,
    dataUrl,
    width: 0,
    height: 0,
    // Upper bound from the string length rather than a full decode; padding
    // makes it an over-estimate, which is the safe direction.
    approximateBytes: Math.floor((imageBase64.length * 3) / 4),
  };
}
