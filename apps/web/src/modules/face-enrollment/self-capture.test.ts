import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SELF_CAPTURE_TOKEN_CHARS,
  SELF_CAPTURE_TOKEN_TTL_MS,
  deriveSelfCaptureKey,
  inspectSelfCapture,
  issueSelfCaptureToken,
  verifySelfCaptureToken,
  type SelfCaptureBinding,
} from "./self-capture.ts";

/**
 * The camera session and the frame check behind camera-only self-enrollment.
 *
 * The token is what separates "a capture taken in this app's camera flow, by
 * this student, in the last few minutes" from anything a script could post,
 * so it is tested the way it would be attacked: carried to another student,
 * another account, another institution, kept past its time, edited, forged
 * with a different key, and replaced by junk.
 */

const KEY = deriveSelfCaptureKey("self-capture-test-secret");
const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);
const ME: SelfCaptureBinding = { userId: "user-a", studentId: "student-a", institutionId: "college-a" };

const issue = (binding: SelfCaptureBinding = ME, at = NOW) => issueSelfCaptureToken(KEY, binding, at).token;
const verify = (token: unknown, binding: SelfCaptureBinding = ME, at = NOW) =>
  verifySelfCaptureToken(KEY, token, binding, at);

// ---------------------------------------------------------------------------
// The camera session
// ---------------------------------------------------------------------------

test("a token verifies for the session it was issued to, for its whole lifetime", () => {
  const token = issue();
  assert.deepEqual(verify(token), { ok: true });
  assert.deepEqual(verify(token, ME, NOW + SELF_CAPTURE_TOKEN_TTL_MS), { ok: true }, "at the last moment");
  assert.equal(issueSelfCaptureToken(KEY, ME, NOW).expiresAt, NOW + SELF_CAPTURE_TOKEN_TTL_MS);
});

test("a token stops working once its time is up", () => {
  const token = issue();
  assert.deepEqual(verify(token, ME, NOW + SELF_CAPTURE_TOKEN_TTL_MS + 1), { ok: false, problem: "expired" });
  assert.deepEqual(verify(token, ME, NOW + 24 * 60 * 60 * 1000), { ok: false, problem: "expired" });
});

test("a token from the future is refused beyond a small allowance for clocks", () => {
  assert.deepEqual(verify(issue(ME, NOW + 30_000)), { ok: true }, "another replica's clock, slightly ahead");
  assert.deepEqual(verify(issue(ME, NOW + 10 * 60_000)), { ok: false, problem: "not_yet_valid" });
});

test("a token cannot be carried to another student, account or institution", () => {
  const token = issue();
  for (const other of [
    { ...ME, studentId: "student-b" },
    { ...ME, userId: "user-b" },
    { ...ME, institutionId: "school-b" },
  ]) {
    assert.deepEqual(verify(token, other), { ok: false, problem: "mismatch" }, JSON.stringify(other));
  }
});

test("a token signed with another key is refused — the server's secret is what makes one", () => {
  const forged = issueSelfCaptureToken(deriveSelfCaptureKey("somebody-else's-secret"), ME, NOW).token;
  assert.deepEqual(verify(forged), { ok: false, problem: "mismatch" });
});

test("editing any part of a token breaks it", () => {
  const [issuedAt, nonce, signature] = issue().split(".");
  const flip = (value: string) => (value[0] === "A" ? "B" : "A") + value.slice(1);
  for (const edited of [
    [(Number.parseInt(issuedAt, 36) + 1000).toString(36), nonce, signature],
    [issuedAt, flip(nonce), signature],
    [issuedAt, nonce, flip(signature)],
    [issuedAt, nonce, signature.slice(0, -2)],
  ]) {
    assert.deepEqual(verify(edited.join(".")), { ok: false, problem: "mismatch" }, edited.join("."));
  }
});

