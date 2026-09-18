import { test } from "node:test";
import assert from "node:assert/strict";
import {
  correctionWindowOpen,
  describeFacePolicyWarnings,
  facePolicyChangedFields,
  resolveAttendancePolicy,
  resolveFacePolicy,
  validateAttendancePolicy,
  validateFacePolicy,
  writeAttendancePolicy,
  writeFacePolicy,
} from "./policy.ts";
import {
  ATTENDANCE_POLICY_SETTINGS_KEY,
  AdminSettingsError,
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_FACE_POLICY,
  FACE_POLICY_SETTINGS_KEY,
  MAX_CORRECTION_WINDOW_DAYS,
} from "./types.ts";
import {
  DEFAULT_AMBIGUITY_MARGIN,
  DEFAULT_MIN_DETECTION_CONFIDENCE,
} from "../recognition-engine/types.ts";

/**
 * Settings codec tests.
 *
 * Two properties carry most of the weight here, and both are about damage
 * rather than features:
 *
 * 1. **Defaults equal the previous behaviour, exactly.** These settings were
 *    wired into live engines — the recognition policy and the correction path
 *    — so if a default drifts, every institution that never opened the
 *    settings page silently gets a different system. The first test asserts
 *    the defaults against the engine's own constants rather than against
 *    copies of the numbers.
 * 2. **A writer never destroys a key it does not own.** `Institution.settings`
 *    is one shared Json column holding academic labels, retention policy and
 *    the whole Integration Center connection list. There is no partial update
 *    in Postgres for it, so "preserve everything else" has to be a tested
 *    property and not a habit.
 */

// ---------------------------------------------------------------------------
// 1. Defaults reproduce the shipped behaviour
// ---------------------------------------------------------------------------

test("face policy defaults equal the recognition engine's own constants", () => {
  assert.equal(DEFAULT_FACE_POLICY.ambiguityMargin, DEFAULT_AMBIGUITY_MARGIN);
  assert.equal(DEFAULT_FACE_POLICY.minDetectionConfidence, DEFAULT_MIN_DETECTION_CONFIDENCE);
  // Mirrors DEFAULT_CONFIDENCE_THRESHOLDS in modules/institutions/service.ts,
  // which is not exported; the values are pinned here so a change there that
  // is not mirrored fails a test rather than silently splitting the two.
  assert.equal(DEFAULT_FACE_POLICY.presentMin, 0.62);
  assert.equal(DEFAULT_FACE_POLICY.reviewMin, 0.45);
});

test("an institution with no settings gets the shipped defaults", () => {
  for (const settings of [null, undefined, {}, [], "nonsense", 42]) {
    assert.deepEqual(resolveFacePolicy(settings), DEFAULT_FACE_POLICY);
    assert.deepEqual(resolveAttendancePolicy(settings), DEFAULT_ATTENDANCE_POLICY);
  }
});

test("the default correction policy imposes no window and no mandatory reason", () => {
  assert.equal(DEFAULT_ATTENDANCE_POLICY.correctionWindowDays, 0);
  assert.equal(DEFAULT_ATTENDANCE_POLICY.requireReasonAfterFinalization, false);
});

// ---------------------------------------------------------------------------
// 2. Reading clamps, and clamps toward the measured value
// ---------------------------------------------------------------------------

test("a stored threshold outside its range reads as the default, not as the nearest bound", () => {
  const policy = resolveFacePolicy({ confidenceThresholds: { presentMin: 5, reviewMin: -3 } });
  assert.equal(policy.presentMin, DEFAULT_FACE_POLICY.presentMin);
  assert.equal(policy.reviewMin, DEFAULT_FACE_POLICY.reviewMin);
});

test("NaN and Infinity in settings never reach the engine", () => {
  const policy = resolveFacePolicy({
    confidenceThresholds: { presentMin: Number.NaN, reviewMin: Number.POSITIVE_INFINITY },
    [FACE_POLICY_SETTINGS_KEY]: {
      ambiguityMargin: Number.NEGATIVE_INFINITY,
      minDetectionConfidence: Number.NaN,
    },
  });
  assert.deepEqual(policy, DEFAULT_FACE_POLICY);
});

