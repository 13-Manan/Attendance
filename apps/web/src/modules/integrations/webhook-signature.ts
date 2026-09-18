import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "@/lib/crypto";

/**
 * Webhook signing.
 *
 * ## What a receiver needs to be able to prove
 *
 * Three things, and a naive `HMAC(secret, body)` gives only the first:
 *
 * 1. **This came from us.** HMAC over the body with a shared secret.
 * 2. **This is not a replay.** A captured delivery is a perfectly valid
 *    signed message forever. The timestamp is therefore *inside* the signed
 *    material — signing the body alone lets an attacker replay
 *    `attendance.finalized` a thousand times and the signature checks out
 *    every time.
 * 3. **We can rotate the secret without downtime.** The header carries a list
 *    of signatures, so during a rotation a receiver that has either the old
 *    or the new secret sees a match.
 *
 * ## The header
 *
 *   `X-Attendance-Signature: t=1758000000,v1=<hex>,v1=<hex>`
 *
 * Scheme-versioned (`v1=`) so a future move to a different MAC is additive: a
 * receiver ignores versions it does not know and keeps working. This is the
 * same construction Stripe and GitHub use, which matters more than elegance —
 * an integrator has almost certainly written the verifier before.
 *
 * The signed payload is `${timestamp}.${rawBody}`. It must be the **raw**
 * body: a receiver that parses JSON and re-serialises it before verifying
 * will get a different byte sequence and a failed check, which is why the
 * documentation for this says so in bold.
 *
 * Pure except for `randomBytes`. See webhook-signature.test.ts.
 */

export const SIGNATURE_HEADER = "X-Attendance-Signature";
export const EVENT_ID_HEADER = "X-Attendance-Event-Id";
export const EVENT_TYPE_HEADER = "X-Attendance-Event-Type";
export const DELIVERY_ID_HEADER = "X-Attendance-Delivery-Id";
export const ATTEMPT_HEADER = "X-Attendance-Delivery-Attempt";

const SCHEME = "v1";

/**
 * How far a delivery's timestamp may be from the receiver's clock.
 *
 * Five minutes is the usual figure and is a compromise between two real
 * failure modes: too tight and an unsynchronised school server rejects every
 * legitimate delivery, too loose and a captured request stays replayable for
 * hours. Exported so a receiver implementing the check in another language
 * has a number to copy rather than invent.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** 32 bytes of entropy, hex, prefixed so a leaked secret is identifiable. */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},${SCHEME}=${signPayload(secret, timestamp, body)}`;
}

export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index === -1) return null;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      timestamp = parsed;
    } else if (key === SCHEME) {
      signatures.push(value);
    }
    // Unknown keys are skipped, not rejected: that is what makes adding a
    // `v2=` later a non-breaking change for receivers running this code.
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export type VerifyFailure =
  | "malformed_header"
  | "timestamp_outside_tolerance"
  | "no_matching_signature";

export type VerifyResult = { valid: true } | { valid: false; reason: VerifyFailure };

/**
 * The verifier we ship, and the one documented for receivers to reimplement.
 *
 * It lives here rather than only in documentation because this repo is also a
 * *receiver* — the webhook provider can accept inbound pushes from an
 * external system — and because a verifier with tests beats a verifier in a
 * markdown file.
 *
 * `secrets` is a list so a rotation window works: put the new secret first,
 * keep the old one until every delivery has drained, then drop it.
 */
export function verifySignature(
  header: string | null,
  body: string,
  secrets: readonly string[],
  nowSeconds: number,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): VerifyResult {
  if (!header) return { valid: false, reason: "malformed_header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  // Absolute difference, not `now - t`: a receiver whose clock is *behind*
  // ours sees a future timestamp, and rejecting only old ones would accept a
  // signature minted arbitrarily far in the future.
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return { valid: false, reason: "timestamp_outside_tolerance" };
  }

  for (const secret of secrets) {
    const expected = signPayload(secret, parsed.timestamp, body);
    // Each comparison is constant-time, which is the part that matters: a
    // byte-at-a-time `===` lets a caller discover the expected digest by
    // measuring. The loop itself does short-circuit, so timing reveals *which
    // secret in a rotation matched* — that is not a secret, only an index
    // into a list the receiver already holds.
    if (parsed.signatures.some((candidate) => safeEqual(candidate, expected))) {
      return { valid: true };
    }
  }
  return { valid: false, reason: "no_matching_signature" };
}