test("no token, or junk in its place, is refused before any signature is computed", () => {
  for (const missing of [undefined, null, "", 42, {}, ["a.b.c"]]) {
    assert.deepEqual(verify(missing), { ok: false, problem: "missing" }, String(missing));
  }
  for (const junk of [
    "not-a-token",
    "a.b",
    "a.b.c.d",
    "ZZZZZZZZZZZZZ.abc.def",
    "12.ab c.def",
    "12.abc.de+f",
    `${"x".repeat(MAX_SELF_CAPTURE_TOKEN_CHARS)}.a.b`,
  ]) {
    assert.deepEqual(verify(junk), { ok: false, problem: "malformed" }, junk);
  }
});

test("two camera sessions never share a token, and neither names the student", () => {
  const first = issue();
  const second = issue();
  assert.notEqual(first, second, "a fresh nonce each time");
  for (const token of [first, second]) {
    for (const id of Object.values(ME)) assert.equal(token.includes(id), false, `${id} in the token`);
  }
});

test("the key is derived, not the secret itself, and there is no key without a secret", () => {
  assert.equal(KEY.length, 32);
  assert.notDeepEqual(KEY, Buffer.from("self-capture-test-secret"));
  assert.deepEqual(deriveSelfCaptureKey("self-capture-test-secret"), KEY, "deterministic across replicas");
  assert.throws(() => deriveSelfCaptureKey(undefined), /AUTH_SECRET/);
  assert.throws(() => deriveSelfCaptureKey(""), /AUTH_SECRET/);
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** A JPEG as a canvas writes it: SOI, JFIF, a quantisation table, the frame header. */
function jpeg(width: number, height: number, options: { padBefore?: number } = {}): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const pad: number[] = [];
  // APP segments are at most 65535 bytes each; pile them up ahead of the frame.
  let remaining = options.padBefore ?? 0;
  while (remaining > 0) {
    const size = Math.min(remaining, 60_000);
    pad.push(0xff, 0xe1, (size + 2) >> 8, (size + 2) & 0xff, ...new Array<number>(size).fill(0));
    remaining -= size;
  }
  const body = new Array<number>(512).fill(0x55);
  return Buffer.from([0xff, 0xd8, ...app0, ...dqt, ...pad, ...frame, ...body, 0xff, 0xd9]).toString("base64");
}

test("a frame the capture code writes is accepted, landscape or portrait, large or small", () => {
  assert.deepEqual(inspectSelfCapture(jpeg(1280, 720)), { ok: true, width: 1280, height: 720 });
  assert.deepEqual(inspectSelfCapture(jpeg(720, 1280)), { ok: true, width: 720, height: 1280 }, "a phone held upright");
  assert.deepEqual(inspectSelfCapture(jpeg(640, 480)), { ok: true, width: 640, height: 480 }, "a small webcam");
});

test("a photograph at a phone's native size is not a capture from this page", () => {
  assert.deepEqual(inspectSelfCapture(jpeg(4032, 3024)), { ok: false, problem: "too_large" });
  assert.deepEqual(inspectSelfCapture(jpeg(1281, 720)), { ok: false, problem: "too_large" });
  assert.deepEqual(inspectSelfCapture(jpeg(720, 1281)), { ok: false, problem: "too_large" });
});

test("a PNG, a WebP or anything else is refused: the capture code only writes JPEG", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(0)]).toString("base64");
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...new Array(200).fill(0)]).toString("base64");
  for (const [label, value] of [
    ["png", png],
    ["webp", webp],
    ["text", Buffer.from("just some text pretending to be an image").toString("base64")],
    ["empty", ""],
  ] as const) {
    assert.deepEqual(inspectSelfCapture(value), { ok: false, problem: "not_jpeg" }, label);
  }
  for (const notAString of [undefined, null, 42, { imageBase64: jpeg(640, 480) }]) {
    assert.deepEqual(inspectSelfCapture(notAString), { ok: false, problem: "not_jpeg" });
  }
});

test("a JPEG whose size is not where a canvas puts it is refused", () => {
  // 70 KB of metadata ahead of the frame header: a file from somewhere else.
  assert.deepEqual(inspectSelfCapture(jpeg(640, 480, { padBefore: 70_000 })), { ok: false, problem: "no_dimensions" });
  const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xda, 0x00, 0x02]).toString("base64");
  assert.deepEqual(inspectSelfCapture(noFrame), { ok: false, problem: "no_dimensions" });
});
