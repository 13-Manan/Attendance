/**
 * Reading one backend's similarity scores on the product's scale.
 *
 * Institutions configure thresholds — present 0.62, review 0.45 — without
 * being told which recogniser is deployed, and they should not have to be
 * told. But recognisers do not agree on what a number means. dlib's ResNet
 * puts most pairs of *different* people above 0.8 and the same person above
 * 0.955; a model trained with a margin loss puts strangers near zero. Compare
 * a dlib score against 0.62 directly and every stranger in the room is
 * present.
 *
 * So a backend whose raw scale differs publishes a measured map on
 * `GET /v1/model-info`, and this module applies it to every score before any
 * threshold sees it. The arithmetic below is the same, in the same order, as
 * `calibrate` in services/face-ai/app/matching.py: a score that is MATCHED
 * here is MATCHED there, including at the knots, where an off-by-one-ulp
 * difference would put a student on the other side of a threshold.
 *
 * ## Fail closed
 *
 * A production backend that stores embeddings and publishes NO calibration is
 * refused rather than read raw. "No map" and "identity map" are different
 * claims, and guessing the second when the service meant the first is how a
 * classroom gets marked present. A backend whose raw scale really is the
 * product's says so by publishing the identity map.
 */

import type {
  CalibrationKnot,
  FaceModelInfo,
  ScoreCalibration,
} from "@attendance/shared-types";

/** Refusal to score at all. The run stops; nothing is marked. */
export class FaceCalibrationError extends Error {
  readonly code: "face_ai_missing_calibration" | "face_ai_invalid_calibration";

  constructor(
    code: "face_ai_missing_calibration" | "face_ai_invalid_calibration",
    message: string,
  ) {
    super(message);
    this.name = "FaceCalibrationError";
    this.code = code;
  }
}

/**
 * A raw similarity on the product's scale. `null` means the backend's raw
 * scale already is the product's.
 *
 * Linear between neighbouring knots. The knots span raw -1 to 1 and strictly
 * increase in both coordinates, so the map is monotone: it can never reorder
 * two candidates, only move which side of a threshold they fall on.
 *
 * A raw score exactly on a knot reads as exactly that knot's value, and
 * interpolation never carries a score past the knot above it. Without both, a
 * score sitting on the review knot could land a rounding error below the
 * review threshold and a student who should have been reviewed would be
 * silently absent.
 */
export function calibrateScore(
  raw: number,
  calibration: ScoreCalibration | null | undefined,
): number {
  if (!calibration) return raw;
  const knots = calibration.knots;
  const value = Math.min(Math.max(raw, knots[0].raw), knots[knots.length - 1].raw);
  for (let i = 0; i + 1 < knots.length; i++) {
    const low = knots[i];
    const high = knots[i + 1];
    if (value < high.raw) {
      const t = (value - low.raw) / (high.raw - low.raw);
      return Math.min(
        low.calibrated + t * (high.calibrated - low.calibrated),
        high.calibrated,
      );
    }
    if (value === high.raw) return high.calibrated;
  }
  return knots[knots.length - 1].calibrated;
}

/**
 * The calibration to apply to this backend's scores, or null when its raw
 * scale is already the product's.
 *
 * Throws rather than defaulting when a production embedding backend publishes
 * none: see the fail-closed note above. A backend that is not production
 * eligible (the mock, an unlicensed local model) is a development tool whose
 * scores decide nothing, and a gallery backend's confidences are the
 * provider's own scale with its own thresholds — neither is calibrated here.
 */
export function resolveCalibration(info: FaceModelInfo): ScoreCalibration | null {
  const raw = info.calibration;
  if (raw === null || raw === undefined) {
    const storesVectors = (info.templateKind ?? "embedding") === "embedding";
    if (info.productionEligible && storesVectors) {
      throw new FaceCalibrationError(
        "face_ai_missing_calibration",
        `The face service reports a production model (${info.modelName} ` +
          `${info.modelVersion}) but publishes no score calibration. Its ` +
          `similarity scores cannot be compared against the configured ` +
          `thresholds, so recognition will not run.`,
      );
    }
    return null;
  }
  return validateCalibration(raw, `${info.modelName} ${info.modelVersion}`);
}

/**
 * The same checks the service applies when it constructs one, repeated here
 * because this side is what acts on the numbers. A map that is not monotone
 * would reorder candidates; one that does not span the scale would leave
 * scores outside it undefined.
 */
export function validateCalibration(
  calibration: ScoreCalibration,
  source: string,
): ScoreCalibration {
  const refuse = (why: string): never => {
    throw new FaceCalibrationError(
      "face_ai_invalid_calibration",
      `The score calibration published by ${source} is unusable: ${why}.`,
    );
  };

  const knots: CalibrationKnot[] = calibration.knots;
  if (!Array.isArray(knots) || knots.length < 2) {
    refuse("it has fewer than two knots");
  }
  if (!knots.every((k) => Number.isFinite(k.raw) && Number.isFinite(k.calibrated))) {
    refuse("a knot is not a finite pair of numbers");
  }
  if (knots[0].raw !== -1 || knots[knots.length - 1].raw !== 1) {
    refuse("the knots do not span raw -1 to 1");
  }
  for (let i = 0; i + 1 < knots.length; i++) {
    if (
      !(knots[i + 1].raw > knots[i].raw) ||
      !(knots[i + 1].calibrated > knots[i].calibrated)
    ) {
      refuse("the knots do not strictly increase, so the map could reorder candidates");
    }
  }
  if (!knots.every((k) => k.calibrated >= -1 && k.calibrated <= 1)) {
    refuse("a calibrated value lies outside [-1, 1]");
  }
  if (
    !Number.isFinite(calibration.rawAmbiguityMargin) ||
    calibration.rawAmbiguityMargin < 0
  ) {
    refuse("the raw ambiguity margin is negative or not a number");
  }
  return calibration;
}
