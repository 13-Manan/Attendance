/**
 * What must never reach a log line, an audit row, or an error body.
 *
 * ## Why this is a denylist and why that is not the usual mistake
 *
 * A denylist is normally the wrong shape for a security control, because
 * anything unnamed passes. It is right *here* for one reason: the alternative
 * is an allowlist of loggable fields, and the thing being logged is an
 * arbitrary integration payload from a system nobody in this repo has seen.
 * An allowlist over unknown input logs nothing, and a redactor that logs
 * nothing gets turned off within a week — at which point everything leaks.
 *
 * So: the denylist is the floor, not the ceiling. Two things make up for its
 * shape. Matching is on *substrings of the key, case-insensitively*, so
 * `secret`, `clientSecret`, `SIGNING_SECRET` and `webhook_secret_v2` are all
 * caught by one entry. And the structural rules below catch the payload this
 * codebase most needs never to log — a face embedding — by its shape rather
 * than its name, because a provider is free to call it `v`, `f`, or `data`.
 *
 * ## The four the brief names
 *
 * - passwords — `password`, and every hash/salt/confirm variant
 * - secrets — `secret`, `credential`, `privateKey`
 * - biometric embeddings — by name, and by shape (long numeric arrays)
 * - sensitive tokens — `token`, `authorization`, `cookie`, `apiKey`, `session`
 *
 * Pure module. No I/O, no Prisma. See redaction.test.ts.
 */

/** Substrings that condemn a key, whatever else surrounds them. */
const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "authorization",
  "auth_header",
  "cookie",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "signature",
  "embedding",
  "biometric",
  "faceprint",
  "descriptor",
  "salt",
  "pepper",
  "hash",
  "otp",
  "pin",
  "ssn",
  "aadhaar",
] as const;

export const REDACTED = "[redacted]";

/**
 * Normalised so `client-secret`, `client_secret` and `clientSecret` are the
 * same question. Without this, snake_case from an external ERP would sail
 * past a camelCase denylist.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(normalizeKey(part)));
}

/**
 * The shape test for an embedding.
 *
 * A 512-float vector is what `services/face-ai` returns, and it is the one
 * value in this system whose leak is irreversible — a student cannot be
 * issued a new face. Name matching is not enough when the payload comes from
 * an adapter someone else wrote, so any numeric array past this length is
 * summarised rather than printed. Sixteen is well above anything legitimately
 * logged (a grade list, a set of period numbers) and well below any
 * embedding dimension in use.
 */
const NUMERIC_ARRAY_LIMIT = 16;

function isNumericVector(value: unknown[]): boolean {
  return value.length > NUMERIC_ARRAY_LIMIT && value.every((v) => typeof v === "number");
}

/** Strings longer than this are truncated — a base64 blob is not a log line. */
const MAX_STRING_LENGTH = 512;

/** Arrays longer than this are summarised, to bound a single log entry. */
const MAX_ARRAY_LENGTH = 50;

/** Depth past which we stop walking, so a cyclic or absurd payload terminates. */
const MAX_DEPTH = 8;

/**
 * Returns a copy of `value` safe to write to a log or an audit row.
 *
 * Never mutates its input: the caller is usually holding the live request
 * payload, and redacting in place would silently corrupt the thing being
 * processed. This is the difference between a logging concern and a data-loss
 * bug.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[truncated: max depth]";

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length} chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  // A function or symbol in a payload is a programming error upstream, but it
  // must not crash the logger that discovers it.
  if (typeof value !== "object") return `[${typeof value}]`;

  if (Array.isArray(value)) {
    if (isNumericVector(value)) return `[redacted: ${value.length}-dim numeric vector]`;
    const slice = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      slice.push(`…[${value.length - MAX_ARRAY_LENGTH} more]`);
    }
    return slice;
  }

  if (value instanceof Error) {
    // Deliberately not `stack`: a stack frame can carry a file path and, from
    // a template literal, a value. The message is the actionable part.
    return { name: value.name, message: redact(value.message, depth + 1) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

/**
 * Header redaction for the access log.
 *
 * Headers get their own function because the interesting ones are a short,
 * known list and everything else is noise. Allowlisting is correct *here* —
 * unlike a body, the header set is not open-ended — so `Authorization` cannot
 * leak through a header name this list forgot.
 */
const LOGGABLE_HEADERS = [
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "x-request-id",
  "x-idempotency-key",
] as const;

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LOGGABLE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value.slice(0, MAX_STRING_LENGTH);
  }
  // Recorded as present/absent rather than dropped: "was this request
  // authenticated at all" is the first question asked of a 401, and the
  // answer is not the credential.
  out["authorization"] = headers.has("authorization") ? "[present]" : "[absent]";
  return out;
}

/**
 * Strips a query string of anything sensitive while keeping the shape.
 *
 * Endpoints here take no credentials in the query string — that is what the
 * `Authorization` header is for — but integrators do it anyway, and a
 * `?api_key=` that someone appended out of habit must not become permanent in
 * an audit table.
 */
export function redactQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    out[key] = isSensitiveKey(key) ? REDACTED : value.slice(0, 200);
  }
  return out;
}

/**
 * Last four characters of a credential, for "which key was this?".
 *
 * Four is short enough to be useless as a credential and long enough to pick
 * one key out of an institution's handful. Anything shorter than eight
 * characters is not a real key, and showing a suffix of it would be showing
 * a meaningful fraction of the thing — so those redact whole.
 */
export function keyFingerprint(rawKey: string): string {
  if (rawKey.length < 8) return REDACTED;
  return `…${rawKey.slice(-4)}`;
}
