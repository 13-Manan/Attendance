import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_BASE64_CHARS,
  MIN_IMAGE_BASE64_CHARS,
  detectImageFormat,
  imageBase64Field,
  inspectImageBase64,
  isAcceptableImageBase64,
} from "./image-validation.ts";

/**
 * Upload validation tests.
 *
 * This is the only thing standing between an arbitrary blob and a native image
 * decoder reached through Python, so the suite is written as an attacker's
 * list rather than a happy path: every file type that is *not* a photograph
 * gets its own assertion, because each one is a real payload somebody would
 * try.
 */

// ---------------------------------------------------------------------------
// Fixtures — real headers, not invented ones
// ---------------------------------------------------------------------------

/** Pads a header out past the minimum length with zero bytes. */
function payload(header: readonly number[], totalBytes = 256): string {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(header, 0);
  return Buffer.from(bytes).toString("base64");
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** "RIFF" + 4 length bytes + "WEBP" — the marker is at offset 8, not 4. */
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50] as const;

// ---------------------------------------------------------------------------
// The formats that must keep working
// ---------------------------------------------------------------------------

test("the three formats a browser capture produces are accepted", () => {
  for (const [name, header] of [["jpeg", JPEG], ["png", PNG], ["webp", WEBP]] as const) {
    const result = inspectImageBase64(payload(header));
    assert.equal(result.ok, true, `${name} was rejected`);
    if (result.ok) assert.equal(result.format, name);
  }
});

test("base64url encoding is accepted, because Buffer decodes it and a caller using it is not attacking", () => {
  const url = Buffer.from(new Uint8Array([...JPEG, ...new Array(246).fill(0xfb)]))
    .toString("base64url");
  assert.equal(isAcceptableImageBase64(url), true);
});

test("the reported size is an upper bound derived from the string, not a decode", () => {
  const value = payload(JPEG, 3000);
  const result = inspectImageBase64(value);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.approximateBytes >= 3000 - 4);
    assert.ok(result.approximateBytes <= value.length);
  }
});

// ---------------------------------------------------------------------------
// Malicious uploads — things that are not images
// ---------------------------------------------------------------------------

test("a file that is not an image is rejected whatever it claims to be", () => {
  // Each of these is a payload with a reason to be tried: a ZIP or a PDF to
  // reach a parser that is not an image parser; an SVG because it is an image
  // format that executes script; an ELF or a shell script because the decoder
  // runs on a server; HTML because the response might be reflected somewhere.
  const files: Array<[string, readonly number[]]> = [
    ["zip", [0x50, 0x4b, 0x03, 0x04]],
    ["gzip", [0x1f, 0x8b, 0x08]],
    ["pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ["elf", [0x7f, 0x45, 0x4c, 0x46]],
    ["mach-o", [0xcf, 0xfa, 0xed, 0xfe]],
    ["shell script", [0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68]],
    ["html", [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]],
    ["svg", [0x3c, 0x73, 0x76, 0x67, 0x20]],
    ["gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["bmp", [0x42, 0x4d]],
    ["tiff", [0x49, 0x49, 0x2a, 0x00]],
    ["ico", [0x00, 0x00, 0x01, 0x00]],
  ];

  for (const [name, header] of files) {
    const result = inspectImageBase64(payload(header));
    assert.equal(result.ok, false, `${name} was accepted`);
    if (!result.ok) assert.equal(result.reason, "unsupported_format");
  }
});

test("a RIFF container that is not WebP is rejected", () => {
  // "RIFF" alone is also WAV and AVI. Checking only the first four bytes would
  // wave both through to an image decoder.
  const wav = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
  const avi = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20];
  assert.equal(isAcceptableImageBase64(payload(wav)), false);
  assert.equal(isAcceptableImageBase64(payload(avi)), false);
});

test("a truncated PNG signature is rejected rather than matched on its prefix", () => {
  const nearly = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00];
  assert.equal(isAcceptableImageBase64(payload(nearly)), false);
});