test("an inverted stored threshold pair falls back to both defaults together", () => {
  // reviewMin >= presentMin collapses the uncertain band to nothing, so every
  // face becomes a confident Present or a silent Absent and nothing is ever
  // routed to a person. Nudging one value would leave a pair nobody chose.
  const policy = resolveFacePolicy({
    confidenceThresholds: { presentMin: 0.4, reviewMin: 0.55 },
  });
  assert.deepEqual(policy, DEFAULT_FACE_POLICY);
});

test("partially configured thresholds keep the configured half", () => {
  const policy = resolveFacePolicy({ confidenceThresholds: { presentMin: 0.7 } });
  assert.equal(policy.presentMin, 0.7);
  assert.equal(policy.reviewMin, DEFAULT_FACE_POLICY.reviewMin);
});

test("a negative correction window reads as no limit rather than as zero days", () => {
  const policy = resolveAttendancePolicy({
    [ATTENDANCE_POLICY_SETTINGS_KEY]: { correctionWindowDays: -7 },
  });
  assert.equal(policy.correctionWindowDays, 0);
});

test("a non-boolean reason flag reads as false", () => {
  const policy = resolveAttendancePolicy({
    [ATTENDANCE_POLICY_SETTINGS_KEY]: { requireReasonAfterFinalization: "yes" },
  });
  assert.equal(policy.requireReasonAfterFinalization, false);
});

// ---------------------------------------------------------------------------
// 3. Writing validates and refuses
// ---------------------------------------------------------------------------

test("a threshold below its floor is refused with the value named", () => {
  assert.throws(
    () =>
      validateFacePolicy({
        presentMin: 0.1,
        reviewMin: 0.05,
        ambiguityMargin: 0.05,
        minDetectionConfidence: 0.5,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AdminSettingsError);
      assert.match(error.message, /Present threshold/);
      assert.match(error.message, /0\.1/);
      return true;
    },
  );
});

test("equal thresholds are refused, and the refusal explains what would be lost", () => {
  assert.throws(
    () =>
      validateFacePolicy({
        presentMin: 0.6,
        reviewMin: 0.6,
        ambiguityMargin: 0.05,
        minDetectionConfidence: 0.5,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AdminSettingsError);
      assert.match(error.message, /must be below/);
      assert.match(error.message, /sent to a person/);
      return true;
    },
  );
});

test("a valid policy is quantized so floating-point noise never stores", () => {
  const policy = validateFacePolicy({
    presentMin: 0.6200000000000001,
    reviewMin: 0.45,
    ambiguityMargin: 0.05,
    minDetectionConfidence: 0.5,
  });
  assert.equal(policy.presentMin, 0.62);
});

test("an ambiguity margin of zero is allowed, and warned about", () => {
  const policy = validateFacePolicy({
    presentMin: 0.62,
    reviewMin: 0.45,
    ambiguityMargin: 0,
    minDetectionConfidence: 0.5,
  });
  assert.equal(policy.ambiguityMargin, 0);
  const warnings = describeFacePolicyWarnings(policy);
  assert.ok(warnings.some((w) => /look-alikes/.test(w)));
});

test("the shipped default produces no warnings", () => {
  assert.deepEqual(describeFacePolicyWarnings(DEFAULT_FACE_POLICY), []);
  assert.deepEqual(facePolicyChangedFields(DEFAULT_FACE_POLICY), []);
});

test("lowering the present threshold warns about students marked present who were absent", () => {
  const warnings = describeFacePolicyWarnings({ ...DEFAULT_FACE_POLICY, presentMin: 0.5 });
  assert.ok(warnings.some((w) => /marked present who were not there/.test(w)));
});

test("a correction window beyond the cap is refused", () => {
  assert.throws(
    () =>
      validateAttendancePolicy({
        correctionWindowDays: MAX_CORRECTION_WINDOW_DAYS + 1,
        requireReasonAfterFinalization: false,
      }),
    AdminSettingsError,
  );
});

test("a fractional correction window is refused rather than rounded", () => {
  assert.throws(
    () =>
      validateAttendancePolicy({
        correctionWindowDays: 1.5,
        requireReasonAfterFinalization: false,
      }),
    AdminSettingsError,
  );
});

// ---------------------------------------------------------------------------
// 4. Writers preserve every key they do not own
// ---------------------------------------------------------------------------

