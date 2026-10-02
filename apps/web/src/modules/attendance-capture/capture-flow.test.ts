import { test } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenError } from "../authorization/types.ts";
import { describeCameraFailure, type CameraState } from "./camera.ts";
import { classroomVideoConstraints } from "./camera-source.ts";
import {
  PROCESSING_LABEL,
  cameraHelp,
  cameraStageOf,
  captureFlowErrorCode,
  describeCaptureFlowError,
  doneStateOf,
  failureHeadline,
  formatElapsed,
  isConnectionError,
  nextSequenceNumber,
  photoStatusOf,
  platformOf,
  readySummaryOf,
  retryLabel,
  type CaptureFlowErrorCode,
  type FlowShot,
} from "./capture-flow.ts";

/** Words a teacher should never meet on these screens. */
const JARGON = /azure|dlib|model|embedding|provider|gallery|vector|cosine|detector|confidence|backend|face-ai|face_ai/i;

// ---------------------------------------------------------------------------
// Camera states
// ---------------------------------------------------------------------------

test("camera states read as requesting, ready, capturing, blocked or unavailable", () => {
  const failed = (name: string): CameraState => ({ name: "failed", failure: describeCameraFailure({ name }) });
  assert.equal(cameraStageOf({ name: "idle" }), "idle");
  assert.equal(cameraStageOf({ name: "starting" }), "requesting");
  assert.equal(cameraStageOf({ name: "ready", deviceId: "d", deviceLabel: null }), "ready");
  assert.equal(cameraStageOf({ name: "capturing", deviceId: "d", deviceLabel: null }), "capturing");
  assert.equal(cameraStageOf(failed("NotAllowedError")), "blocked");
  assert.equal(cameraStageOf(failed("NotFoundError")), "unavailable");
  assert.equal(cameraStageOf(failed("NotReadableError")), "unavailable");
  assert.equal(cameraStageOf({ name: "unsupported" }), "unavailable");
});

test("camera permission denied: device-specific steps, a retry, and a way to mark by hand", () => {
  const ua = {
    ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36",
    desktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36",
  };
  assert.equal(platformOf(ua.ios), "ios");
  assert.equal(platformOf(ua.ipad), "ios");
  assert.equal(platformOf(ua.android), "android");
  assert.equal(platformOf(ua.desktop), "other");

  const ios = cameraHelp("permission_denied", "ios");
  assert.match(ios.steps.join(" "), /Settings/);
  const android = cameraHelp("permission_denied", "android");
  assert.match(android.steps.join(" "), /Permissions/);
  const desktop = cameraHelp("permission_denied", "other");
  assert.match(desktop.steps.join(" "), /address bar/);
  for (const help of [ios, android, desktop]) {
    assert.equal(help.title, "Camera isn't available");
    assert.equal(help.reason, "Camera access is turned off for this site.");
    assert.equal(help.canRetry, true);
    assert.equal(help.offerMarkByHand, true);
    assert.doesNotMatch(help.steps.join(" "), JARGON);
  }
  assert.doesNotMatch(ios.steps.join(" "), /address bar/, "a phone's help never sends them to an address bar");
});

test("camera unavailable: no camera, busy, insecure or unsupported — each says what to do, and marking by hand stays open", () => {
  const cases = [
    ["no_device", true],
    ["device_in_use", true],
    ["insecure_context", false],
    ["unsupported", false],
    ["unknown", true],
  ] as const;
  for (const [kind, retry] of cases) {
    const help = cameraHelp(kind, "android");
    assert.equal(help.canRetry, retry, kind);
    assert.equal(help.offerMarkByHand, true, kind);
    assert.equal(help.title, "Camera isn't available", "one headline, whatever the cause");
    assert.ok(help.reason.length > 0 && help.reason.length <= 60 && help.steps.length > 0, kind);
    assert.doesNotMatch(`${help.title} ${help.reason} ${help.steps.join(" ")}`, JARGON, kind);
  }
});

