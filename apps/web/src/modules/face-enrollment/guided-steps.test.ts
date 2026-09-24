import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUIDED_STEP_ORDER,
  captureFeedbackHeadline,
  currentGuidedStep,
  guidedStep,
} from "./guided-steps.ts";
import { MAX_SAMPLES_PER_STUDENT } from "./policy.ts";

test("the sequence is frontal, left, right, expression, lighting — and fits the slot limit", () => {
  assert.deepEqual(GUIDED_STEP_ORDER, ["frontal", "left", "right", "expression", "lighting"]);
  assert.ok(GUIDED_STEP_ORDER.length <= MAX_SAMPLES_PER_STUDENT);
});

test("the step follows the stored-sample counter, and ends when the set is complete", () => {
  assert.equal(currentGuidedStep(0), "frontal");
  assert.equal(currentGuidedStep(1), "left");
  assert.equal(currentGuidedStep(2), "right");
  assert.equal(currentGuidedStep(3), "expression");
  assert.equal(currentGuidedStep(4), "lighting");
  assert.equal(currentGuidedStep(5), null);
  assert.equal(currentGuidedStep(-1), "frontal");
});

test("turn instructions use the subject's own left and right, never the screen's", () => {
  for (const subject of ["self", "student"] as const) {
    for (const key of ["left", "right"] as const) {
      const text = guidedStep(key, subject).instruction;
      assert.doesNotMatch(text, /screen|mirror|image/i);
      assert.match(text, subject === "self" ? new RegExp(`your ${key}`) : new RegExp(`their own ${key}`));
    }
  }
});

test("feedback headlines are the product's words", () => {
  assert.equal(captureFeedbackHeadline({ ok: true }), "Good — capture accepted");
  assert.equal(captureFeedbackHeadline({ ok: false, reason: "face_too_small" }), "Move closer");
  assert.equal(captureFeedbackHeadline({ ok: false, reason: "bad_angle" }), "Face the camera");
  assert.equal(captureFeedbackHeadline({ ok: false, reason: "too_dark" }), "Too dark");
  assert.equal(captureFeedbackHeadline({ ok: false, reason: "blurred" }), "Face is blurry");
  assert.equal(
    captureFeedbackHeadline({ ok: false, reason: "multiple_faces" }),
    "Only one face should be visible",
  );
});

test("a refusal about another student's face gives nothing away in the headline", () => {
  for (const reason of ["duplicate_identity", "ambiguous_identity"] as const) {
    assert.equal(captureFeedbackHeadline({ ok: false, reason }), "Could not be saved");
  }
});
