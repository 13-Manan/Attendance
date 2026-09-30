import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { detectImageFormat, jpegDimensions } from "@/lib/image-validation";
import { MAX_CAPTURE_EDGE } from "./capture-support";

/**
 * What the server can check about a self-enrollment capture before it
 * believes it came from this app's camera flow.
 *
 * ## The problem
 *
 * Self-enrollment is camera only: a student enrols the face in front of their
 * own camera, not a photograph of somebody. Hiding the upload control is not
 * enforcement — the Server Action is an HTTP endpoint, and `captureSource:
 * "CAMERA"` is a string the client writes. So the server asks for two things
 * the camera flow produces and a file upload does not:
 *
 * 1. **A camera session.** The portal asks the server for a short-lived token
 *    when the camera starts, and every capture sends it back. It is an HMAC
 *    over the student, the account, the institution and the time, so it cannot
 *    be minted by the browser, cannot be carried to another student or
 *    institution, and stops working after `SELF_CAPTURE_TOKEN_TTL_MS`.
 * 2. **A frame shaped like this page's capture.** The capture code draws the
 *    video frame onto a canvas scaled to at most `MAX_CAPTURE_EDGE` and encodes
 *    it as JPEG. A PNG, a WebP, or a phone photograph at its native 4032×3024
 *    is not something that code can produce, and is refused.
 *
 * ## What this cannot prove
 *
 * That photons reached a sensor. The browser belongs to the student: a
 * virtual camera device, or a script that calls the action with a token it
 * fetched, can present any JPEG of the right size. No web server can tell a
 * real camera from a faked one without device attestation, which browsers do
 * not offer. These checks remove the upload path the UI would otherwise imply
 * and every casual route around it; the protection against enrolling somebody
 * else's face is the same as on every other path — the quality gates, the
 * duplicate scan against every enrolled student, and the audit trail.
 *
 * Pure and synchronous: the key and the clock are arguments, so the tests need
 * no environment.
 */

/** How long a camera session may be used for. Long enough for five guided photos and a retake or two. */
export const SELF_CAPTURE_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * How far in the future an issue time may be. Replicas share a clock source
 * but not a clock; a token issued by one and checked by another a few
 * milliseconds "earlier" must not be refused.
 */
const CLOCK_SKEW_MS = 60 * 1000;

const HKDF_INFO = "attendance:face-self-capture-token:v1";
const MAC_DOMAIN = "attendance:face-self-capture:v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 16;

/** Longest token accepted before any parsing — three short base64url fields. */
export const MAX_SELF_CAPTURE_TOKEN_CHARS = 256;

/**
 * The signing key, derived from the session secret.
 *
 * Its own key, not the session secret itself: HKDF with a label nothing else
 * uses, so a MAC from here is never a valid value anywhere else and the other
 * way round. Deriving from `AUTH_SECRET` rather than adding a secret is the
 * same trade the webhook key makes (lib/secret-box.ts): whoever holds
 * `AUTH_SECRET` can already forge a session, which is strictly more than a
 * camera token lets anyone do.
 */
export function deriveSelfCaptureKey(authSecret: string | undefined): Buffer {
  if (!authSecret) {
    throw new Error("AUTH_SECRET is not set, so a self-enrollment camera session cannot be signed.");
  }
  return Buffer.from(hkdfSync("sha256", authSecret, "", HKDF_INFO, KEY_BYTES));
}

/** Whose camera session a token is. Every field comes from the server, never the request. */
export interface SelfCaptureBinding {
  userId: string;
  studentId: string;
  institutionId: string;
}

function mac(key: Buffer, binding: SelfCaptureBinding, issuedAt: number, nonce: string): Buffer {
  return createHmac("sha256", key)
    .update(
      [MAC_DOMAIN, binding.userId, binding.studentId, binding.institutionId, String(issuedAt), nonce].join("\n"),
    )
    .digest();
}