test("every reopened camera keeps the classroom resolution target", () => {
  assert.deepEqual(classroomVideoConstraints({ facingMode: "environment" }), {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  });
  // A second photo, a retake or a switch reopens by id: same target.
  assert.deepEqual(classroomVideoConstraints({ facingMode: "environment", deviceId: "rear-1" }), {
    deviceId: { exact: "rear-1" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  });
});

// ---------------------------------------------------------------------------
// Photos, retakes and Done
// ---------------------------------------------------------------------------

test("capture retry: a retaken photo reuses its slot; three photos is the limit", () => {
  assert.equal(nextSequenceNumber([]), 1);
  assert.equal(nextSequenceNumber([{ sequenceNumber: 1 }]), 2);
  // Photo 2 of three retaken: it was removed, so its slot is the next one.
  assert.equal(nextSequenceNumber([{ sequenceNumber: 1 }, { sequenceNumber: 3 }]), 2);
  assert.equal(nextSequenceNumber([{ sequenceNumber: 1 }, { sequenceNumber: 2 }, { sequenceNumber: 3 }]), null);
});

test("a photo's check: checking, faces found, unclear, none, or couldn't check — in plain words", () => {
  const shot = (s: Partial<FlowShot>): FlowShot => ({ sequenceNumber: 1, ...s });
  assert.deepEqual(photoStatusOf(shot({ checking: true })), { tone: "checking", label: "Checking faces…", detail: null });
  assert.deepEqual(photoStatusOf(shot({ analysis: { faceCount: 18, qualityLabel: "good" } })), {
    tone: "good",
    label: "18 faces found",
    detail: null,
  });
  assert.equal(photoStatusOf(shot({ analysis: { faceCount: 1, qualityLabel: "good" } })).label, "1 face found");
  assert.equal(photoStatusOf(shot({ analysis: { faceCount: 12, qualityLabel: "acceptable" } })).tone, "warning");
  assert.equal(photoStatusOf(shot({ analysis: { faceCount: 3, qualityLabel: "poor" } })).label, "Only 3 faces clear");
  assert.equal(photoStatusOf(shot({ analysis: { faceCount: 0, qualityLabel: "no_faces" } })).label, "No faces found");
  const failed = photoStatusOf(shot({ failure: { message: "Face detection took too long to respond. Try again." } }));
  assert.equal(failed.tone, "bad");
  assert.equal(failed.label, "Couldn't finish checking this photo");
  assert.deepEqual(photoStatusOf(shot({ failure: { message: "x", kind: "connection" } })), {
    tone: "bad",
    label: "Connection lost",
    detail: "Your photo hasn't been submitted.",
  });
  for (const label of ["good", "acceptable", "poor", "no_faces"] as const) {
    const status = photoStatusOf(shot({ analysis: { faceCount: 4, qualityLabel: label } }));
    assert.doesNotMatch(`${status.label} ${status.detail ?? ""}`, JARGON, label);
  }
});

test("Done is allowed exactly when Process attendance was: a photo, every check finished, none failed", () => {
  const good: FlowShot = { sequenceNumber: 1, analysis: { faceCount: 5, qualityLabel: "good" } };
  assert.deepEqual(doneStateOf([]), { enabled: false, reason: "Take a photo of the class first." });
  assert.equal(doneStateOf([good, { sequenceNumber: 2, checking: true }]).enabled, false);
  assert.deepEqual(doneStateOf([good, { sequenceNumber: 2, checking: true }], { offline: true }), {
    enabled: false,
    reason: "Waiting for the connection",
  });
  assert.equal(doneStateOf([good, { sequenceNumber: 2, failure: { message: "x" } }]).enabled, false);
  assert.deepEqual(doneStateOf([good]), { enabled: true, reason: null });
  // Unchanged rule: a photo with nobody in it does not block — the register
  // then asks about every student.
  assert.equal(doneStateOf([{ sequenceNumber: 1, analysis: { faceCount: 0, qualityLabel: "no_faces" } }]).enabled, true);
});

// ---------------------------------------------------------------------------
// Processing and the result
// ---------------------------------------------------------------------------

test("processing state: short labels and an honest elapsed time", () => {
  assert.equal(PROCESSING_LABEL.matching, "Matching students…");
  assert.equal(PROCESSING_LABEL.preparing, "Preparing your list…");
  assert.equal(formatElapsed(0), "0 s");
  assert.equal(formatElapsed(8_400), "8 s");
  assert.equal(formatElapsed(65_000), "1 min 05 s");
  assert.equal(formatElapsed(-5), "0 s");
});

test("attendance ready: recognised students are present, everyone else is to check — nobody is counted absent", () => {
  const summary = readySummaryOf({
    total: 30,
    recognition: {
      recognised: 26,
      lookAlikes: 1,
      detectedFaces: 28,
      unknownFaces: 1,
      comparableStudents: 30,
      needReenrolment: 0,
      recommendRetake: true,
    },
    availability: "ready",
  });
  assert.deepEqual([summary.total, summary.present, summary.toCheck], [30, 26, 4]);

  // Once the register is written its own count is used: a merged round keeps
  // a student a teacher already marked present.
  const merged = readySummaryOf({ total: 30, present: 27, recognition: null, availability: "ready" });
  assert.deepEqual([merged.present, merged.toCheck], [27, 3]);
  assert.ok(summary.notices.some((n) => /too small/.test(n.text)));
  assert.ok(summary.notices.some((n) => /looked too alike/.test(n.text)));
  for (const notice of summary.notices) assert.doesNotMatch(notice.text, JARGON);
});

test("attendance ready, nobody recognised: the reason is said in a teacher's words", () => {
  const base = { total: 10, availability: "ready" as const };
  const recognition = {
    recognised: 0,
    lookAlikes: 0,
    detectedFaces: 0,
    unknownFaces: 0,
    comparableStudents: 2,
    needReenrolment: 0,
    recommendRetake: false,
  };
  const noFaces = readySummaryOf({ ...base, recognition });
  assert.match(noFaces.notices[0].text, /No faces were found/);
  const noneOnFile = readySummaryOf({ ...base, recognition: { ...recognition, detectedFaces: 4, comparableStudents: 0 } });
  assert.match(noneOnFile.notices[0].text, /face photo on file/);
  const notAvailable = readySummaryOf({ total: 10, recognition: null, availability: "unavailable" });
  assert.match(notAvailable.notices[0].text, /isn't fully available/);
  assert.deepEqual([notAvailable.present, notAvailable.toCheck], [0, 10]);
  for (const s of [noFaces, noneOnFile, notAvailable]) {
    for (const notice of s.notices) assert.doesNotMatch(notice.text, JARGON);
  }
});

// ---------------------------------------------------------------------------
// Errors: codes on the server, words on the screen
// ---------------------------------------------------------------------------

test("the services' tagged errors become codes on the server — the screen never sees a raw message", () => {
  const cases: Array<[unknown, CaptureFlowErrorCode]> = [
    [new Error("session_locked:FINALIZED"), "register_finished"],
    [new Error("session_locked:CANCELLED"), "register_closed"],
    [new Error("session_not_found"), "register_closed"],
    [new Error("session_status_conflict"), "register_changed"],
    [new Error("empty_roster"), "no_students"],
    [new ForbiddenError("not_cohort_faculty"), "not_allowed"],
    [new ForbiddenError("not_subject_faculty"), "not_allowed"],
    [new Error("cohort_not_found"), "not_allowed"],
    [new Error("subject_wise_mode_requires_subject"), "needs_subject"],
    [new Error("cohort_subject_mismatch"), "needs_subject"],
    [new Error("face_ai_timeout"), "matching_slow"],
    [new Error("face_ai_model_changed"), "matching_changed"],
    [new Error("merge_model_mismatch"), "matching_changed"],
    [new Error("face_ai_invalid_embedding:nan"), "matching_failed"],
    [new Error("duplicate_image_sequence"), "photos_invalid"],
    [new Error("Minified React error #441"), "unknown"],
    ["not an error", "unknown"],
  ];
  for (const [error, code] of cases) assert.equal(captureFlowErrorCode(error), code, String(error));
});

test("every code has words a teacher can act on; marking by hand only once a register exists", () => {
  const codes: CaptureFlowErrorCode[] = [
    "register_finished",
    "register_closed",
    "register_changed",
    "no_students",
    "not_allowed",
    "needs_subject",
    "matching_slow",
    "matching_changed",
    "matching_failed",
    "photos_invalid",
    "unknown",
  ];
  for (const code of codes) {
    const atStart = describeCaptureFlowError(code, "start");
    const later = describeCaptureFlowError(code, "process");
    assert.equal(atStart.canMarkByHand, false, `${code}: no register exists before Start`);
    assert.ok(atStart.message.length > 0 && later.message.length > 0, code);
    assert.doesNotMatch(atStart.message, /Minified|#\d+|_/, code);
    assert.doesNotMatch(later.message, /Minified|#\d+|_/, code);
  }
  assert.equal(describeCaptureFlowError("matching_slow", "process").canMarkByHand, true);
  assert.equal(describeCaptureFlowError("matching_slow", "process").canRetry, true);
  assert.equal(describeCaptureFlowError("register_finished", "process").canRetry, false);
});

// ---------------------------------------------------------------------------
// When the connection, the camera or the matching fails
// ---------------------------------------------------------------------------

test("a dropped connection is told apart from a server's answer, in every browser's wording", () => {
  assert.equal(isConnectionError(new TypeError("Failed to fetch")), true, "Chrome");
  assert.equal(isConnectionError(new TypeError("Load failed")), true, "Safari");
  assert.equal(isConnectionError(new TypeError("NetworkError when attempting to fetch resource.")), true, "Firefox");
  assert.equal(isConnectionError(new Error("anything"), false), true, "an offline device, whatever the error");
  assert.equal(isConnectionError(new Error("Minified React error #441")), false);
  assert.equal(isConnectionError(new TypeError("x is not a function")), false);
  assert.equal(isConnectionError(undefined), false);
});

test("connection lost: says what did not happen, offers Retry, and never offers a by-hand path that also needs the server", () => {
  const start = describeCaptureFlowError("connection_lost", "start");
  const process = describeCaptureFlowError("connection_lost", "process");
  assert.match(start.message, /hasn't been started/);
  assert.match(process.message, /Your photo hasn't been submitted/);
  for (const copy of [start, process, describeCaptureFlowError("connection_lost", "markByHand")]) {
    assert.equal(copy.canRetry, true);
    assert.equal(copy.canMarkByHand, false);
    assert.doesNotMatch(copy.message, JARGON);
  }
  assert.equal(retryLabel("connection_lost"), "Retry");
  assert.equal(retryLabel("matching_slow"), "Try again");
});

test("failure headlines: 'Connection lost', 'Couldn't finish checking this photo.' — or these photos", () => {
  assert.equal(failureHeadline("connection_lost", "process"), "Connection lost");
  assert.equal(failureHeadline("matching_slow", "process", 1), "Couldn't finish checking this photo.");
  assert.equal(failureHeadline("matching_failed", "process", 3), "Couldn't finish checking these photos.");
  assert.equal(failureHeadline("unknown", "start"), "Couldn't start attendance");
  assert.equal(failureHeadline("connection_lost", "start"), "Connection lost");
});

test("a check still in flight when the connection drops reads 'Connection lost', not an endless spinner", () => {
  const pending: FlowShot = { sequenceNumber: 1, checking: true };
  assert.equal(photoStatusOf(pending).label, "Checking faces…");
  const offline = photoStatusOf(pending, { offline: true });
  assert.equal(offline.label, "Connection lost");
  assert.match(offline.detail ?? "", /Your photo hasn't been submitted/);
  assert.equal(photoStatusOf({ sequenceNumber: 1, analysis: { faceCount: 3, qualityLabel: "good" } }, { offline: true }).label, "3 faces found", "a finished check is not undone by going offline");
});

test("a face service that is down is told apart from everything else, and worded as an outage", () => {
  assert.equal(captureFlowErrorCode(new TypeError("fetch failed")), "matching_unavailable");
  assert.equal(captureFlowErrorCode(new Error("face-ai /v1/detect-embed failed: 503 azure_face_unavailable")), "matching_unavailable");
  assert.equal(captureFlowErrorCode(new Error("face-ai model-info failed: 502")), "matching_unavailable");
  assert.equal(captureFlowErrorCode(new Error("face-ai /v1/detect-embed failed: 400")), "unknown", "a refused request is not an outage");
  const copy = describeCaptureFlowError("matching_unavailable", "process");
  assert.match(copy.message, /isn't responding/);
  assert.equal(copy.canRetry, true);
  assert.equal(copy.canMarkByHand, true);
  assert.doesNotMatch(copy.message, JARGON);
  assert.equal(failureHeadline("matching_unavailable", "process"), "Couldn't finish checking this photo.");
});
