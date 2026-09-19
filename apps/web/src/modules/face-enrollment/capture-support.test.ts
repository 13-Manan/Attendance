import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_IMAGE_BASE64_CHARS, MIN_IMAGE_BASE64_CHARS } from "@/lib/image-validation";
import {
  MAX_CAPTURE_EDGE,
  captureDimensions,
  describeCameraError,
  inspectImageInBrowser,
  stripDataUrlPrefix,
} from "./capture-support.ts";

/**
 * The capture client's decisions, without a browser.
 *
 * Three things go wrong in a camera component and none of them is markup: a
 * data URL parsed loosely enough to produce a payload that is not base64, a
 * `getUserMedia` rejection reported as "something went wrong" when the user
 * could have fixed it in two clicks, and a 12-megapixel photograph sent whole
 * because nobody scaled it. All three are decided by pure functions, so all
 * three are asserted here.
 */

// ---------------------------------------------------------------------------
// Data URLs
// ---------------------------------------------------------------------------

test("a canvas data URL yields the raw base64 the wire contract wants", () => {
  assert.equal(stripDataUrlPrefix("data:image/jpeg;base64,QUJD"), "QUJD");
  assert.equal(stripDataUrlPrefix("data:image/png;base64,QUJD"), "QUJD");
});

test("a data URL that is not base64-encoded is refused rather than half-parsed", () => {
  // `data:text/plain,hello` has a payload, and a loose parser would hand back
  // "hello" — a string that passes a length check and decodes to nothing.
  assert.equal(stripDataUrlPrefix("data:text/plain,hello"), null);
});

test("a comma inside the payload cannot be mistaken for the separator", () => {
  // Split on the first comma and require the header to end in `;base64`. The
  // obvious alternative — searching for ";base64," anywhere — accepts this and
  // returns a payload that is not the image.
  assert.equal(stripDataUrlPrefix("data:text/plain,;base64,QUJD"), null);
});

test("anything that is not a data URL, or has no payload, is refused", () => {
  assert.equal(stripDataUrlPrefix("QUJD"), null);
  assert.equal(stripDataUrlPrefix(""), null);
  assert.equal(stripDataUrlPrefix("data:image/jpeg;base64,"), null);
  assert.equal(stripDataUrlPrefix("https://example.test/photo.jpg"), null);
});

// ---------------------------------------------------------------------------
// Client-side inspection
// ---------------------------------------------------------------------------

/** Base64 of `bytes` followed by enough filler to clear the minimum length. */
function base64Image(signature: readonly number[]): string {
  const padded = new Uint8Array(4096);
  padded.set(signature, 0);
  return Buffer.from(padded).toString("base64");
}

