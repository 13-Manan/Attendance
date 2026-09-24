import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import {
  EMBEDDING_NORM_TOLERANCE,
  MAX_SAMPLES_PER_STUDENT,
  SAME_TEMPLATE_SIMILARITY,
  classifyEnrollmentCollision,
  classifyOwnSampleMismatch,
  defaultSelfEnrollmentEnabled,
  inspectEmbedding,
  resolveSelfEnrollmentEnabled,
  similarity,
  summariseEnrollmentStatus,
  FACE_ENROLLMENT_SETTINGS_KEY,
  type NeighbourTemplate,
} from "./policy.ts";

/**
 * The rules that decide whether a face may be stored against a name.
 *
 * Asserted here rather than through the service, because every one of them is
 * a pure function of its inputs and the interesting cases — a vector on the
 * wrong scale, a face that is 0.61 similar to a classmate when the threshold
 * is 0.62 — are ones no fixture database would produce on demand.
 */

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/** A unit vector of the contract's length, with its energy in one component. */
function unitVector(seedIndex = 0): number[] {
  const vector = new Array(EMBEDDING_DIMENSION).fill(0);
  vector[seedIndex % EMBEDDING_DIMENSION] = 1;
  return vector;
}

test("a vector of the wrong length is refused, whatever its norm", () => {
  // Derived from the contract rather than written as a number, so this stays a
  // wrong-length vector whatever the contract's width becomes. It was a
  // hardcoded 128 until Phase 5 made 128 the correct width — at which point the
  // test was asserting that a valid vector is invalid.
  const wrongLength = new Array(EMBEDDING_DIMENSION * 2).fill(0);
  wrongLength[0] = 1;
  const check = inspectEmbedding(wrongLength);
  assert.equal(check.ok, false);
  assert.equal(check.ok === false && check.problem, "wrong_dimension");
  assert.match(
    check.ok === false ? check.detail : "",
    new RegExp(`expected ${EMBEDDING_DIMENSION}`),
  );
});

test("an un-normalised vector is refused, because cosine is computed as a dot product", () => {
  // This is the failure with no symptom. An un-normalised vector does not
  // produce a slightly wrong similarity — it produces one on a different
  // scale, which every threshold in the product then misreads, for as long as
  // the template exists.
  const doubled = unitVector().map((value) => value * 2);
  const check = inspectEmbedding(doubled);
  assert.equal(check.ok, false);
  assert.equal(check.ok === false && check.problem, "not_normalised");
  assert.match(check.ok === false ? check.detail : "", /L2 norm is 2\./);
});

test("a NaN is caught before it reaches the database", () => {
  const poisoned = unitVector();
  poisoned[5] = Number.NaN;
  const check = inspectEmbedding(poisoned);
  assert.equal(check.ok, false);
  assert.equal(check.ok === false && check.problem, "not_finite");
});

test("float error accumulated over every component is tolerated", () => {
  // A backend doing everything right cannot return an exact 1.0: summing 128
  // squared float32 values drifts. A check that demanded equality would refuse
  // every honest enrollment.
  const drifted = unitVector().map((value, index) => (index === 0 ? value * (1 + 5e-5) : value));
  assert.equal(inspectEmbedding(drifted).ok, true);
});

test("the tolerance is far below any real mistake and far above float noise", () => {
  // Stated as a test because the number is the whole of the check: too tight
  // and honest vectors are refused, too loose and a half-normalised one passes.
  assert.ok(EMBEDDING_NORM_TOLERANCE < 1e-2, "a 1% error is a bug, not noise");
  assert.ok(EMBEDDING_NORM_TOLERANCE > 1e-6, "tighter than this refuses correct backends");
});

test("cosine similarity of identical unit vectors is 1, and of orthogonal ones is 0", () => {
  const a = unitVector(0);
  assert.equal(similarity(a, a), 1);
  assert.equal(similarity(a, unitVector(1)), 0);
});

