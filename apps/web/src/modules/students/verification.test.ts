import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVerification,
  factsFromRow,
  missingSummary,
  parseVerificationFilter,
  verificationClauses,
  type VerificationFacts,
} from "./verification.ts";

/**
 * Verification is computed, never stored: these are the rules that turn a
 * student's existing records into "complete" or "incomplete".
 */

const MODEL = { modelName: "dlib", modelVersion: "1+pp1" };
const facts = (overrides: Partial<VerificationFacts> = {}): VerificationFacts => ({
  onRoll: true,
  login: "active",
  placed: true,
  usableFaceSamples: 3,
  activeFaceSamples: 3,
  twinReview: null,
  faceEnrolledSince: new Date("2026-09-30T08:00:00Z"),
  ...overrides,
});

test("20. a student with an account, a class and a usable face is Complete", () => {
  const verification = computeVerification(facts());
  assert.equal(verification.overall, "complete");
  assert.equal(verification.face, "enrolled");
  assert.deepEqual(verification.items.map((item) => [item.key, item.complete]), [
    ["account", true],
    ["details", true],
    ["face", true],
  ]);
  assert.match(verification.items[2].detail, /Face enrolled · 3 samples/);
});

test("19. a student with no face is Incomplete — face enrollment pending", () => {
  const verification = computeVerification(facts({ usableFaceSamples: 0, activeFaceSamples: 0, faceEnrolledSince: null }));
  assert.equal(verification.overall, "incomplete");
  assert.equal(verification.face, "pending");
  assert.equal(verification.items[2].detail, "Face enrollment pending");
  assert.equal(missingSummary(verification), "Face enrollment pending");
});

test("samples from a model this deployment no longer runs are not an enrollment", () => {
  const verification = computeVerification(facts({ usableFaceSamples: 0, activeFaceSamples: 4 }));
  assert.deepEqual([verification.overall, verification.face], ["incomplete", "needs_reenrollment"]);
});

test("a twin / lookalike conflict shows as blocked until staff decide — and as pending once they confirm", () => {
  const none = { usableFaceSamples: 0, activeFaceSamples: 0 };
  assert.equal(computeVerification(facts({ ...none, twinReview: "pending" })).face, "blocked_pending_review");
  assert.equal(computeVerification(facts({ ...none, twinReview: "not_confirmed" })).face, "blocked_not_confirmed");
  const confirmed = computeVerification(facts({ ...none, twinReview: "confirmed" }));
  assert.equal(confirmed.face, "pending");
  assert.match(confirmed.items[2].detail, /confirmed, so enrollment can go ahead/);
  // Enrolled after confirmation: complete, whatever the history.
  assert.equal(computeVerification(facts({ twinReview: "confirmed" })).overall, "complete");
});

test("26. the checklist names what is missing: no login, a disabled login, no class", () => {
  const noLogin = computeVerification(facts({ login: "none" }));
  assert.deepEqual([noLogin.overall, noLogin.items[0].detail], ["incomplete", "No student login yet"]);
  assert.equal(computeVerification(facts({ login: "disabled" })).items[0].detail, "Login disabled");
  const unplaced = computeVerification(facts({ placed: false }));
  assert.match(unplaced.items[1].detail, /Not placed in a class/);
  assert.equal(
    missingSummary(computeVerification(facts({ login: "none", placed: false, usableFaceSamples: 0, activeFaceSamples: 0 }))),
    "No active login · Not in a class · Face enrollment pending",
  );
});

test("a student off roll has no verification state at all", () => {
  assert.equal(computeVerification(facts({ onRoll: false, usableFaceSamples: 0 })).overall, "off_roll");
});

test("the row facts count a face only when the running model made it", () => {
  const samples = [
    { ...MODEL, createdAt: new Date("2026-09-20T00:00:00Z") },
    { modelName: "dlib", modelVersion: "0+pp1", createdAt: new Date("2026-09-01T00:00:00Z") },
  ];
  const row = { status: "ACTIVE", user: { status: "ACTIVE" }, enrollmentCount: 1, samples };
  const known = factsFromRow(row, MODEL, null);
  assert.deepEqual([known.usableFaceSamples, known.activeFaceSamples], [1, 2]);
  assert.deepEqual(known.faceEnrolledSince, new Date("2026-09-20T00:00:00Z"));
  assert.equal(factsFromRow(row, null, null).usableFaceSamples, 2, "model unknown: any active sample counts");
  assert.equal(factsFromRow({ ...row, user: null }, MODEL, null).login, "none");
  assert.equal(factsFromRow({ ...row, user: { status: "INACTIVE" } }, MODEL, null).login, "disabled");
});

test("the filter's SQL is the same three rules, on roll only", () => {
  assert.deepEqual(verificationClauses("", MODEL), []);
  const sample = { isActive: true, ...MODEL };
  assert.deepEqual(verificationClauses("face_pending", MODEL), [{ status: "ACTIVE" }, { faceEmbeddings: { none: sample } }]);
  assert.deepEqual(verificationClauses("complete", MODEL), [
    { status: "ACTIVE" },
    { user: { is: { status: "ACTIVE" } } },
    { enrollments: { some: { status: "ACTIVE" } } },
    { faceEmbeddings: { some: sample } },
  ]);
  assert.deepEqual(verificationClauses("incomplete", null), [
    { status: "ACTIVE" },
    {
      OR: [
        { userId: null },
        { user: { is: { status: { not: "ACTIVE" } } } },
        { enrollments: { none: { status: "ACTIVE" } } },
        { faceEmbeddings: { none: { isActive: true } } },
      ],
    },
  ]);
});

test("an unknown filter value reads as no filter", () => {
  for (const value of ["complete", "incomplete", "face_pending"]) assert.equal(parseVerificationFilter(value), value);
  for (const value of ["", "COMPLETE", "verified", undefined, 3]) assert.equal(parseVerificationFilter(value), "");
});
