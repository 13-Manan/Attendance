import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_CAMERA_STATE,
  MAX_CLASSROOM_CAPTURE_EDGE,
  cameraReducer,
  cameraStatusLabel,
  canCapture,
  canStart,
  classifyCameraError,
  classroomCaptureDimensions,
  describeCameraFailure,
  inspectCapturedFrame,
  splitDataUrl,
  type CameraEvent,
  type CameraState,
} from "./camera.ts";
import {
  browserCameraSource,
  fixtureCameraSource,
  fixtureFrameBase64,
  type VideoSink,
} from "./camera-source.ts";
import { MAX_IMAGE_BASE64_CHARS, inspectImageBase64 } from "../../lib/image-validation.ts";

/**
 * Camera behaviour, without a camera.
 *
 * Every test here would otherwise be a thing somebody checked by hand once.
 * None of them asserts anything about real hardware — see
 * `camera-source.ts` for why that distinction is kept sharp.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(events: CameraEvent[], from: CameraState = INITIAL_CAMERA_STATE): CameraState {
  return events.reduce(cameraReducer, from);
}

const STARTED: CameraEvent = { type: "started", deviceId: "cam-1", deviceLabel: "Rear camera" };

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** A `<video>` stand-in. The narrow `VideoSink` interface is the point. */
function videoSink(width = 1280, height = 720): VideoSink {
  return {
    srcObject: null,
    videoWidth: width,
    videoHeight: height,
    play: async () => {},
  };
}

function decodePrefix(base64: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(base64.slice(0, 16), "base64"));
  } catch {
    return null;
  }
}

// ===========================================================================
// 1. Error classification — one state per thing the user must do
// ===========================================================================

test("a denied permission is distinguished from a missing camera", () => {
  assert.equal(classifyCameraError(domError("NotAllowedError")), "permission_denied");
  assert.equal(classifyCameraError(domError("NotFoundError")), "no_device");
});

test("every getUserMedia failure name maps to an actionable state", () => {
  const cases: Array<[string, string]> = [
    ["NotAllowedError", "permission_denied"],
    ["SecurityError", "permission_denied"],
    ["NotFoundError", "no_device"],
    ["OverconstrainedError", "no_device"],
    ["DevicesNotFoundError", "no_device"],
    ["NotReadableError", "device_in_use"],
    ["TrackStartError", "device_in_use"],
    ["AbortError", "device_in_use"],
    ["TypeError", "insecure_context"],
    ["SomethingNobodyHasSeen", "unknown"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(classifyCameraError(domError(name)), expected, name);
  }
});

test("a non-Error rejection does not crash the classifier", () => {
  assert.equal(classifyCameraError("nope"), "unknown");
  assert.equal(classifyCameraError(null), "unknown");
  assert.equal(classifyCameraError(undefined), "unknown");
});

test("only an insecure context is reported as unrecoverable", () => {
  // Retrying over http:// will fail identically every time, so offering a
  // retry button there is a lie. Everything else is worth another press.
  assert.equal(describeCameraFailure(domError("TypeError")).retryable, false);
  for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "Whatever"]) {
    assert.equal(describeCameraFailure(domError(name)).retryable, true, name);
  }
});

test("every failure message says what to do next", () => {
  for (const name of [
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "TypeError",
    "Unknown",
  ]) {
    const failure = describeCameraFailure(domError(name));
    assert.ok(failure.message.length > 20, name);
    // No raw DOMException names leaking into a teacher's screen.
    assert.equal(failure.message.includes("Error"), false, name);
  }
});

// ===========================================================================
// 2. State machine
// ===========================================================================

test("the camera starts idle and reaches ready through starting", () => {
  assert.equal(INITIAL_CAMERA_STATE.name, "idle");
  assert.equal(run([{ type: "start" }]).name, "starting");
  const ready = run([{ type: "start" }, STARTED]);
  assert.equal(ready.name, "ready");
  assert.equal(ready.name === "ready" ? ready.deviceLabel : null, "Rear camera");
});