const NEIGHBOURS = {
  academicUnitLabels: { GRADE: "Standard" },
  biometricRetention: { faceTemplateRetentionDays: 0, onStudentInactive: "DEACTIVATE" },
  integrationConnections: [{ id: "conn-1", provider: "generic-rest" }],
  attendanceMode: "SUBJECT_WISE",
  lowAttendanceThreshold: 80,
};

test("saving a face policy leaves the retention policy and connection list untouched", () => {
  const next = writeFacePolicy(NEIGHBOURS, {
    presentMin: 0.7,
    reviewMin: 0.55,
    ambiguityMargin: 0.08,
    minDetectionConfidence: 0.6,
  });
  assert.deepEqual(next.academicUnitLabels, NEIGHBOURS.academicUnitLabels);
  assert.deepEqual(next.biometricRetention, NEIGHBOURS.biometricRetention);
  assert.deepEqual(next.integrationConnections, NEIGHBOURS.integrationConnections);
  assert.equal(next.attendanceMode, "SUBJECT_WISE");
  assert.equal(next.lowAttendanceThreshold, 80);
});

test("saving a face policy writes thresholds back to the key that already held them", () => {
  const next = writeFacePolicy(
    { confidenceThresholds: { presentMin: 0.5, reviewMin: 0.3, someFutureField: 1 } },
    { presentMin: 0.7, reviewMin: 0.55, ambiguityMargin: 0.08, minDetectionConfidence: 0.6 },
  );
  assert.deepEqual(next.confidenceThresholds, {
    someFutureField: 1,
    presentMin: 0.7,
    reviewMin: 0.55,
  });
  assert.deepEqual(next[FACE_POLICY_SETTINGS_KEY], {
    ambiguityMargin: 0.08,
    minDetectionConfidence: 0.6,
  });
});

test("saving a correction policy leaves everything else alone", () => {
  const next = writeAttendancePolicy(NEIGHBOURS, {
    correctionWindowDays: 14,
    requireReasonAfterFinalization: true,
  });
  assert.deepEqual(next.integrationConnections, NEIGHBOURS.integrationConnections);
  assert.deepEqual(next.biometricRetention, NEIGHBOURS.biometricRetention);
  assert.deepEqual(next[ATTENDANCE_POLICY_SETTINGS_KEY], {
    correctionWindowDays: 14,
    requireReasonAfterFinalization: true,
  });
});

test("a writer given a non-object settings value starts from an empty object", () => {
  for (const settings of [null, undefined, "x", 7, []]) {
    const next = writeAttendancePolicy(settings, DEFAULT_ATTENDANCE_POLICY);
    assert.deepEqual(Object.keys(next), [ATTENDANCE_POLICY_SETTINGS_KEY]);
  }
});

test("a round trip through write and resolve is the identity", () => {
  const policy = {
    presentMin: 0.71,
    reviewMin: 0.52,
    ambiguityMargin: 0.09,
    minDetectionConfidence: 0.61,
  };
  assert.deepEqual(resolveFacePolicy(writeFacePolicy(NEIGHBOURS, policy)), policy);
});

// ---------------------------------------------------------------------------
// 5. The correction window, at its boundary
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00.000Z");

test("a window of zero never closes", () => {
  assert.equal(
    correctionWindowOpen(
      { correctionWindowDays: 0, requireReasonAfterFinalization: false },
      new Date(NOW.getTime() - 5000 * DAY),
      NOW,
    ),
    true,
  );
});

test("a correction exactly on the deadline is still allowed", () => {
  const policy = { correctionWindowDays: 7, requireReasonAfterFinalization: false };
  assert.equal(correctionWindowOpen(policy, new Date(NOW.getTime() - 7 * DAY), NOW), true);
  assert.equal(correctionWindowOpen(policy, new Date(NOW.getTime() - 7 * DAY - 1), NOW), false);
});

test("a session with no recorded finalization time is not locked out", () => {
  // The finalization timestamp is our bookkeeping, mirrored from an audit row.
  // A gap in it is our problem and must not be charged to the person trying to
  // fix a register.
  const policy = { correctionWindowDays: 1, requireReasonAfterFinalization: false };
  assert.equal(correctionWindowOpen(policy, null, NOW), true);
  assert.equal(correctionWindowOpen(policy, new Date("nope"), NOW), true);
});
