import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeRecognitionAvailability,
  percent,
  recognitionAvailability,
  recognitionCountLabels,
  studentResultLabel,
} from "./wording.ts";

const MOCK = { modelName: "mock", modelVersion: "0.1.0+pp1", productionEligible: false };
const UNAPPROVED = { modelName: "opencv-yunet-sface", modelVersion: "2023mar+pp2", productionEligible: false };
const APPROVED = { modelName: "licensed-model", modelVersion: "1.0.0", productionEligible: true };

test("the test stand-in is reported as unavailable, never as ready", () => {
  assert.equal(recognitionAvailability(MOCK), "unavailable");
  // Even a misconfigured deployment that flags the stand-in as eligible.
  assert.equal(recognitionAvailability({ ...MOCK, productionEligible: true }), "unavailable");
  const m = describeRecognitionAvailability(MOCK, { showDiagnostics: false });
  assert.equal(m.headline, "Face recognition unavailable");
  assert.match(m.detail, /not available/);
  assert.match(m.detail, /cannot tell one real face from another/);
});

test("a real but unapproved model says results need confirmation and why", () => {
  const m = describeRecognitionAvailability(UNAPPROVED, { showDiagnostics: false });
  assert.equal(m.availability, "not_approved");
  assert.equal(m.headline, "Recognition results require confirmation");
  assert.match(m.detail, /not approved for production/);
});

test("an approved model is ready, and still needs confirmation", () => {
  const m = describeRecognitionAvailability(APPROVED, { showDiagnostics: false });
  assert.equal(m.headline, "Face recognition ready");
  assert.match(m.detail, /require confirmation/);
});

test("teachers never see the provider; admins do", () => {
  for (const model of [MOCK, UNAPPROVED, APPROVED]) {
    const teacher = describeRecognitionAvailability(model, { showDiagnostics: false });
    assert.equal(teacher.diagnostics, null);
    const text = `${teacher.headline} ${teacher.detail}`;
    assert.ok(!text.includes(model.modelName), `${model.modelName} leaked to a teacher`);
    assert.ok(!/backend/i.test(text));
    const admin = describeRecognitionAvailability(model, { showDiagnostics: true });
    assert.ok(admin.diagnostics?.includes(model.modelName));
    assert.ok(admin.diagnostics?.includes(model.modelVersion));
  }
});

test("count labels read as the product words them", () => {
  assert.deepEqual(recognitionCountLabels({ present: 3, review: 2, notDetected: 1, unknownFaces: 1 }), {
    present: "3 Present suggestions",
    review: "2 Need review",
    notDetected: "1 Not detected",
    unknownFaces: "1 Unknown face",
  });
  assert.equal(recognitionCountLabels({ present: 1, review: 1, notDetected: 0, unknownFaces: 0 }).review, "1 Needs review");
});

test("per-student labels", () => {
  assert.equal(studentResultLabel({ suggestion: "PRESENT", aiResult: "PRESENT", aiConfidence: 0.912, reason: null }), "Present — 91%");
  assert.equal(studentResultLabel({ suggestion: null, aiResult: "NEEDS_REVIEW", aiConfidence: 0.58, reason: "low_confidence" }), "Needs review — 58%");
  assert.equal(studentResultLabel({ suggestion: null, aiResult: "NEEDS_REVIEW", aiConfidence: 0.9, reason: "face_too_small" }), "Face too small");
  assert.equal(studentResultLabel({ suggestion: null, aiResult: "NOT_EVALUATED", aiConfidence: null, reason: "face_too_small" }), "Face too small");
  assert.equal(studentResultLabel({ suggestion: null, aiResult: "ABSENT", aiConfidence: null, reason: "no_match" }), "No reliable match");
  assert.equal(studentResultLabel({ suggestion: null, aiResult: "NOT_EVALUATED", aiConfidence: null, reason: "no_face_template" }), null);
});

test("percent clamps and rounds, and refuses to invent a number", () => {
  assert.equal(percent(0.995), "100%");
  assert.equal(percent(-0.2), "0%");
  assert.equal(percent(null), null);
  assert.equal(percent(Number.NaN), null);
});
