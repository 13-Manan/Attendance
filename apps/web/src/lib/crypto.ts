import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 a secret with a server-held key, for the "hash a high-entropy
 * token, look it up by hash, never store the raw value" pattern used by both
 * ApiKey.hashedKey and Session.tokenHash. Not for passwords — those need a
 * slow, memory-hard KDF (see modules/auth-tenancy/password.ts), not HMAC.
 */
export function hmacHash(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/**
 * Constant-time string comparison, for the places where we hold both sides.
 *
 * Not needed by the hash-lookup pattern above — there is nothing to compare
 * when the database index does the matching. It is needed for webhook
 * signature verification, where a caller-supplied signature is checked against
 * one we just computed, and a naive `===` leaks the correct value one byte at
 * a time to anyone willing to measure.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // (much coarser) oracle. Comparing lengths first is unavoidable and
  // harmless: the length of a hex digest is public.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
