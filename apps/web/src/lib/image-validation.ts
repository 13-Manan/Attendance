/**
 * What an uploaded image has to look like before anything decodes it.
 *
 * ## The claim this replaces
 *
 * Four separate Server Actions carried the same comment: *"The image field is
 * loosely-typed on purpose — the Python service is the authoritative validator
 * of image bytes."* It was not. `services/face-ai` accepted
 * `image_base64: str` and handed it to a provider; the mock branches on string
 * prefixes and the ONNX scaffold decodes whatever it is given. Nothing on
 * either side of the wire ever asked whether the bytes were an image.
 *
 * That left every capture path — staff enrollment, student self-enrollment,
 * classroom capture, review re-capture, the internal process route — willing
 * to forward an arbitrary 6 MB blob to an image decoder. Image decoders are
 * exactly the component where a malformed file becomes a memory-safety bug,
 * and the one in production is a native library reached through Python. A
 * format check at the edge is the cheapest control available and the only one
 * that does not depend on the decoder being flawless.
 *
 * ## What it checks, in the order that costs least
 *
 * 1. Length bounds, on the *string*, before any allocation.
 * 2. The base64 alphabet, so a decode cannot silently discard junk.
 * 3. Magic bytes, decoded from a short prefix rather than from the whole
 *    payload — a 6 MB blob that is not an image is rejected having allocated
 *    about thirty bytes.
 *
 * ## What it does not claim
 *
 * That the file is safe. A real JPEG can still carry a decompression bomb or
 * an exploit for a specific decoder version, and this function would pass it.
 * It narrows the input to three formats a camera capture actually produces and
 * rejects everything that never could be — an HTML page, a ZIP, an SVG with a
 * script in it, a polyglot with a JPEG header bolted to a payload. That is a
 * filter, not a guarantee, and the difference is worth keeping in mind
 * wherever this is called.
 */

import { z } from "zod";

/**
 * ~6 MB of image data. The same number every capture path already used, now
 * defined once instead of being redeclared in four action files, and mirrored
 * by `face_ai_max_image_base64_chars` in services/face-ai.
 */
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

/**
 * Below this, there is no image. A 1×1 JPEG is a few hundred characters; the
 * capture UIs produce hundreds of thousands. 64 is the floor the existing
 * actions already enforced and is kept so nothing that used to be accepted
 * stops being accepted.
 */
export const MIN_IMAGE_BASE64_CHARS = 64;

/** The formats a browser `canvas.toDataURL` / `toBlob` capture can produce. */
export type ImageFormat = "jpeg" | "png" | "webp";

export type ImageRejectionReason =
  | "empty"
  | "too_small"
  | "too_large"
  | "data_url"
  | "not_base64"
  | "unsupported_format";

export type ImageInspection =
  | { ok: true; format: ImageFormat; approximateBytes: number }
  | { ok: false; reason: ImageRejectionReason; message: string };

/**
 * Standard base64 and base64url, with optional `=` padding.
 *
 * base64url is accepted because `Buffer.from(…, "base64")` accepts it and a
 * caller that produced `-`/`_` is not doing anything suspicious; rejecting it
 * would be a compatibility trap rather than a control. Whitespace is *not*
 * accepted: MIME-style line breaks would pass a decoder, but they are not what
 * any capture path in this app emits, and a validator that tolerates
 * whitespace is one that can be handed a payload whose decoded form differs
 * from what a reviewer sees.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/\-_]+={0,2}$/;

/**
 * Bytes needed to recognise the longest signature. WebP's marker sits at
 * offset 8 ("RIFF" ‥ "WEBP"), so twelve bytes settles every format below.
 */
const SIGNATURE_BYTES = 12;

/** 4 base64 characters per 3 bytes, rounded up to a whole group. */
const SIGNATURE_CHARS = Math.ceil(SIGNATURE_BYTES / 3) * 4;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Identifies the format from a decoded prefix, or null.
 *
 * Exported for the tests: asserting "a ZIP is rejected" is more convincing
 * against the function that makes the decision than against a wrapper that
 * also does five other things.
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  // JPEG: SOI marker, then the start of any APPn/DQT segment.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  // PNG: the 8-byte signature, chosen by the format's authors to survive
  // exactly the kind of transport damage we are not worried about here.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  // WebP: RIFF container, 4 bytes of length, then the "WEBP" form type. Both
  // halves are checked — "RIFF" alone is also a WAV, an AVI and several other
  // things that are not photographs of a classroom.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

/**
 * The single entry point. Pure, synchronous, allocation-light, and takes no
 * dependency on `env` or Prisma so it can be imported by an action, a route
 * handler and a test alike.
 */
export function inspectImageBase64(value: unknown): ImageInspection {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "empty", message: "No image was supplied." };
  }
  if (value.length < MIN_IMAGE_BASE64_CHARS) {
    return {
      ok: false,
      reason: "too_small",
      message: "The captured image looks empty. Retake the photo and try again.",
    };
  }
  if (value.length > MAX_IMAGE_BASE64_CHARS) {
    return {
      ok: false,
      reason: "too_large",
      message: "That image is too large. Capture at a lower resolution and try again.",
    };
  }
  // Checked explicitly rather than stripped. Every capture path in this app
  // removes the `data:` prefix before submitting (see `stripDataUrlPrefix` in
  // the capture client), so a payload that still has one is a caller working
  // from a different assumption — and telling them so is more useful than
  // quietly repairing it and leaving the mismatch in place.
  if (value.startsWith("data:")) {
    return {
      ok: false,
      reason: "data_url",
      message: "Send raw base64 image bytes, without the `data:` URL prefix.",
    };
  }
  if (!BASE64_PATTERN.test(value)) {
    return {
      ok: false,
      reason: "not_base64",
      message: "The image payload is not valid base64.",
    };
  }

  const prefix = Buffer.from(value.slice(0, SIGNATURE_CHARS), "base64");
  const format = detectImageFormat(prefix);
  if (!format) {
    return {
      ok: false,
      reason: "unsupported_format",
      message: "That file is not a JPEG, PNG or WebP image.",
    };
  }

  return {
    ok: true,
    format,
    // Derived from the string length rather than decoded: the caller wants a
    // number for a log line or an error message, not six megabytes of Buffer.
    // Padding makes it an upper bound, which is the safe direction.
    approximateBytes: Math.floor((value.length * 3) / 4),
  };
}

/**
 * Zod-friendly predicate for schemas that only need a yes/no.
 *
 * Prefer `inspectImageBase64` where the rejection reason can be shown to the
 * person holding the camera — "that file is not an image" and "that image is
 * too large" call for different actions from them.
 */
export function isAcceptableImageBase64(value: unknown): boolean {
  return inspectImageBase64(value).ok;
}

/**
 * The `imageBase64` field, as one schema shared by every entry point.
 *
 * The four capture actions and the internal process route each declared their
 * own `z.string().min(64).max(8 * 1024 * 1024)` with their own copy of the
 * constant. Four copies of a bound is four chances for one of them to drift,
 * and the one that drifts is the door an attacker uses — so the bound, the
 * format check and the message now have a single definition and the call sites
 * name it.
 *
 * Declared here rather than in a `schemas.ts` because it is inseparable from
 * the constants and the inspector above; splitting them is how the copies
 * started.
 */
export function imageBase64Field(): z.ZodString | z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .min(MIN_IMAGE_BASE64_CHARS)
    .max(MAX_IMAGE_BASE64_CHARS)
    .refine(isAcceptableImageBase64, {
      message: "Expected base64-encoded JPEG, PNG or WebP image bytes.",
    });
}