test("similarity never exceeds 1, however the float error falls", () => {
  // A logged similarity of 1.0000000002 reads as a bug in the comparison, and
  // a threshold check written as `>= 1` would behave differently on it.
  const a = unitVector().map((value, index) => (index === 0 ? value * 1.0000001 : value));
  assert.ok(similarity(a, a) <= 1);
});

test("vectors of different lengths score 0 rather than comparing a prefix", () => {
  // Reached only if two models with different dimensions were ever mixed. A
  // prefix comparison would produce a plausible number from unrelated data.
  assert.equal(similarity(unitVector(), [1, 0, 0]), 0);
});

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

const THRESHOLDS = { presentMin: 0.62, reviewMin: 0.45 };

function neighbour(
  studentId: string,
  score: number,
  id = `emb-${studentId}-${score}`,
  rawScore = score,
): NeighbourTemplate {
  return { embeddingId: id, studentId, similarity: score, rawSimilarity: rawScore };
}

test("a face that recognition would confidently call somebody else is refused", () => {
  const collision = classifyEnrollmentCollision(
    [neighbour("student-other", 0.91)],
    "student-target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "belongs_to_other_student");
  assert.equal(collision.kind === "belongs_to_other_student" && collision.studentId, "student-other");
});

test("a face in the review band against another student is refused as ambiguous", () => {
  // Storing it would not produce a wrong register — it would produce one that
  // never settles, because every capture of either student goes to a human.
  const collision = classifyEnrollmentCollision(
    [neighbour("student-other", 0.5)],
    "student-target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "ambiguous_with_other_student");
});

test("the boundaries belong to the stricter outcome", () => {
  // Exactly at presentMin is a confident match, exactly at reviewMin is
  // ambiguous. Written down because an off-by-one here is the difference
  // between refusing a collision and storing it.
  assert.equal(
    classifyEnrollmentCollision([neighbour("other", 0.62)], "target", THRESHOLDS).kind,
    "belongs_to_other_student",
  );
  assert.equal(
    classifyEnrollmentCollision([neighbour("other", 0.45)], "target", THRESHOLDS).kind,
    "ambiguous_with_other_student",
  );
  assert.equal(
    classifyEnrollmentCollision([neighbour("other", 0.4499)], "target", THRESHOLDS).kind,
    "none",
  );
});

test("two people who simply look a bit alike are not a collision", () => {
  // The common case, and the one a careless check would break: unrelated faces
  // score well above zero on a real model. Refusing at 0.3 would make
  // enrollment fail for half a school.
  assert.equal(
    classifyEnrollmentCollision([neighbour("other", 0.31)], "target", THRESHOLDS).kind,
    "none",
  );
});

test("a second sample of the same student is what success looks like", () => {
  // The check must not refuse the thing it exists to allow. A student's own
  // templates at any ordinary similarity are fine — that is a second
  // photograph of them.
  assert.equal(
    classifyEnrollmentCollision([neighbour("target", 0.88)], "target", THRESHOLDS).kind,
    "none",
  );
});

test("re-submitting the identical photograph is reported, not stored twice", () => {
  const collision = classifyEnrollmentCollision(
    [neighbour("target", 0.995)],
    "target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "already_enrolled");
});

test("the same-photograph threshold is high enough that two real captures pass", () => {
  // Two genuine photographs of one person minutes apart differ in expression,
  // angle and sensor noise. A threshold low enough to catch them would make a
  // second sample impossible to add.
  assert.ok(SAME_TEMPLATE_SIMILARITY >= 0.98);
  assert.equal(
    classifyEnrollmentCollision([neighbour("target", 0.97)], "target", THRESHOLDS).kind,
    "none",
  );
});

test("a collision with another student outranks a duplicate of this student's own face", () => {
  // Both facts are true; only one needs acting on. Reporting "you already
  // enrolled that" would hide a face that belongs to somebody else.
  const collision = classifyEnrollmentCollision(
    [neighbour("target", 0.999), neighbour("other", 0.8)],
    "target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "belongs_to_other_student");
});

test("the strongest other student wins, not the first one returned", () => {
  const collision = classifyEnrollmentCollision(
    [neighbour("mild", 0.5), neighbour("strong", 0.94), neighbour("other-mild", 0.46)],
    "target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "belongs_to_other_student");
  assert.equal(collision.kind === "belongs_to_other_student" && collision.studentId, "strong");
});

test("an empty neighbourhood is not a collision", () => {
  // The first student ever enrolled at an institution. A check that treated
  // "nothing to compare against" as suspicious would make the feature
  // impossible to start using.
  assert.equal(classifyEnrollmentCollision([], "target", THRESHOLDS).kind, "none");
});

test("an institution that has lowered its thresholds gets a stricter duplicate check", () => {
  // The point of reusing the recognition thresholds: the question is not "are
  // these faces similar" but "would the pipeline confuse them", and only the
  // pipeline's own numbers answer that. Lowering presentMin makes the engine
  // more willing to confuse two people, so enrollment must refuse earlier.
  const lenient = { presentMin: 0.4, reviewMin: 0.25 };
  assert.equal(
    classifyEnrollmentCollision([neighbour("other", 0.45)], "target", lenient).kind,
    "belongs_to_other_student",
  );
  assert.equal(
    classifyEnrollmentCollision([neighbour("other", 0.45)], "target", THRESHOLDS).kind,
    "ambiguous_with_other_student",
  );
});

// ---------------------------------------------------------------------------
// Consistency with the student's own samples
// ---------------------------------------------------------------------------

test("a sample that resembles none of the student's own templates is refused", () => {
  // The mis-filed photograph: a face nobody else is enrolled with, so the
  // neighbour scan says nothing, stored against a name it does not belong to.
  // Whoever is in it would then be marked present as that student.
  const collision = classifyOwnSampleMismatch([{ similarity: 0.21 }, { similarity: 0.18 }], THRESHOLDS);
  assert.equal(collision.kind, "does_not_match_own_samples");
  assert.equal(collision.kind === "does_not_match_own_samples" && collision.similarity, 0.21);
  assert.equal(collision.kind === "does_not_match_own_samples" && collision.comparedWith, 2);
});

test("the best of the student's own samples decides, not the worst", () => {
  // One bad early template must not condemn a good new sample. If any stored
  // template would recognise this face, the set is consistent.
  assert.equal(
    classifyOwnSampleMismatch([{ similarity: 0.12 }, { similarity: 0.77 }], THRESHOLDS).kind,
    "none",
  );
});

test("the first sample of a student is never a mismatch", () => {
  // Nothing to be consistent with. Treating an empty set as suspicious would
  // make the feature impossible to start using — same reasoning as the empty
  // neighbourhood above.
  assert.equal(classifyOwnSampleMismatch([], THRESHOLDS).kind, "none");
});

test("the own-sample floor is reviewMin, so anything recognition could match survives", () => {
  // Deliberately the *lower* of the two thresholds. A sample at 0.45 would
  // reach the review band against its own student, which is a weak but real
  // match; refusing it would reject genuine poor-light captures. Below it the
  // pipeline would never connect this face to this name at all, so storing it
  // can only mislead. Every one of the 61 genuine pairs in the calibration
  // corpus scored at or above 0.45 (docs/FACE_RECOGNITION_CALIBRATION.md §3).
  assert.equal(classifyOwnSampleMismatch([{ similarity: 0.45 }], THRESHOLDS).kind, "none");
  assert.equal(
    classifyOwnSampleMismatch([{ similarity: 0.4499 }], THRESHOLDS).kind,
    "does_not_match_own_samples",
  );
});

test("an institution that lowered its thresholds lowers this floor with them", () => {
  // Same principle as the collision check: the question is what this
  // institution's pipeline would do, not what a fixed number says.
  assert.equal(
    classifyOwnSampleMismatch([{ similarity: 0.3 }], { reviewMin: 0.25 }).kind,
    "none",
  );
});

// ---------------------------------------------------------------------------
// Self-enrollment
// ---------------------------------------------------------------------------

test("a college defaults to allowing self-enrollment and a school does not", () => {
  assert.equal(defaultSelfEnrollmentEnabled("COLLEGE"), true);
  assert.equal(defaultSelfEnrollmentEnabled("SCHOOL"), false);
});

test("an institution that has never opened the settings page gets its type's default", () => {
  assert.equal(resolveSelfEnrollmentEnabled({ type: "COLLEGE", settings: null }), true);
  assert.equal(resolveSelfEnrollmentEnabled({ type: "SCHOOL", settings: {} }), false);
});

test("an explicit setting overrides the type in both directions", () => {
  assert.equal(
    resolveSelfEnrollmentEnabled({
      type: "COLLEGE",
      settings: { [FACE_ENROLLMENT_SETTINGS_KEY]: { selfEnrollmentEnabled: false } },
    }),
    false,
    "a college can turn it off",
  );
  assert.equal(
    resolveSelfEnrollmentEnabled({
      type: "SCHOOL",
      settings: { [FACE_ENROLLMENT_SETTINGS_KEY]: { selfEnrollmentEnabled: true } },
    }),
    true,
    "a school running it for senior students can turn it on",
  );
});

test("a non-boolean in the settings column falls back to the default rather than being coerced", () => {
  // `"false"` is truthy, and a settings column edited by hand is exactly where
  // a string would come from. Coercing it would switch self-enrollment on at a
  // school whose administrator wrote the word "false".
  assert.equal(
    resolveSelfEnrollmentEnabled({
      type: "SCHOOL",
      settings: { [FACE_ENROLLMENT_SETTINGS_KEY]: { selfEnrollmentEnabled: "false" } },
    }),
    false,
  );
  assert.equal(
    resolveSelfEnrollmentEnabled({
      type: "COLLEGE",
      settings: { [FACE_ENROLLMENT_SETTINGS_KEY]: { selfEnrollmentEnabled: 0 } },
    }),
    true,
  );
});

test("a settings column holding something that is not an object does not throw", () => {
  assert.equal(resolveSelfEnrollmentEnabled({ type: "COLLEGE", settings: "corrupt" }), true);
  assert.equal(resolveSelfEnrollmentEnabled({ type: "SCHOOL", settings: 42 }), false);
});

// ---------------------------------------------------------------------------
// Enrollment status
// ---------------------------------------------------------------------------

const RUNNING = { modelName: "mock", modelVersion: "0.1.0+pp1" };
const RETIRED_MODEL = { modelName: "mock", modelVersion: "0.0.9+pp1" };

test("a student with no samples is not enrolled, with every slot free", () => {
  const summary = summariseEnrollmentStatus([], RUNNING);
  assert.equal(summary.status, "NOT_ENROLLED");
  assert.equal(summary.usableSamples, 0);
  assert.equal(summary.remainingSlots, MAX_SAMPLES_PER_STUDENT);
});

test("a sample from the running model makes a student enrolled", () => {
  const summary = summariseEnrollmentStatus([RUNNING], RUNNING);
  assert.equal(summary.status, "ENROLLED");
  assert.equal(summary.usableSamples, 1);
  assert.equal(summary.staleSamples, 0);
  assert.equal(summary.remainingSlots, MAX_SAMPLES_PER_STUDENT - 1);
});

test("samples only from a model no longer running mean the student needs re-enrolling", () => {
  // The failure this state exists to name: the student looks enrolled, has
  // templates, and will never be matched — because every candidate query
  // filters on the running model.
  const summary = summariseEnrollmentStatus([RETIRED_MODEL, RETIRED_MODEL], RUNNING);
  assert.equal(summary.status, "NEEDS_REENROLLMENT");
  assert.equal(summary.usableSamples, 0);
  assert.equal(summary.staleSamples, 2);
});

test("one usable sample is enough, and the stale ones are still counted", () => {
  const summary = summariseEnrollmentStatus([RETIRED_MODEL, RUNNING, RETIRED_MODEL], RUNNING);
  assert.equal(summary.status, "ENROLLED");
  assert.equal(summary.usableSamples, 1);
  assert.equal(summary.staleSamples, 2);
});

test("a preprocessing change alone makes a template unusable", () => {
  // Same weights, different preprocessing. The vectors are as incomparable as
  // if the model had been replaced, which is why the version is composite.
  const summary = summariseEnrollmentStatus(
    [{ modelName: "mock", modelVersion: "0.1.0+pp2" }],
    RUNNING,
  );
  assert.equal(summary.status, "NEEDS_REENROLLMENT");
});

test("an unreachable face service is reported as unknown, never as 'everyone must re-enrol'", () => {
  // A health check that timed out must not tell an administrator to
  // re-photograph a whole school.
  const summary = summariseEnrollmentStatus([RETIRED_MODEL], null);
  assert.equal(summary.status, "ENROLLED");
  assert.equal(summary.modelUnknown, true);
  assert.equal(summary.staleSamples, 0, "staleness is unknown, so nothing is claimed about it");
});

test("a student at the cap has no free slots and the number never goes negative", () => {
  const atCap = new Array(MAX_SAMPLES_PER_STUDENT).fill(RUNNING);
  assert.equal(summariseEnrollmentStatus(atCap, RUNNING).remainingSlots, 0);
  // Over the cap is only reachable if the limit were lowered in a later build
  // with rows already stored. The count must still read as "none free".
  const overCap = new Array(MAX_SAMPLES_PER_STUDENT + 2).fill(RUNNING);
  assert.equal(summariseEnrollmentStatus(overCap, RUNNING).remainingSlots, 0);
});

// ---------------------------------------------------------------------------
// Collisions on a backend whose raw scale is not the product's
// ---------------------------------------------------------------------------

/**
 * The caller has already mapped these rows onto the product's scale, so the
 * two numbers differ: `similarity` is what the thresholds are written
 * against, `rawSimilarity` is the recogniser's own cosine.
 */
function calibratedNeighbour(
  studentId: string,
  calibrated: number,
  raw: number,
): NeighbourTemplate {
  return {
    embeddingId: `emb-${studentId}`,
    studentId,
    similarity: calibrated,
    rawSimilarity: raw,
  };
}

test("a high raw score that is not a confident match is flagged, not refused outright", () => {
  // 0.94 raw is two different people for the dlib recogniser, and calibrates
  // to 0.518. Read raw it clears presentMin and every enrollment in the
  // institution would be refused as somebody else's face.
  const collision = classifyEnrollmentCollision(
    [calibratedNeighbour("student-other", 0.518, 0.94)],
    "student-target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "ambiguous_with_other_student");
});

test("a genuinely colliding face is still refused on the calibrated scale", () => {
  const collision = classifyEnrollmentCollision(
    [calibratedNeighbour("student-other", 0.75, 0.97)],
    "student-target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "belongs_to_other_student");
});

test("the same photograph twice is detected by the raw score, not the calibrated one", () => {
  // Identical vectors score 1.0 raw. Their calibrated score is also 1.0 here,
  // but the test that matters is the one below: a re-submission whose
  // calibrated score sits well under 0.99 must still be caught.
  const collision = classifyEnrollmentCollision(
    [calibratedNeighbour("student-target", 0.62, 0.995)],
    "student-target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "already_enrolled");
});

test("two genuine samples of one student are not mistaken for the same photograph", () => {
  const collision = classifyEnrollmentCollision(
    [calibratedNeighbour("student-target", 0.95, 0.985)],
    "student-target",
    THRESHOLDS,
  );
  assert.equal(collision.kind, "none");
});

test("an own-sample mismatch is judged on the calibrated scale", () => {
  // 0.9 raw calibrates to 0.427, below reviewMin: this is not the same
  // person. Read raw it would sail past and the wrong face would be stored.
  const mismatch = classifyOwnSampleMismatch([{ similarity: 0.427 }], THRESHOLDS);
  assert.equal(mismatch.kind, "does_not_match_own_samples");

  const fine = classifyOwnSampleMismatch([{ similarity: 0.52 }], THRESHOLDS);
  assert.equal(fine.kind, "none");
});
