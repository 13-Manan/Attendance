import assert from "node:assert/strict";
import test from "node:test";

import type { FaceModelInfo, ScoreCalibration } from "@attendance/shared-types";

import {
  FaceCalibrationError,
  calibrateScore,
  resolveCalibration,
  validateCalibration,
} from "./calibration";

/**
 * The map the dlib backend publishes (services/face-ai
 * app/models/azure_dlib_provider.py). Repeated here as data rather than
 * imported, because the point of several tests below is that this side agrees
 * with a service it does not share code with.
 */
const DLIB: ScoreCalibration = {
  id: "dlib-resnet-v1.azure-d03.2026-09-24",
  knots: [
    { raw: -1, calibrated: -1 },
    { raw: 0.93, calibrated: 0.45 },
    { raw: 0.955, calibrated: 0.62 },
    { raw: 1, calibrated: 1 },
  ],
  rawAmbiguityMargin: 0.01,
};

/**
 * Computed by services/face-ai `app/matching.py::calibrate` with the same
 * knots. Bit-for-bit: a student on the review knot must be reviewable in both
 * places, and the two implementations only stay that way if something checks.
 */
const FROM_PYTHON: Array<[number, number]> = [
  [-1.0, -1.0],
  [-0.5, -0.6243523316062176],
  [0.0, -0.24870466321243534],
  [0.5, 0.12694300518134716],
  [0.8, 0.3523316062176165],
  [0.9, 0.4274611398963728],
  [0.92, 0.442487046632124],
  [0.93, 0.45],
  [0.9301, 0.4506799999999999],
  [0.94, 0.5179999999999996],
  [0.9499, 0.58532],
  [0.95, 0.5859999999999999],
  [0.9549, 0.6193200000000001],
  [0.955, 0.62],
  [0.9551, 0.6208444444444443],
  [0.96, 0.6622222222222223],
  [0.97, 0.7466666666666666],
  [0.98, 0.8311111111111111],
  [0.99, 0.9155555555555556],
  [0.999, 0.9915555555555555],
  [1.0, 1.0],
  [1.5, 1.0],
  [-2.0, -1.0],
];

// ---------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------

test("apps/web and face-ai calibrate to the same floating-point number", () => {
  for (const [raw, expected] of FROM_PYTHON) {
    assert.equal(
      calibrateScore(raw, DLIB),
      expected,
      `raw ${raw} differs from the Python implementation`,
    );
  }
});

test("a score exactly on a knot reads as exactly that knot", () => {
  // The review and present thresholds sit on knots. A rounding error here
  // puts a student on the wrong side of a decision that was measured.
  assert.equal(calibrateScore(0.93, DLIB), 0.45);
  assert.equal(calibrateScore(0.955, DLIB), 0.62);
  assert.equal(calibrateScore(-1, DLIB), -1);
  assert.equal(calibrateScore(1, DLIB), 1);
});

test("interpolation never carries a score past the knot above it", () => {
  // Checked densely just below each knot, because that is where a float error
  // would show and where it would matter.
  for (let i = 1; i <= 2000; i++) {
    const raw = 0.955 - i * 1e-7;
    assert.ok(calibrateScore(raw, DLIB) <= 0.62, `raw ${raw} escaped its knot`);
  }
});

test("the map is monotone, so calibration can never reorder two candidates", () => {
  let previous = -Infinity;
  for (let i = -1000; i <= 1000; i++) {
    const value = calibrateScore(i / 1000, DLIB);
    assert.ok(value > previous, `raw ${i / 1000} did not increase`);
    previous = value;
  }
});

test("scores outside the scale are clamped rather than extrapolated", () => {
  assert.equal(calibrateScore(5, DLIB), 1);
  assert.equal(calibrateScore(-5, DLIB), -1);
});

test("no calibration means the raw scale is already the product's", () => {
  assert.equal(calibrateScore(0.94, null), 0.94);
  assert.equal(calibrateScore(0.94, undefined), 0.94);
});

test("a raw dlib score that looks confident is not confident once calibrated", () => {
  // The whole reason this module exists: 0.94 is two different people for
  // this recogniser, and 0.94 read raw clears the 0.62 present threshold.
  assert.ok(0.94 > 0.62);
  assert.ok(calibrateScore(0.94, DLIB) < 0.62);
  assert.ok(calibrateScore(0.94, DLIB) > 0.45); // still worth a human look
});

