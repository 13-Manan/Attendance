import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRecognitionConfidence,
  matchStatusToAttendanceResult,
  toMatchThresholds,
} from "./service.ts";
import type { ConfidenceThresholds } from "./types.ts";
import type { MatchStatus } from "@attendance/shared-types";

const THRESHOLDS: ConfidenceThresholds = { presentMin: 0.62, reviewMin: 0.45 };

// ---------------------------------------------------------------------------
// Match status -> attendance vocabulary
// ---------------------------------------------------------------------------

test("MATCHED/UNCERTAIN/UNMATCHED each map to exactly one attendance result", () => {
  assert.equal(matchStatusToAttendanceResult("MATCHED"), "PRESENT");
  assert.equal(matchStatusToAttendanceResult("UNCERTAIN"), "NEEDS_REVIEW");
  assert.equal(matchStatusToAttendanceResult("UNMATCHED"), "ABSENT");
});

test("an uncertain match is never silently marked present", () => {
  // The central safety property of the confidence engine: "probably this
  // student" must reach a human, not the attendance register.
  assert.notEqual(matchStatusToAttendanceResult("UNCERTAIN"), "PRESENT");
  assert.notEqual(matchStatusToAttendanceResult("UNMATCHED"), "PRESENT");
});

test("the mapping is total — every status in the contract is handled", () => {
  const all: MatchStatus[] = ["MATCHED", "UNCERTAIN", "UNMATCHED"];
  for (const status of all) {
    const result = matchStatusToAttendanceResult(status);
    assert.ok(
      result === "PRESENT" || result === "ABSENT" || result === "NEEDS_REVIEW",
      `${status} produced ${result}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Threshold ownership
// ---------------------------------------------------------------------------

test("institution thresholds are what get sent to the AI service", () => {
  // Thresholds are our policy, not the model's. This projection is what
  // keeps them configurable per institution rather than baked into whichever
  // backend happens to be deployed.
  assert.deepEqual(toMatchThresholds(THRESHOLDS), {
    matchThreshold: 0.62,
    reviewThreshold: 0.45,
  });
  assert.deepEqual(toMatchThresholds({ presentMin: 0.8, reviewMin: 0.5 }), {
    matchThreshold: 0.8,
    reviewThreshold: 0.5,
  });
});

test("classifying by status and by raw score agree at the boundaries", () => {
  // Scoring may happen in the service (status) or here (raw similarity)
  // depending on the call path; the two must not disagree about the same
  // score, or the same face would be Present on one path and Review on the
  // other.
  assert.equal(
    classifyRecognitionConfidence(0.62, THRESHOLDS),
    matchStatusToAttendanceResult("MATCHED"),
  );
  assert.equal(
    classifyRecognitionConfidence(0.45, THRESHOLDS),
    matchStatusToAttendanceResult("UNCERTAIN"),
  );
  assert.equal(
    classifyRecognitionConfidence(0.44, THRESHOLDS),
    matchStatusToAttendanceResult("UNMATCHED"),
  );
});

// ---------------------------------------------------------------------------
// Raw-score classification
// ---------------------------------------------------------------------------

test("no candidate matched at all is ABSENT, not an error", () => {
  assert.equal(classifyRecognitionConfidence(null, THRESHOLDS), "ABSENT");
});

test("confidence thresholds are inclusive at both boundaries", () => {
  assert.equal(classifyRecognitionConfidence(0.62, THRESHOLDS), "PRESENT");
  assert.equal(classifyRecognitionConfidence(0.6199, THRESHOLDS), "NEEDS_REVIEW");
  assert.equal(classifyRecognitionConfidence(0.45, THRESHOLDS), "NEEDS_REVIEW");
  assert.equal(classifyRecognitionConfidence(0.4499, THRESHOLDS), "ABSENT");
});
