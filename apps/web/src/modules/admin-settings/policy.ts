import {
  ATTENDANCE_POLICY_SETTINGS_KEY,
  AdminSettingsError,
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_FACE_POLICY,
  FACE_POLICY_BOUNDS,
  FACE_POLICY_SETTINGS_KEY,
  MAX_CORRECTION_WINDOW_DAYS,
  type AttendancePolicySettings,
  type FaceRecognitionPolicySettings,
} from "./types";

/**
 * Reading, validating and writing administrator-configurable settings — all
 * pure. No Prisma, no clock, no session.
 *
 * ## The two paths, and why they disagree on purpose
 *
 * **Read clamps. Write rejects.** A stored value that has somehow become
 * invalid must still produce a usable policy, because the read path runs
 * inside the recognition engine during a capture: throwing there would take
 * down a classroom's attendance because of a bad settings blob. The write path
 * runs while an administrator is looking at a form, which is the one moment
 * somebody can be told what is wrong and fix it — so it refuses, in a sentence,
 * rather than silently storing something other than what was typed.
 *
 * This is the same split `modules/privacy/policy.ts` uses for retention, and
 * for the same reason. The difference here is the direction of danger: a
 * clamped retention period could delete data, so that module clamps toward
 * "keep"; a clamped recognition threshold could mark an absent student
 * present, so this module clamps toward the shipped default rather than toward
 * either extreme.
 *
 * ## Preserving what we do not own
 *
 * `Institution.settings` is one shared Json column. `academicUnitLabels`,
 * `attendanceMode`, `confidenceThresholds`, `lowAttendanceThreshold`, the
 * biometric retention policy and the entire Integration Center connection list
 * all live in it. Postgres offers no partial update here, so every writer in
 * this file starts from a shallow copy of the existing object and touches only
 * its own keys. `policy.test.ts` asserts that property directly, because
 * "remember to spread the old settings" is a habit and habits are how an
 * integration connection list gets deleted by a threshold change.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readBucket(settings: unknown, key: string): Record<string, unknown> | null {
  const root = asObject(settings);
  if (!root) return null;
  return asObject(root[key]);
}

/**
 * `Number.isFinite` rather than `typeof === "number"`: NaN and Infinity are
 * both numbers, and either one reaching a similarity comparison turns every
 * face into a non-match or every face into a match.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Rounds to the granularity of a bound, so 0.6200000000000001 never stores. */
function quantize(value: number, step: number): number {
  const places = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(value.toFixed(places));
}

function mergeInto(
  settings: unknown,
  key: string,
  bucket: Record<string, unknown>,
): Record<string, unknown> {
  const base = asObject(settings);
  const next: Record<string, unknown> = base ? { ...base } : {};
  next[key] = bucket;
  return next;
}

// ---------------------------------------------------------------------------
// Attendance correction policy
// ---------------------------------------------------------------------------

function clampWindowDays(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) return DEFAULT_ATTENDANCE_POLICY.correctionWindowDays;
  const whole = Math.floor(parsed);
  // A negative or nonsensical window reads as "no window" rather than as
  // "zero days, so nothing may ever be corrected". Refusing every correction
  // because of a bad settings value would strand a register that a teacher
  // needs to fix, and the permission check is the real control either way.
  if (whole <= 0) return 0;
  return Math.min(whole, MAX_CORRECTION_WINDOW_DAYS);
}

/**
 * The correction policy in force, from a raw `settings` Json value.
 *
 * Total: any input at all — null, a string, an array, an object of garbage —
 * yields `DEFAULT_ATTENDANCE_POLICY`, which is the behaviour of the build
 * before this setting existed.
 */
export function resolveAttendancePolicy(settings: unknown): AttendancePolicySettings {
  const bucket = readBucket(settings, ATTENDANCE_POLICY_SETTINGS_KEY);
  if (!bucket) return { ...DEFAULT_ATTENDANCE_POLICY };
  return {
    correctionWindowDays: clampWindowDays(bucket.correctionWindowDays),
    requireReasonAfterFinalization: bucket.requireReasonAfterFinalization === true,
  };
}

export interface AttendancePolicyInput {
  correctionWindowDays: number;
  requireReasonAfterFinalization: boolean;
}

export function validateAttendancePolicy(input: AttendancePolicyInput): AttendancePolicySettings {
  const days = finiteNumber(input.correctionWindowDays);
  if (days === null || !Number.isInteger(days)) {
    throw new AdminSettingsError("The correction window must be a whole number of days.");
  }
  if (days < 0) {
    throw new AdminSettingsError(
      "The correction window cannot be negative. Use 0 for no time limit.",
    );
  }
  if (days > MAX_CORRECTION_WINDOW_DAYS) {
    throw new AdminSettingsError(
      `The correction window cannot exceed ${MAX_CORRECTION_WINDOW_DAYS} days. Use 0 for no time limit.`,
    );
  }
  return {
    correctionWindowDays: days,
    requireReasonAfterFinalization: input.requireReasonAfterFinalization === true,
  };
}

