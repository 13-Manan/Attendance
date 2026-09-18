import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  generateSigningSecret,
  parseSignatureHeader,
  signPayload,
  signatureHeader,
  verifySignature,
} from "./webhook-signature.ts";

const SECRET = "whsec_0123456789abcdef";
const OTHER = "whsec_fedcba9876543210";
const NOW = 1_758_000_000;
const BODY = JSON.stringify({ id: "evt_1", type: "attendance.finalized" });

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("a generated secret is prefixed, long, and never repeats", () => {
  const secrets = new Set(Array.from({ length: 50 }, () => generateSigningSecret()));
  assert.equal(secrets.size, 50);
  for (const secret of secrets) {
    assert.match(secret, /^whsec_[0-9a-f]{64}$/);
  }
});

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

test("signing is deterministic for the same secret, timestamp and body", () => {
  assert.equal(signPayload(SECRET, NOW, BODY), signPayload(SECRET, NOW, BODY));
});

test("the timestamp is inside the signed material, not beside it", () => {
  // If it were not, a captured delivery would be a valid signed message
  // forever and the replay window would be unbounded.
  assert.notEqual(signPayload(SECRET, NOW, BODY), signPayload(SECRET, NOW + 1, BODY));
});

test("a different body or a different secret produces a different signature", () => {
  assert.notEqual(signPayload(SECRET, NOW, BODY), signPayload(SECRET, NOW, `${BODY} `));
  assert.notEqual(signPayload(SECRET, NOW, BODY), signPayload(OTHER, NOW, BODY));
});

test("the header carries the timestamp and a versioned signature", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  assert.match(header, /^t=1758000000,v1=[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a well-formed header parses", () => {
  const parsed = parseSignatureHeader(`t=${NOW},v1=abc`);
  assert.deepEqual(parsed, { timestamp: NOW, signatures: ["abc"] });
});

test("an unknown scheme is skipped, so adding v2 later breaks no receiver", () => {
  const parsed = parseSignatureHeader(`t=${NOW},v1=abc,v2=def`);
  assert.deepEqual(parsed?.signatures, ["abc"]);
});

test("a header with only an unknown scheme is not silently treated as valid", () => {
  assert.equal(parseSignatureHeader(`t=${NOW},v2=def`), null);
});

test("malformed headers parse to null rather than throwing", () => {
  for (const header of ["", "garbage", "v1=abc", `t=${NOW}`, "t=notanumber,v1=abc", "t=-5,v1=abc", "t=0,v1=abc"]) {
    assert.equal(parseSignatureHeader(header), null, `${header} should not parse`);
  }
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test("a signature we produced verifies", () => {
  const result = verifySignature(signatureHeader(SECRET, NOW, BODY), BODY, [SECRET], NOW);
  assert.deepEqual(result, { valid: true });
});

test("a tampered body fails", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  const tampered = JSON.stringify({ id: "evt_1", type: "attendance.corrected" });
  assert.deepEqual(verifySignature(header, tampered, [SECRET], NOW), {
    valid: false,
    reason: "no_matching_signature",
  });
});

test("a re-serialised body fails, which is why the raw bytes must be verified", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
  assert.equal(verifySignature(header, reserialised, [SECRET], NOW).valid, false);
});

test("the wrong secret fails", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  assert.equal(verifySignature(header, BODY, [OTHER], NOW).valid, false);
});

test("a missing header is a failure with a reason, not a crash", () => {
  assert.deepEqual(verifySignature(null, BODY, [SECRET], NOW), {
    valid: false,
    reason: "malformed_header",
  });
});

test("an empty secret list verifies nothing", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  assert.equal(verifySignature(header, BODY, [], NOW).valid, false);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test("a delivery just inside the tolerance is accepted", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  assert.equal(verifySignature(header, BODY, [SECRET], NOW + SIGNATURE_TOLERANCE_SECONDS).valid, true);
});

test("a replay past the tolerance is rejected even though the MAC is correct", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  const result = verifySignature(header, BODY, [SECRET], NOW + SIGNATURE_TOLERANCE_SECONDS + 1);
  assert.deepEqual(result, { valid: false, reason: "timestamp_outside_tolerance" });
});

test("a far-future timestamp is rejected too, for a receiver whose clock is behind", () => {
  // Checking only `now - t` would accept a signature minted arbitrarily far
  // ahead, which re-opens the replay window from the other side.
  const header = signatureHeader(SECRET, NOW + 86_400, BODY);
  assert.deepEqual(verifySignature(header, BODY, [SECRET], NOW), {
    valid: false,
    reason: "timestamp_outside_tolerance",
  });
});

test("a receiver with a slightly skewed clock still works", () => {
  const header = signatureHeader(SECRET, NOW, BODY);
  assert.equal(verifySignature(header, BODY, [SECRET], NOW - 120).valid, true);
  assert.equal(verifySignature(header, BODY, [SECRET], NOW + 120).valid, true);
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test("during rotation either secret verifies, in either list order", () => {
  const oldHeader = signatureHeader(OTHER, NOW, BODY);
  const newHeader = signatureHeader(SECRET, NOW, BODY);

  for (const secrets of [
    [SECRET, OTHER],
    [OTHER, SECRET],
  ]) {
    assert.equal(verifySignature(oldHeader, BODY, secrets, NOW).valid, true);
    assert.equal(verifySignature(newHeader, BODY, secrets, NOW).valid, true);
  }
});

test("a header carrying both signatures verifies against a receiver holding either one", () => {
  const both = `t=${NOW},v1=${signPayload(SECRET, NOW, BODY)},v1=${signPayload(OTHER, NOW, BODY)}`;
  assert.equal(verifySignature(both, BODY, [SECRET], NOW).valid, true);
  assert.equal(verifySignature(both, BODY, [OTHER], NOW).valid, true);
  assert.equal(verifySignature(both, BODY, ["whsec_unrelated"], NOW).valid, false);
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

test("a signature of the wrong length is rejected without throwing", () => {
  // `timingSafeEqual` throws on a length mismatch; the length guard is what
  // turns that into a verification failure instead of a 500.
  for (const candidate of ["", "ab", "f".repeat(63), "f".repeat(65), "f".repeat(4096)]) {
    assert.doesNotThrow(() => verifySignature(`t=${NOW},v1=${candidate}`, BODY, [SECRET], NOW));
    assert.equal(verifySignature(`t=${NOW},v1=${candidate}`, BODY, [SECRET], NOW).valid, false);
  }
});

test("an empty body still signs and verifies", () => {
  assert.equal(verifySignature(signatureHeader(SECRET, NOW, ""), "", [SECRET], NOW).valid, true);
});

test("a unicode body round-trips", () => {
  const unicode = JSON.stringify({ name: "अनन्या शर्मा" });
  assert.equal(verifySignature(signatureHeader(SECRET, NOW, unicode), unicode, [SECRET], NOW).valid, true);
});