test("a polyglot is judged by its actual first bytes, not by a signature buried later", () => {
  // A ZIP with a JPEG header appended: whatever a lenient parser might make of
  // it, the bytes an image decoder sees first are not an image.
  const bytes = new Uint8Array(512);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  bytes.set(JPEG, 64);
  assert.equal(isAcceptableImageBase64(Buffer.from(bytes).toString("base64")), false);
});

test("a data: URL is refused with its own reason rather than silently repaired", () => {
  const result = inspectImageBase64(`data:image/jpeg;base64,${payload(JPEG)}`);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "data_url");
});

test("a payload that is not base64 at all is rejected before any decode is attempted", () => {
  const result = inspectImageBase64("!".repeat(200));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_base64");
});

test("whitespace is not tolerated, so the validated string and the decoded bytes cannot diverge", () => {
  const withNewlines = payload(JPEG).replace(/(.{64})/g, "$1\n");
  assert.equal(isAcceptableImageBase64(withNewlines), false);
});

// ---------------------------------------------------------------------------
// Oversized and undersized uploads
// ---------------------------------------------------------------------------

test("an oversized upload is rejected on the string length, before anything is allocated", () => {
  const huge = "A".repeat(MAX_IMAGE_BASE64_CHARS + 1);
  const result = inspectImageBase64(huge);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "too_large");
});

test("a payload exactly at the limit is still accepted — the bound is inclusive", () => {
  // 63 bytes encodes to 84 characters with no `=` padding, so the filler can
  // be appended without putting padding in the middle of the string.
  const header = payload(JPEG, 63);
  const filler = "A".repeat(MAX_IMAGE_BASE64_CHARS - header.length);
  const value = header + filler;
  assert.equal(value.length, MAX_IMAGE_BASE64_CHARS);
  assert.equal(inspectImageBase64(value).ok, true);
});

test("an empty or near-empty capture is rejected with a reason the camera UI can show", () => {
  assert.deepEqual(
    (inspectImageBase64("") as { reason: string }).reason,
    "empty",
  );
  assert.deepEqual(
    (inspectImageBase64("A".repeat(MIN_IMAGE_BASE64_CHARS - 1)) as { reason: string }).reason,
    "too_small",
  );
});

test("non-string input is rejected rather than coerced", () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(isAcceptableImageBase64(value), false, `${JSON.stringify(value)} was accepted`);
  }
});

// ---------------------------------------------------------------------------
// detectImageFormat, directly
// ---------------------------------------------------------------------------

test("detectImageFormat does not read past the end of a short buffer", () => {
  // A 2-byte buffer whose bytes match the start of the WebP check. Indexing
  // past the end yields undefined, which must compare false rather than throw.
  assert.equal(detectImageFormat(new Uint8Array([0x52, 0x49])), null);
  assert.equal(detectImageFormat(new Uint8Array([])), null);
  assert.equal(detectImageFormat(new Uint8Array([0xff, 0xd8])), null);
});

// ---------------------------------------------------------------------------
// The shared zod field
// ---------------------------------------------------------------------------

test("imageBase64Field rejects at the schema boundary, so no action has to remember to check", () => {
  const schema = imageBase64Field();
  assert.equal(schema.safeParse(payload(JPEG)).success, true);
  assert.equal(schema.safeParse(payload([0x50, 0x4b, 0x03, 0x04])).success, false);
  assert.equal(schema.safeParse("A".repeat(MAX_IMAGE_BASE64_CHARS + 1)).success, false);
  assert.equal(schema.safeParse("short").success, false);
});

test("the schema's message names the accepted formats rather than leaking the check", () => {
  const result = imageBase64Field().safeParse(payload([0x50, 0x4b, 0x03, 0x04]));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? "", /JPEG, PNG or WebP/);
  }
});