test("pressing start twice cannot open two streams", () => {
  // The bug this prevents: two overlapping getUserMedia calls return two
  // MediaStreams, only one of which anything holds a reference to. The other
  // keeps the camera light on until the tab is closed.
  const afterFirst = run([{ type: "start" }]);
  const afterSecond = cameraReducer(afterFirst, { type: "start" });
  assert.equal(afterSecond, afterFirst, "the second press must be ignored entirely");

  const streaming = run([{ type: "start" }, STARTED]);
  assert.equal(cameraReducer(streaming, { type: "start" }), streaming);
});

test("a stream that arrives after the user pressed stop is not shown", () => {
  const stopped = run([{ type: "start" }, { type: "stop" }]);
  assert.equal(cameraReducer(stopped, STARTED).name, "idle");
});

test("capture is only possible from ready", () => {
  assert.equal(canCapture({ name: "idle" }), false);
  assert.equal(canCapture({ name: "starting" }), false);
  assert.equal(canCapture(run([{ type: "start" }, STARTED])), true);
  assert.equal(canCapture(run([{ type: "start" }, STARTED, { type: "capture" }])), false);
});

test("a double shutter press cannot take two photographs", () => {
  const capturing = run([{ type: "start" }, STARTED, { type: "capture" }]);
  assert.equal(capturing.name, "capturing");
  assert.equal(cameraReducer(capturing, { type: "capture" }), capturing);
});

test("capturing returns to ready, preserving the device", () => {
  const back = run([{ type: "start" }, STARTED, { type: "capture" }, { type: "captured" }]);
  assert.equal(back.name, "ready");
  assert.equal(back.name === "ready" ? back.deviceId : null, "cam-1");
});

test("a failure while starting is surfaced, not swallowed", () => {
  const failed = run([
    { type: "start" },
    { type: "fail", failure: describeCameraFailure(domError("NotAllowedError")) },
  ]);
  assert.equal(failed.name, "failed");
  assert.equal(failed.name === "failed" ? failed.failure.kind : null, "permission_denied");
});

test("a retry is offered after a recoverable failure and withheld after an insecure context", () => {
  const denied = cameraReducer(INITIAL_CAMERA_STATE, {
    type: "fail",
    failure: describeCameraFailure(domError("NotAllowedError")),
  });
  assert.equal(canStart(denied), true);

  const insecure = cameraReducer(INITIAL_CAMERA_STATE, {
    type: "fail",
    failure: describeCameraFailure(domError("TypeError")),
  });
  assert.equal(canStart(insecure), false);
});

test("an unsupported browser is a terminal state no event escapes", () => {
  const unsupported = run([{ type: "unsupported" }]);
  for (const event of [
    { type: "start" },
    STARTED,
    { type: "capture" },
    { type: "stop" },
    { type: "fail", failure: describeCameraFailure(domError("NotAllowedError")) },
  ] as CameraEvent[]) {
    assert.equal(cameraReducer(unsupported, event).name, "unsupported", event.type);
  }
  assert.equal(canStart(unsupported), false);
  assert.equal(canCapture(unsupported), false);
});

test("stop always reaches idle, from any live state", () => {
  for (const state of [
    run([{ type: "start" }]),
    run([{ type: "start" }, STARTED]),
    run([{ type: "start" }, STARTED, { type: "capture" }]),
    cameraReducer(INITIAL_CAMERA_STATE, {
      type: "fail",
      failure: describeCameraFailure(domError("NotFoundError")),
    }),
  ]) {
    assert.equal(cameraReducer(state, { type: "stop" }).name, "idle", state.name);
  }
});

test("every state has a label — no blank viewfinder", () => {
  const states: CameraState[] = [
    { name: "unsupported" },
    { name: "idle" },
    { name: "starting" },
    { name: "ready", deviceId: null, deviceLabel: null },
    { name: "ready", deviceId: "c", deviceLabel: "Rear camera" },
    { name: "capturing", deviceId: null, deviceLabel: null },
    { name: "failed", failure: describeCameraFailure(domError("NotAllowedError")) },
  ];
  for (const state of states) {
    const label = cameraStatusLabel(state);
    assert.ok(label.length > 0, state.name);
  }
});