export function writeAttendancePolicy(
  settings: unknown,
  policy: AttendancePolicySettings,
): Record<string, unknown> {
  return mergeInto(settings, ATTENDANCE_POLICY_SETTINGS_KEY, { ...policy });
}

/**
 * Is this correction inside the institution's window?
 *
 * Takes `finalizedAt` and `now` as arguments so the boundary — a correction
 * exactly on the deadline — is testable without a clock. A session with no
 * recorded finalization time is allowed: the timestamp is mirrored into
 * session metadata by the review flow and the authoritative copy is an audit
 * row, so a missing mirror is a gap in our bookkeeping and must not be charged
 * to the person trying to fix a register.
 */
export function correctionWindowOpen(
  policy: AttendancePolicySettings,
  finalizedAt: Date | null,
  now: Date,
): boolean {
  if (policy.correctionWindowDays <= 0) return true;
  if (!finalizedAt || Number.isNaN(finalizedAt.getTime())) return true;
  const elapsedMs = now.getTime() - finalizedAt.getTime();
  return elapsedMs <= policy.correctionWindowDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Face recognition policy
// ---------------------------------------------------------------------------

function clampBounded(value: unknown, key: keyof FaceRecognitionPolicySettings): number {
  const bound = FACE_POLICY_BOUNDS[key];
  const parsed = finiteNumber(value);
  // Out of range reads as the shipped default, not as the nearest bound. A
  // stored `presentMin` of 5 is not "somebody meant 0.99"; it is a value
  // nobody can interpret, and the safe reading of an uninterpretable
  // recognition threshold is the one that has been measured.
  if (parsed === null || parsed < bound.min || parsed > bound.max) {
    return DEFAULT_FACE_POLICY[key];
  }
  return quantize(parsed, bound.step);
}

/**
 * The recognition policy in force.
 *
 * Reads `presentMin` / `reviewMin` from the pre-existing top-level
 * `confidenceThresholds` key — the one `resolveConfidenceThresholds` has
 * always used — and the two margins from this module's own key. Deliberately
 * not consolidated into one bucket: every institution that has already
 * configured a threshold has it under the old key, and a tidier layout that
 * silently reverted those to 0.62 would be a recognition change dressed as a
 * refactor.
 *
 * The final guard is ordering. `reviewMin >= presentMin` collapses the review
 * band to nothing, which means every face is either a confident Present or a
 * silent Absent and the human review step ceases to exist. If a stored pair
 * says that, both fall back to the defaults together rather than one being
 * nudged — a half-corrected pair is a threshold nobody chose.
 */
export function resolveFacePolicy(settings: unknown): FaceRecognitionPolicySettings {
  const root = asObject(settings);
  const thresholds = root ? asObject(root.confidenceThresholds) : null;
  const margins = readBucket(settings, FACE_POLICY_SETTINGS_KEY);

  let presentMin = clampBounded(thresholds?.presentMin, "presentMin");
  let reviewMin = clampBounded(thresholds?.reviewMin, "reviewMin");
  if (reviewMin >= presentMin) {
    presentMin = DEFAULT_FACE_POLICY.presentMin;
    reviewMin = DEFAULT_FACE_POLICY.reviewMin;
  }

  return {
    presentMin,
    reviewMin,
    ambiguityMargin: clampBounded(margins?.ambiguityMargin, "ambiguityMargin"),
    minDetectionConfidence: clampBounded(
      margins?.minDetectionConfidence,
      "minDetectionConfidence",
    ),
  };
}

export interface FacePolicyInput {
  presentMin: number;
  reviewMin: number;
  ambiguityMargin: number;
  minDetectionConfidence: number;
}

const FIELD_LABELS: Record<keyof FaceRecognitionPolicySettings, string> = {
  presentMin: "Present threshold",
  reviewMin: "Review threshold",
  ambiguityMargin: "Ambiguity margin",
  minDetectionConfidence: "Minimum detection confidence",
};

function requireBounded(value: number, key: keyof FaceRecognitionPolicySettings): number {
  const bound = FACE_POLICY_BOUNDS[key];
  const parsed = finiteNumber(value);
  if (parsed === null) {
    throw new AdminSettingsError(`${FIELD_LABELS[key]} must be a number.`);
  }
  if (parsed < bound.min || parsed > bound.max) {
    throw new AdminSettingsError(
      `${FIELD_LABELS[key]} must be between ${bound.min} and ${bound.max}. ` +
        `You entered ${parsed}.`,
    );
  }
  return quantize(parsed, bound.step);
}

/**
 * Validates a submitted recognition policy, or explains the refusal.
 *
 * The cross-field rule is the important one and it is checked last, after both
 * values are known to be individually in range: `reviewMin` must be strictly
 * below `presentMin`. Equal or inverted thresholds delete the review band, and
 * a system with no review band cannot route uncertainty to a human — which is
 * the one thing this product promises it does.
 */
export function validateFacePolicy(input: FacePolicyInput): FaceRecognitionPolicySettings {
  const presentMin = requireBounded(input.presentMin, "presentMin");
  const reviewMin = requireBounded(input.reviewMin, "reviewMin");
  const ambiguityMargin = requireBounded(input.ambiguityMargin, "ambiguityMargin");
  const minDetectionConfidence = requireBounded(
    input.minDetectionConfidence,
    "minDetectionConfidence",
  );

  if (reviewMin >= presentMin) {
    throw new AdminSettingsError(
      `The review threshold (${reviewMin}) must be below the present threshold (${presentMin}). ` +
        "If they meet, there is no uncertain band left: every face becomes either a confident " +
        "Present or a silent Absent, and nothing is ever sent to a person to check.",
    );
  }

  return { presentMin, reviewMin, ambiguityMargin, minDetectionConfidence };
}

export function writeFacePolicy(
  settings: unknown,
  policy: FaceRecognitionPolicySettings,
): Record<string, unknown> {
  const base = asObject(settings);
  const next: Record<string, unknown> = base ? { ...base } : {};

  // presentMin/reviewMin go back to the key they have always lived under, and
  // any other field somebody stored beside them survives.
  const existingThresholds = asObject(next.confidenceThresholds);
  next.confidenceThresholds = {
    ...(existingThresholds ?? {}),
    presentMin: policy.presentMin,
    reviewMin: policy.reviewMin,
  };
  next[FACE_POLICY_SETTINGS_KEY] = {
    ambiguityMargin: policy.ambiguityMargin,
    minDetectionConfidence: policy.minDetectionConfidence,
  };
  return next;
}

/**
 * Non-blocking warnings about a recognition policy.
 *
 * Separate from validation because these are not errors — an institution may
 * have good reasons for any of them, and a system that refuses every setting
 * it dislikes is one an administrator routes around. What it must not do is
 * let the change happen *silently*. Each warning names the consequence in the
 * currency the administrator cares about: students wrongly marked present,
 * students wrongly marked absent, or hours of review work.
 *
 * The figures quoted are from `docs/BENCHMARKS.md` §6, which measured the
 * shipped 0.62 producing 2 false accepts (FAR 0.275%) and 0.70 producing none
 * — against *synthetic* embedding geometry, not real faces. The warnings say
 * so, because a number whose provenance is not stated gets quoted as if it
 * were measured on people.
 */
export function describeFacePolicyWarnings(policy: FaceRecognitionPolicySettings): string[] {
  const warnings: string[] = [];

  if (policy.presentMin < DEFAULT_FACE_POLICY.presentMin) {
    warnings.push(
      `A present threshold of ${policy.presentMin} is below the shipped default of ` +
        `${DEFAULT_FACE_POLICY.presentMin}. Lowering it marks more students present without a ` +
        "human check, which means more students marked present who were not there. The " +
        "synthetic benchmark in docs/BENCHMARKS.md saw false accepts persist until 0.70.",
    );
  }
  if (policy.presentMin > 0.85) {
    warnings.push(
      `A present threshold of ${policy.presentMin} is very strict. Almost every face will be ` +
        "sent to review, so expect a teacher to resolve most of the class by hand after each " +
        "capture.",
    );
  }
  if (policy.reviewMin < 0.3) {
    warnings.push(
      `A review threshold of ${policy.reviewMin} sends very weak matches to a person instead of ` +
        "discarding them. That is safe for students, but it makes the review queue long.",
    );
  }
  if (policy.presentMin - policy.reviewMin < 0.1) {
    warnings.push(
      "The gap between the two thresholds is narrow, so the uncertain band is thin: a face just " +
        "below the present threshold becomes an Absent rather than a question. Widen it if " +
        "students report being marked absent while in class.",
    );
  }
  if (policy.ambiguityMargin === 0) {
    warnings.push(
      "With an ambiguity margin of 0, a face that matches two students almost equally well is " +
        "assigned to whichever scored marginally higher instead of being sent to review. This is " +
        "the setting that decides what happens to siblings and look-alikes.",
    );
  }
  if (policy.minDetectionConfidence < 0.3) {
    warnings.push(
      `A minimum detection confidence of ${policy.minDetectionConfidence} lets the detector treat ` +
        "low-quality regions — a poster, a reflection, a face in a corridor — as faces to match.",
    );
  }
  if (policy.minDetectionConfidence > 0.8) {
    warnings.push(
      `A minimum detection confidence of ${policy.minDetectionConfidence} discards most faces in ` +
        "the back rows. Those students are not marked absent by this setting — they simply stop " +
        "being seen, which reaches the register as an Absent anyway.",
    );
  }

  return warnings;
}

/** Which fields differ from the shipped defaults, for the "changed" markers. */
export function facePolicyChangedFields(
  policy: FaceRecognitionPolicySettings,
): Array<keyof FaceRecognitionPolicySettings> {
  return (Object.keys(DEFAULT_FACE_POLICY) as Array<keyof FaceRecognitionPolicySettings>).filter(
    (key) => policy[key] !== DEFAULT_FACE_POLICY[key],
  );
}
