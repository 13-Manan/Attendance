import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, isSensitiveKey, keyFingerprint, redact, redactHeaders, redactQuery } from "./redaction.ts";

// ---------------------------------------------------------------------------
// The four things the brief says must never be logged
// ---------------------------------------------------------------------------

test("passwords are redacted under every casing and separator", () => {
  for (const key of [
    "password",
    "Password",
    "PASSWORD",
    "user_password",
    "userPassword",
    "passwd",
    "password_hash",
    "passwordConfirmation",
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }
});

test("secrets are redacted under every casing and separator", () => {
  for (const key of [
    "secret",
    "clientSecret",
    "client_secret",
    "CLIENT-SECRET",
    "signing_secret",
    "webhook_secret_v2",
    "credentials",
    "privateKey",
    "private_key",
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }
});

test("tokens and auth material are redacted", () => {
  for (const key of [
    "token",
    "accessToken",
    "refresh_token",
    "authorization",
    "Authorization",
    "cookie",
    "apiKey",
    "api_key",
    "X-Api-Key",
    "signature",
  ]) {
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }
});

test("biometric material is redacted by name", () => {
  for (const key of ["embedding", "faceEmbedding", "biometric", "faceprint", "descriptor"]) {
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }
});

test("a face embedding is redacted by shape even when the key is innocent", () => {
  // This is the case the denylist cannot catch: a third-party adapter that
  // names a 512-float vector `v`. The value must still never be logged.
  const payload = { studentId: "stu-1", v: Array.from({ length: 512 }, (_, i) => i / 512) };
  const result = redact(payload) as Record<string, unknown>;
  assert.equal(result.studentId, "stu-1");
  assert.equal(result.v, "[redacted: 512-dim numeric vector]");
});

test("a short numeric array is legitimate data and survives", () => {
  const result = redact({ periods: [1, 2, 3, 4, 5, 6] }) as Record<string, unknown>;
  assert.deepEqual(result.periods, [1, 2, 3, 4, 5, 6]);
});

test("both guards still apply several levels down", () => {
  const result = redact({
    match: {
      student: {
        id: "s1",
        faceEmbedding: [0.1, 0.2],
        vector: Array.from({ length: 128 }, () => 0.5),
      },
    },
  }) as Record<string, Record<string, Record<string, unknown>>>;

  assert.equal(result.match.student.id, "s1");
  // Caught by name, however short the value.
  assert.equal(result.match.student.faceEmbedding, REDACTED);
  // Caught by shape — `vector` is not on the denylist, and that is exactly
  // the case the structural rule exists for.
  assert.equal(result.match.student.vector, "[redacted: 128-dim numeric vector]");
});

// ---------------------------------------------------------------------------
// Non-mutation — a logging concern must never corrupt live data
// ---------------------------------------------------------------------------

test("redact never mutates its input", () => {
  const original = { password: "hunter2", nested: { token: "abc", keep: 1 } };
  const snapshot = structuredClone(original);
  redact(original);
  assert.deepEqual(original, snapshot);
});

test("the redacted copy does not share structure with the input", () => {
  const original = { nested: { keep: 1 } };
  const copy = redact(original) as { nested: { keep: number } };
  copy.nested.keep = 99;
  assert.equal(original.nested.keep, 1);
});

// ---------------------------------------------------------------------------
// Bounds — a logger must terminate on any input
// ---------------------------------------------------------------------------

test("a long string is truncated with its true length recorded", () => {
  const result = redact("x".repeat(600)) as string;
  assert.ok(result.length < 600);
  assert.match(result, /truncated 600 chars/);
});

test("a long array is summarised rather than printed in full", () => {
  const result = redact(Array.from({ length: 120 }, (_, i) => `row-${i}`)) as unknown[];
  assert.equal(result.length, 51);
  assert.equal(result[50], "…[70 more]");
});

test("a deeply nested payload terminates", () => {
  let deep: Record<string, unknown> = { value: "bottom" };
  for (let i = 0; i < 40; i += 1) deep = { child: deep };
  const result = JSON.stringify(redact(deep));
  assert.match(result, /max depth/);
});

test("a cyclic payload terminates instead of throwing", () => {
  const node: Record<string, unknown> = { name: "root" };
  node.self = node;
  assert.doesNotThrow(() => redact(node));
});

// ---------------------------------------------------------------------------
// Scalars and errors
// ---------------------------------------------------------------------------

test("primitives pass through, and exotic values do not crash the logger", () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  assert.equal(redact(true), true);
  // `BigInt(10)` rather than `10n` only because this workspace's tsconfig
  // targets below ES2020; the value under test is the same.
  assert.equal(redact(BigInt(10)), "10");
  assert.equal(redact(new Date("2026-09-16T10:00:00.000Z")), "2026-09-16T10:00:00.000Z");
  assert.equal(redact(() => undefined), "[function]");
});

test("an Error is reduced to name and message, never a stack", () => {
  const result = redact(new TypeError("bad shape")) as Record<string, unknown>;
  assert.deepEqual(result, { name: "TypeError", message: "bad shape" });
  assert.equal("stack" in result, false);
});

// ---------------------------------------------------------------------------
// Headers and query
// ---------------------------------------------------------------------------

test("header redaction allowlists, and reports authorization as presence only", () => {
  const headers = new Headers({
    authorization: "Bearer att_live_supersecretvalue",
    "content-type": "application/json",
    "user-agent": "SchoolERP/2.1",
    "x-internal-password": "hunter2",
  });
  const result = redactHeaders(headers);
  assert.equal(result.authorization, "[present]");
  assert.equal(result["content-type"], "application/json");
  assert.equal(result["user-agent"], "SchoolERP/2.1");
  assert.equal("x-internal-password" in result, false, "unknown headers are not logged at all");
  assert.equal(JSON.stringify(result).includes("supersecret"), false);
});

test("a missing authorization header is recorded as absent, not omitted", () => {
  assert.equal(redactHeaders(new Headers()).authorization, "[absent]");
});

test("a credential appended to the query string does not become permanent", () => {
  const result = redactQuery(new URL("https://x.test/api/v1/students?limit=50&api_key=att_live_abc&token=t1"));
  assert.equal(result.limit, "50");
  assert.equal(result.api_key, REDACTED);
  assert.equal(result.token, REDACTED);
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

test("a key fingerprint identifies without revealing", () => {
  assert.equal(keyFingerprint("att_live_0123456789abcdef"), "…cdef");
});

test("anything too short to be a real key redacts whole", () => {
  assert.equal(keyFingerprint("abc"), REDACTED);
  assert.equal(keyFingerprint(""), REDACTED);
});