// ---------------------------------------------------------------------------
// Refusing a map that cannot be trusted
// ---------------------------------------------------------------------------

function info(overrides: Partial<FaceModelInfo> = {}): FaceModelInfo {
  return {
    modelName: "dlib-resnet-v1",
    modelVersion: "dlib-models-2a61575+pp1+al1.detection_03",
    weightsVersion: "dlib-models-2a61575",
    preprocessingVersion: "1",
    embeddingDim: 128,
    embeddingNormalized: true,
    runtime: "dlib+azure-face-detect",
    commercialUse: "permitted",
    productionEligible: true,
    contractVersion: "v1",
    templateKind: "embedding",
    calibration: DLIB,
    ...overrides,
  };
}

test("a production embedding backend that publishes no calibration is refused", () => {
  // Not read raw. "No map" and "identity map" are different claims, and
  // guessing the second is how a classroom of strangers gets marked present.
  assert.throws(
    () => resolveCalibration(info({ calibration: null })),
    (error: unknown) =>
      error instanceof FaceCalibrationError &&
      error.code === "face_ai_missing_calibration",
  );
  assert.throws(() => resolveCalibration(info({ calibration: undefined })), FaceCalibrationError);
});

test("a development backend without a calibration is read raw, as before", () => {
  // The mock and the unlicensed local models decide nothing, and requiring a
  // calibration from them would break every development environment.
  assert.equal(resolveCalibration(info({ productionEligible: false, calibration: null })), null);
});

test("a gallery backend is not calibrated: its confidences are not cosines", () => {
  assert.equal(
    resolveCalibration(info({ templateKind: "gallery", calibration: null })),
    null,
  );
});

test("a valid calibration is returned unchanged", () => {
  assert.equal(resolveCalibration(info()), DLIB);
});

const BAD: Array<[string, ScoreCalibration, RegExp]> = [
  [
    "one knot",
    { id: "x", knots: [{ raw: -1, calibrated: -1 }], rawAmbiguityMargin: 0 },
    /fewer than two knots/,
  ],
  [
    "not spanning the scale",
    {
      id: "x",
      knots: [
        { raw: 0, calibrated: 0 },
        { raw: 1, calibrated: 1 },
      ],
      rawAmbiguityMargin: 0,
    },
    /span raw -1 to 1/,
  ],
  [
    "a decreasing step, which would reorder candidates",
    {
      id: "x",
      knots: [
        { raw: -1, calibrated: -1 },
        { raw: 0.9, calibrated: 0.8 },
        { raw: 0.95, calibrated: 0.4 },
        { raw: 1, calibrated: 1 },
      ],
      rawAmbiguityMargin: 0,
    },
    /strictly increase/,
  ],
  [
    "a calibrated value off the scale",
    {
      id: "x",
      knots: [
        { raw: -1, calibrated: -1 },
        { raw: 0.9, calibrated: 4 },
        { raw: 1, calibrated: 5 },
      ],
      rawAmbiguityMargin: 0,
    },
    /outside \[-1, 1\]/,
  ],
  [
    "a non-finite knot",
    {
      id: "x",
      knots: [
        { raw: -1, calibrated: -1 },
        { raw: Number.NaN, calibrated: 0.5 },
        { raw: 1, calibrated: 1 },
      ],
      rawAmbiguityMargin: 0,
    },
    /finite pair/,
  ],
  [
    "a negative raw ambiguity margin",
    {
      id: "x",
      knots: [
        { raw: -1, calibrated: -1 },
        { raw: 1, calibrated: 1 },
      ],
      rawAmbiguityMargin: -0.1,
    },
    /ambiguity margin/,
  ],
];

for (const [name, calibration, message] of BAD) {
  test(`a calibration with ${name} is refused, not repaired`, () => {
    assert.throws(
      () => validateCalibration(calibration, "test-backend"),
      (error: unknown) =>
        error instanceof FaceCalibrationError &&
        error.code === "face_ai_invalid_calibration" &&
        message.test(error.message),
    );
    assert.throws(() => resolveCalibration(info({ calibration })), FaceCalibrationError);
  });
}

test("the refusal names the backend so an operator knows which service to look at", () => {
  try {
    resolveCalibration(info({ calibration: null }));
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof FaceCalibrationError);
    assert.match(error.message, /dlib-resnet-v1/);
  }
});