export function issueSelfCaptureToken(
  key: Buffer,
  binding: SelfCaptureBinding,
  now: number,
  nonce: Buffer = randomBytes(NONCE_BYTES),
): { token: string; expiresAt: number } {
  const issuedAt = Math.floor(now);
  const encodedNonce = nonce.toString("base64url");
  const signature = mac(key, binding, issuedAt, encodedNonce).toString("base64url");
  return {
    token: `${issuedAt.toString(36)}.${encodedNonce}.${signature}`,
    expiresAt: issuedAt + SELF_CAPTURE_TOKEN_TTL_MS,
  };
}

export type SelfCaptureTokenProblem = "missing" | "malformed" | "expired" | "not_yet_valid" | "mismatch";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Checks a token against the binding the server resolved for this request.
 *
 * The signature is compared in constant time, and only after the cheap
 * structural checks, so a malformed value costs nothing. "mismatch" covers a
 * forged token and a genuine one from another student, account or institution
 * alike — the caller has no need to learn which.
 */
export function verifySelfCaptureToken(
  key: Buffer,
  token: unknown,
  binding: SelfCaptureBinding,
  now: number,
): { ok: true } | { ok: false; problem: SelfCaptureTokenProblem } {
  if (typeof token !== "string" || token.length === 0) return { ok: false, problem: "missing" };
  if (token.length > MAX_SELF_CAPTURE_TOKEN_CHARS) return { ok: false, problem: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, problem: "malformed" };
  const [issuedAtPart, nonce, signature] = parts;
  if (!/^[0-9a-z]{1,12}$/.test(issuedAtPart) || !BASE64URL.test(nonce) || !BASE64URL.test(signature)) {
    return { ok: false, problem: "malformed" };
  }
  const issuedAt = Number.parseInt(issuedAtPart, 36);
  if (!Number.isSafeInteger(issuedAt)) return { ok: false, problem: "malformed" };

  const expected = mac(key, binding, issuedAt, nonce);
  const presented = Buffer.from(signature, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, problem: "mismatch" };
  }

  if (issuedAt - now > CLOCK_SKEW_MS) return { ok: false, problem: "not_yet_valid" };
  if (now - issuedAt > SELF_CAPTURE_TOKEN_TTL_MS) return { ok: false, problem: "expired" };
  return { ok: true };
}

export type SelfCaptureImageProblem = "not_jpeg" | "no_dimensions" | "too_large";

/**
 * Base64 characters decoded to find the frame header. A canvas JPEG declares
 * its size in the first few hundred bytes — after the JFIF header and the
 * quantisation tables — so 64 KiB is generous, and a file that needs more is
 * not one the capture code wrote. A multiple of four, so the prefix decodes
 * cleanly.
 */
const HEADER_SCAN_CHARS = 64 * 1024;

/**
 * Whether the image is a frame the capture code could have produced: a JPEG
 * whose longest edge is at most `MAX_CAPTURE_EDGE`.
 *
 * Runs after `imageBase64Field()` has checked the size bounds and the
 * alphabet, and decodes only a prefix, so a large payload costs no more than
 * a small one. It does not replace the quality gates — a JPEG of the right
 * size can still be a photograph of nobody.
 */
export function inspectSelfCapture(
  imageBase64: unknown,
): { ok: true; width: number; height: number } | { ok: false; problem: SelfCaptureImageProblem } {
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    return { ok: false, problem: "not_jpeg" };
  }
  const prefix = Buffer.from(imageBase64.slice(0, HEADER_SCAN_CHARS), "base64");
  if (detectImageFormat(prefix) !== "jpeg") return { ok: false, problem: "not_jpeg" };

  const dimensions = jpegDimensions(prefix);
  if (!dimensions) return { ok: false, problem: "no_dimensions" };
  if (Math.max(dimensions.width, dimensions.height) > MAX_CAPTURE_EDGE) {
    return { ok: false, problem: "too_large" };
  }
  return { ok: true, ...dimensions };
}
