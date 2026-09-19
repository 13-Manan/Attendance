import {
  MAX_IMAGE_BASE64_CHARS,
  MIN_IMAGE_BASE64_CHARS,
  detectImageFormat,
  type ImageFormat,
} from "@/lib/image-validation";

/**
 * The parts of the capture UI that are decisions rather than markup.
 *
 * Pure and browser-agnostic, so the three things most likely to be wrong in a
 * camera component — what a `getUserMedia` failure actually means, whether a
 * chosen file is an image, and how a data URL becomes the bytes the contract
 * wants — can be asserted in a test runner with no DOM.
 *
 * None of this replaces the server's own validation. `lib/image-validation.ts`
 * is the authority and runs again on every submission; what happens here is
 * that somebody who picked a PDF finds out immediately instead of after a
 * round trip, and that the bounds and the format signatures have exactly one
 * definition between the two.
 */

// ---------------------------------------------------------------------------
// Data URLs
// ---------------------------------------------------------------------------

/**
 * Strips the `data:image/jpeg;base64,` prefix a canvas or a FileReader
 * produces.
 *
 * The wire contract wants raw base64 (see `EnrollRequest.imageBase64`), and
 * `inspectImageBase64` refuses a payload that still carries the prefix rather
 * than quietly repairing it — so this has to be right. Returns null for
 * anything that is not a base64 data URL, including the `data:...,<text>` form
 * that has no base64 marker and would otherwise yield a string of URL-encoded
 * characters that looks plausible and decodes to nothing.
 */
export function stripDataUrlPrefix(dataUrl: string): string | null {
  if (!dataUrl.startsWith("data:")) return null;

  // Split on the *first* comma, which is where a data URL's header ends, and
  // require the header to end in `;base64`. Searching for `;base64,` directly
  // would accept `data:text/plain,;base64,x`, whose payload is the literal
  // text after a comma that is not the separator.
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  if (!dataUrl.slice(0, comma).endsWith(";base64")) return null;

  const payload = dataUrl.slice(comma + 1);
  return payload.length > 0 ? payload : null;
}

// ---------------------------------------------------------------------------
// Client-side image inspection
// ---------------------------------------------------------------------------

export type ClientImageProblem = "empty" | "too_small" | "too_large" | "unsupported_format";

export type ClientImageInspection =
  | { ok: true; format: ImageFormat; approximateBytes: number }
  | { ok: false; problem: ClientImageProblem; message: string };

/** Bytes needed to recognise the longest signature; WebP's sits at offset 8. */
const SIGNATURE_BYTES = 12;
const SIGNATURE_CHARS = Math.ceil(SIGNATURE_BYTES / 3) * 4;

/**
 * Decodes a short base64 prefix into bytes, using the browser's `atob`.
 *
 * The server-side twin of this reaches for `Buffer`, which does not exist in a
 * browser bundle. Only the first twelve bytes are decoded either way: a 6 MB
 * file that is not an image is turned away having allocated about thirty
 * bytes, which matters on a phone holding a camera stream open.
 */
function decodeSignature(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64.slice(0, SIGNATURE_CHARS));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    // `atob` throws on a non-base64 alphabet. The server says the same thing
    // in its own words; here it is simply "not an image we can use".
    return null;
  }
}

/**
 * Whether a base64 payload is worth sending.
 *
 * Shares `MIN_IMAGE_BASE64_CHARS`, `MAX_IMAGE_BASE64_CHARS` and
 * `detectImageFormat` with the server check, so the two cannot disagree about
 * what an image is — a client that accepted something the server refuses would
 * produce a failure with no useful message attached to it.
 */
export function inspectImageInBrowser(base64: string): ClientImageInspection {
  if (base64.length === 0) {
    return { ok: false, problem: "empty", message: "No image was selected." };
  }
  if (base64.length < MIN_IMAGE_BASE64_CHARS) {
    return {
      ok: false,
      problem: "too_small",
      message: "That file looks empty. Choose a photograph and try again.",
    };
  }
  if (base64.length > MAX_IMAGE_BASE64_CHARS) {
    return {
      ok: false,
      problem: "too_large",
      message: "That image is too large. Choose one under about 6 MB, or use the camera instead.",
    };
  }

  const signature = decodeSignature(base64);
  const format = signature ? detectImageFormat(signature) : null;
  if (!format) {
    return {
      ok: false,
      problem: "unsupported_format",
      message: "That file is not a JPEG, PNG or WebP image.",
    };
  }

  return {
    ok: true,
    format,
    // From the string length rather than a full decode. Padding makes it an
    // upper bound, which is the safe direction for a size warning.
    approximateBytes: Math.floor((base64.length * 3) / 4),
  };
}

// ---------------------------------------------------------------------------
// Camera failures
// ---------------------------------------------------------------------------

/**
 * What a `getUserMedia` rejection means, in words the person can act on.
 *
 * The browser's own message is written for a developer — "Permission denied",
 * "Could not start video source" — and the four common failures need four
 * different actions from the user. Matched on `DOMException.name`, which is
 * specified, rather than on the message text, which is not and differs between
 * browsers.
 */
export function describeCameraError(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "The browser blocked access to the camera. Allow camera access for this site in your browser settings, then try again — or upload a photograph instead.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device. Upload a photograph instead.";
    case "NotReadableError":
    case "AbortError":
      return "The camera is already in use by another application. Close it and try again, or upload a photograph instead.";
    case "TypeError":
      return "This page needs a secure connection (HTTPS) to use the camera. Upload a photograph instead.";
    default:
      return "The camera could not be started. Upload a photograph instead.";
  }
}

/**
 * Whether this browser can offer the camera at all.
 *
 * `navigator.mediaDevices` is absent on an insecure origin as well as on a
 * browser without the API, so the check covers both cases that would otherwise
 * surface as a TypeError the moment somebody pressed the button. The component
 * uses it to decide whether to offer the camera tab, not to decide whether
 * enrollment is possible — upload always is.
 */
export function cameraIsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

// ---------------------------------------------------------------------------
// Capture geometry
// ---------------------------------------------------------------------------

/**
 * The longest edge a capture is scaled down to before encoding.
 *
 * A modern phone camera produces images far larger than any recognition model
 * consumes — the detector works on a few hundred pixels of face — and the
 * whole file is carried over the network, through the size bound, and into a
 * decoder. 1280 keeps a face at a comfortable size for detection from arm's
 * length while keeping a JPEG comfortably inside the payload limit.
 */
export const MAX_CAPTURE_EDGE = 1280;

/**
 * JPEG quality for a capture.
 *
 * High enough that compression artefacts do not become the reason a face is
 * judged blurred, low enough that a 1280px frame stays a few hundred kilobytes.
 */
export const CAPTURE_JPEG_QUALITY = 0.92;

/**
 * Scales a frame so its longest edge is at most `MAX_CAPTURE_EDGE`, preserving
 * the aspect ratio and never scaling *up* — enlarging a 480p webcam frame adds
 * no detail and costs bytes.
 */
export function captureDimensions(
  videoWidth: number,
  videoHeight: number,
  maxEdge: number = MAX_CAPTURE_EDGE,
): { width: number; height: number } {
  if (videoWidth <= 0 || videoHeight <= 0) return { width: 0, height: 0 };
  const longest = Math.max(videoWidth, videoHeight);
  if (longest <= maxEdge) return { width: videoWidth, height: videoHeight };
  const scale = maxEdge / longest;
  return {
    width: Math.round(videoWidth * scale),
    height: Math.round(videoHeight * scale),
  };
}