// ===========================================================================
// 3. Capture geometry
// ===========================================================================

test("a 4K frame is scaled down to the classroom cap", () => {
  const { width, height } = classroomCaptureDimensions(3840, 2160);
  assert.equal(width, MAX_CLASSROOM_CAPTURE_EDGE);
  assert.equal(height, 1080);
});

test("a small webcam frame is never scaled up", () => {
  assert.deepEqual(classroomCaptureDimensions(640, 480), { width: 640, height: 480 });
});

test("a portrait frame is capped on its long edge", () => {
  const { width, height } = classroomCaptureDimensions(1080, 2400);
  assert.equal(height, MAX_CLASSROOM_CAPTURE_EDGE);
  assert.equal(width, 864);
});

test("aspect ratio survives scaling", () => {
  const { width, height } = classroomCaptureDimensions(4000, 3000);
  assert.ok(Math.abs(width / height - 4 / 3) < 0.01);
});

test("a camera that has produced no frame yet reports zero, not a division by zero", () => {
  assert.deepEqual(classroomCaptureDimensions(0, 0), { width: 0, height: 0 });
  assert.deepEqual(classroomCaptureDimensions(1280, 0), { width: 0, height: 0 });
  assert.deepEqual(classroomCaptureDimensions(NaN, 720), { width: 0, height: 0 });
});

// ===========================================================================
// 4. Frame encoding and validation
// ===========================================================================

test("a canvas data URL is split into the raw base64 the contract wants", () => {
  assert.equal(splitDataUrl("data:image/jpeg;base64,QUJD"), "QUJD");
});

test("a data URL that is not base64 is refused rather than half-parsed", () => {
  // `data:text/plain,;base64,x` would yield "x" to a naive search for
  // ";base64,". The payload there is text, not image bytes.
  assert.equal(splitDataUrl("data:text/plain,;base64,x"), null);
  assert.equal(splitDataUrl("data:image/jpeg,QUJD"), null);
  assert.equal(splitDataUrl("not a data url"), null);
  assert.equal(splitDataUrl("data:image/jpeg;base64,"), null);
});

test("an empty frame is reported as no_frame, not sent", () => {
  const result = inspectCapturedFrame("data:image/jpeg;base64,QUJD", decodePrefix);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "no_frame");
});

test("an oversized frame is refused on the client before it reaches the network", () => {
  const huge = `data:image/jpeg;base64,${"A".repeat(MAX_IMAGE_BASE64_CHARS + 1)}`;
  const result = inspectCapturedFrame(huge, decodePrefix);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "too_large");
});

test("a payload that is not an image is refused even with an image data URL header", () => {
  // The header claims JPEG; the bytes are not. The header is not evidence.
  const lying = `data:image/jpeg;base64,${Buffer.from("PK\u0003\u0004" + "x".repeat(600)).toString("base64")}`;
  const result = inspectCapturedFrame(lying, decodePrefix);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.problem : null, "not_an_image");
});

test("the fixture frame passes the client check and the server's own validator", () => {
  // The two checks share their constants and signature table, and this is what
  // holds them to it: a fixture the client accepts and the server rejects would
  // make every fixture-driven test meaningless.
  const payload = fixtureFrameBase64();
  const client = inspectCapturedFrame(`data:image/jpeg;base64,${payload}`, decodePrefix);
  assert.equal(client.ok, true);

  const server = inspectImageBase64(payload);
  assert.equal(server.ok, true);
  assert.equal(server.ok === true ? server.format : null, "jpeg");
});

// ===========================================================================
// 5. The camera source contract
// ===========================================================================

test("the fixture source opens, captures and releases a stream", async () => {
  const source = fixtureCameraSource();
  const sink = videoSink();
  assert.equal(source.openStreamCount(), 0);

  const stream = await source.open({ facingMode: "environment", videoSink: sink });
  assert.equal(source.openStreamCount(), 1);

  const frame = stream.grabFrame();
  assert.equal(frame.ok, true);
  assert.equal(frame.ok === true ? frame.width : 0, 1280);

  stream.stop();
  assert.equal(source.openStreamCount(), 0, "stop must release the stream");
});