const JPEG = base64Image([0xff, 0xd8, 0xff, 0xe0]);
const PNG = base64Image([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = base64Image([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PDF = base64Image([0x25, 0x50, 0x44, 0x46]);
const ZIP = base64Image([0x50, 0x4b, 0x03, 0x04]);

test("the three formats a camera or a phone gallery produces are accepted", () => {
  for (const [name, payload] of [
    ["jpeg", JPEG],
    ["png", PNG],
    ["webp", WEBP],
  ] as const) {
    const inspection = inspectImageInBrowser(payload);
    assert.equal(inspection.ok, true, name);
    assert.equal(inspection.ok === true && inspection.format, name);
  }
});

test("a PDF or an archive with an image extension is turned away before it is sent", () => {
  for (const payload of [PDF, ZIP]) {
    const inspection = inspectImageInBrowser(payload);
    assert.equal(inspection.ok, false);
    assert.equal(inspection.ok === false && inspection.problem, "unsupported_format");
  }
});

test("a RIFF container that is not a WebP is refused", () => {
  // "RIFF" alone is also a WAV and an AVI. Checking only the first four bytes
  // would let a sound file through to an image decoder.
  const wav = base64Image([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(inspectImageInBrowser(wav).ok, false);
});

test("the bounds are the server's bounds, so the client cannot accept what the server refuses", () => {
  // Shared constants rather than copies. A client that accepted something the
  // server rejects produces a failure with no useful message attached.
  assert.equal(inspectImageInBrowser("").ok, false);
  assert.equal(
    inspectImageInBrowser("A".repeat(MIN_IMAGE_BASE64_CHARS - 1)).ok,
    false,
    "below the server's floor",
  );

  const oversized = "A".repeat(MAX_IMAGE_BASE64_CHARS + 1);
  const tooBig = inspectImageInBrowser(oversized);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.ok === false && tooBig.problem, "too_large");
});

test("the size is checked before the decode, so a huge non-image costs nothing", () => {
  // The ordering is the control: a 20 MB blob must be refused on its string
  // length, not after being turned into bytes on a phone holding a camera open.
  const inspection = inspectImageInBrowser("A".repeat(MAX_IMAGE_BASE64_CHARS + 1000));
  assert.equal(inspection.ok === false && inspection.problem, "too_large");
});

test("a payload that is not valid base64 is reported as not an image, not as a crash", () => {
  const inspection = inspectImageInBrowser("!!!!".repeat(64));
  assert.equal(inspection.ok, false);
  assert.equal(inspection.ok === false && inspection.problem, "unsupported_format");
});

test("the reported size is an upper bound, never an understatement", () => {
  const inspection = inspectImageInBrowser(JPEG);
  assert.equal(inspection.ok, true);
  const bytes = inspection.ok === true ? inspection.approximateBytes : 0;
  assert.ok(bytes >= 4096, "4096 real bytes must not be reported as fewer");
});

// ---------------------------------------------------------------------------
// Camera failures
// ---------------------------------------------------------------------------

test("each camera failure gets the sentence that names its fix", () => {
  const cases: Array<[string, RegExp]> = [
    ["NotAllowedError", /blocked access|browser settings/i],
    ["NotFoundError", /no camera was found/i],
    ["NotReadableError", /already in use/i],
    ["TypeError", /secure connection|HTTPS/i],
  ];
  for (const [name, pattern] of cases) {
    assert.match(describeCameraError({ name }), pattern, name);
  }
});

test("every camera failure offers the upload instead of ending the conversation", () => {
  // The upload path exists precisely for the device whose camera cannot be
  // used. A message that does not mention it leaves somebody stuck.
  for (const name of [
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "OverconstrainedError",
    "TypeError",
    "SomethingNobodyHasSeen",
  ]) {
    assert.match(describeCameraError({ name }), /upload/i, name);
  }
});

test("a thrown value that is not a DOMException still produces a usable sentence", () => {
  for (const thrown of [null, undefined, "boom", 42, {}]) {
    const message = describeCameraError(thrown);
    assert.ok(message.length > 0);
    assert.match(message, /upload/i);
  }
});

// ---------------------------------------------------------------------------
// Capture geometry
// ---------------------------------------------------------------------------

test("a phone camera frame is scaled down to the long edge, keeping its shape", () => {
  const { width, height } = captureDimensions(4032, 3024);
  assert.equal(width, MAX_CAPTURE_EDGE);
  assert.equal(height, Math.round(3024 * (MAX_CAPTURE_EDGE / 4032)));
  assert.equal(width / height, 4032 / 3024, "aspect ratio is preserved");
});

test("a portrait frame is scaled on its own long edge", () => {
  const { width, height } = captureDimensions(1080, 1920);
  assert.equal(height, MAX_CAPTURE_EDGE);
  assert.ok(width < height);
});

test("a small webcam frame is never enlarged", () => {
  // Upscaling adds no detail for the detector and costs bytes on the wire.
  assert.deepEqual(captureDimensions(640, 480), { width: 640, height: 480 });
});

test("a frame at exactly the limit is left alone", () => {
  assert.deepEqual(captureDimensions(MAX_CAPTURE_EDGE, 720), {
    width: MAX_CAPTURE_EDGE,
    height: 720,
  });
});

test("a video element that has not produced a frame yet reports zero rather than guessing", () => {
  // `videoWidth` is 0 until the first frame arrives, and drawing a 0×0 canvas
  // produces a data URL of a blank image that would be enrolled as a face.
  assert.deepEqual(captureDimensions(0, 0), { width: 0, height: 0 });
  assert.deepEqual(captureDimensions(640, 0), { width: 0, height: 0 });
});