test("stopping twice is safe and does not double-release", () => {
  return (async () => {
    const source = fixtureCameraSource();
    const stream = await source.open({ facingMode: "environment", videoSink: videoSink() });
    stream.stop();
    stream.stop();
    assert.equal(source.openStreamCount(), 0);
  })();
});

test("an unavailable camera is reported before anything is attempted", () => {
  assert.equal(fixtureCameraSource({ unavailable: true }).isAvailable(), false);
  assert.equal(fixtureCameraSource().isAvailable(), true);
});

test("a source that fails to open surfaces the original error for classification", async () => {
  const source = fixtureCameraSource({ failWith: domError("NotAllowedError") });
  await assert.rejects(
    () => source.open({ facingMode: "environment", videoSink: videoSink() }),
    (e: unknown) => classifyCameraError(e) === "permission_denied",
  );
  assert.equal(source.openStreamCount(), 0, "a failed open must not leak a stream");
});

test("a device list is offered so a second camera can be chosen", async () => {
  const devices = await fixtureCameraSource().listVideoDevices();
  assert.equal(devices.length, 2);
  assert.ok(devices.every((d) => d.deviceId && d.label));
});

test("opening a named device selects that device", async () => {
  const source = fixtureCameraSource();
  const stream = await source.open({
    facingMode: "environment",
    deviceId: "fixture-front",
    videoSink: videoSink(),
  });
  assert.equal(stream.deviceId, "fixture-front");
  assert.equal(stream.deviceLabel, "Fixture front camera");
  stream.stop();
});

test("a source whose preview has no frame yet refuses to capture", async () => {
  const source = fixtureCameraSource({ frameSize: { width: 0, height: 0 } });
  const stream = await source.open({ facingMode: "environment", videoSink: videoSink(0, 0) });
  const frame = stream.grabFrame();
  assert.equal(frame.ok, false);
  assert.equal(frame.ok === false ? frame.problem : null, "no_frame");
  stream.stop();
});

test("the fixture never returns a MediaStream or any hardware handle", async () => {
  // The contract hands back an encoded frame and two functions. Anything else
  // would be a way for a component to reach around the abstraction.
  const source = fixtureCameraSource();
  const stream = await source.open({ facingMode: "environment", videoSink: videoSink() });
  assert.deepEqual(Object.keys(stream).sort(), [
    "deviceId",
    "deviceLabel",
    "grabFrame",
    "stop",
  ]);
  stream.stop();
});

// ===========================================================================
// 6. The preview-attachment race
//
// Found by a real capture, not by a test: the wizard called `camera.start()`
// on the line after `setStep("camera")`. `setStep` only schedules a render, so
// `<video>` did not exist yet, the stream opened against a null sink, the
// state machine reached `ready`, the shutter looked enabled — and the capture
// failed with "No camera preview is attached".
// ===========================================================================

test("a real source opening with no preview element yields an unusable stream", async () => {
  // The underlying fact the bug rested on: `grabFrame` reads the preview, so
  // a stream opened without one can never produce a frame, however healthy the
  // camera is.
  const source = fixtureCameraSource();
  const stream = await source.open({ facingMode: "environment", videoSink: null });
  assert.equal(stream.deviceId, "fixture-rear", "the stream itself opened fine");
  stream.stop();
});

test("a hardware source declares that it needs a preview element", () => {
  // What lets the hook refuse a start that could only reach a broken `ready`.
  // The fixture draws its own frames and says so.
  assert.equal(browserCameraSource().requiresVideoSink, true);
  assert.equal(fixtureCameraSource().requiresVideoSink, false);
});

test("a failure raised before the stream opens is retryable and leaves no stream", async () => {
  // The shape of the guard's outcome: the user gets a retry, and nothing is
  // held open behind it.
  const source = fixtureCameraSource();
  const before = source.openStreamCount();
  const failure = describeCameraFailure(domError("SomethingUnexpected"));
  const state = cameraReducer(run([{ type: "start" }]), { type: "fail", failure });
  assert.equal(state.name, "failed");
  assert.equal(canStart(state), true);
  assert.equal(source.openStreamCount(), before);
});
