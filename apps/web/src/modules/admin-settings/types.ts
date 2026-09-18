/**
 * The knobs an institution administrator may turn without a code change.
 *
 * ## The rule this module is built around
 *
 * A settings screen that shows a control which changes nothing is worse than
 * no settings screen: it tells an administrator they have configured something
 * when they have not. So every value defined here is *read by something*, and
 * the UI says which engine reads it. Where a control could not be wired
 * without changing shipped behaviour, it is not offered as a control — it is
 * stated as a fixed rule with the reason (see `FIXED_ATTENDANCE_RULES`).
 *
 * ## Why the defaults are the current behaviour, exactly
 *
 * Every default in this file reproduces what the code did before the file
 * existed. `correctionWindowDays: 0` means "no window", which is what
 * `applyReviewDecision` enforced when there was no setting to read;
 * `ambiguityMargin: 0.05` is `DEFAULT_AMBIGUITY_MARGIN` from the recognition
 * engine, unchanged. An institution that never opens the settings page gets
 * byte-identical behaviour to the build before this one. That is not a
 * coincidence — it is the property that let these values be wired into live
 * engines at all.
 *
 * ## Where they are stored
 *
 * `Institution.settings`, a Json column, under named keys. No schema change.
 * Two of the values — `attendanceMode` and `lowAttendanceThreshold` — already
 * lived at the top level of that column with their own resolvers in
 * `modules/institutions/service.ts`, and they stay exactly where they are.
 * Moving them under a new key would have been tidier and would have silently
 * reset every institution that had configured one.
 */

/** `Institution.settings` key for the attendance-correction policy. */
export const ATTENDANCE_POLICY_SETTINGS_KEY = "attendancePolicy";

/** `Institution.settings` key for the two engine-level recognition margins. */
export const FACE_POLICY_SETTINGS_KEY = "faceRecognitionPolicy";

/**
 * Upper bound on a correction window, in days.
 *
 * A guard against a typo rather than an opinion: an administrator who means 30
 * and types 3000 has written "effectively forever", and `0` already expresses
 * forever explicitly and visibly.
 */
export const MAX_CORRECTION_WINDOW_DAYS = 365;

export interface AttendancePolicySettings {
  /**
   * How many days after a register is finalized an administrator may still
   * correct it. `0` — the default, and the behaviour of every build before
   * this setting existed — means no time limit.
   *
   * Read by `modules/attendance-review/service.ts#applyReviewDecision`, and
   * only on the post-finalization branch: a register still in REVIEW is being
   * worked on, and putting a clock on that would let the deadline, rather than
   * the reviewer, decide what a NEEDS_REVIEW row becomes.
   */
  correctionWindowDays: number;

  /**
   * Whether changing a *finalized* register requires the corrector to type a
   * reason. Default `false`, which is what the code did before.
   *
   * Scoped to post-finalization on purpose. During review a teacher is
   * expected to disagree with the model dozens of times per session, and
   * demanding a sentence for each one produces thirty rows that say "wrong"
   * — which is not an audit trail, it is a tax. Changing a closed register is
   * the rare event where the reason is the whole point.
   */
  requireReasonAfterFinalization: boolean;
}

export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicySettings = {
  correctionWindowDays: 0,
  requireReasonAfterFinalization: false,
};

/**
 * The recognition decision policy, as configuration.
 *
 * All four values were already policy rather than constants in spirit —
 * `RecognitionPolicy` in `modules/recognition-engine/types.ts` says so in its
 * own doc comment ("nothing is hardcoded so real-world benchmarking can adjust
 * them without redeploying code"). Two of them (`presentMin`, `reviewMin`)
 * already resolved from settings. The other two resolved from constants with
 * an override hook that no caller used. This type is the fourth value of that
 * sentence finally being true.
 */
export interface FaceRecognitionPolicySettings {
  /** At or above this cosine similarity, a face is a confident match. */
  presentMin: number;
  /** Between `reviewMin` and `presentMin`, a face goes to a human. */
  reviewMin: number;
  /** Best-minus-second-best below this margin downgrades to UNCERTAIN. */
  ambiguityMargin: number;
  /** A detected face below this detector confidence is discarded entirely. */
  minDetectionConfidence: number;
}

/**
 * Per-field bounds for the recognition policy.
 *
 * These are refusal bounds, not recommendations. The brief is explicit that an
 * administrator must not be able to casually move a dangerous model parameter,
 * and the dangerous direction here is *down*: a `presentMin` of 0.1 marks a
 * classroom present from a blurred photograph of the back wall. The floors
 * below are the point past which the system would be asserting confidence it
 * cannot have, so the form refuses rather than warns.
 *
 * Recommendations — the softer "this is lower than the shipped default and
 * here is what the benchmark measured at it" — are warnings, computed
 * separately in `policy.ts` and shown before and after saving.
 */
export interface NumericBound {
  min: number;
  max: number;
  /** Smallest change the form accepts; also the rounding granularity. */
  step: number;
}

export const FACE_POLICY_BOUNDS: Record<keyof FaceRecognitionPolicySettings, NumericBound> = {
  // 0.30 is not a usable operating point for any model; it is the floor below
  // which the value stops describing a similarity decision at all.
  presentMin: { min: 0.3, max: 0.99, step: 0.01 },
  reviewMin: { min: 0.1, max: 0.95, step: 0.01 },
  // 0 is permitted: it means "never downgrade for ambiguity", which is a
  // legitimate choice for an institution with no look-alikes and a warning
  // rather than an error.
  ambiguityMargin: { min: 0, max: 0.5, step: 0.01 },
  minDetectionConfidence: { min: 0.1, max: 0.99, step: 0.01 },
};

/**
 * The shipped defaults, reproduced here so the settings module has one place
 * that states them and the UI can show "you have changed this from the
 * default" without importing the engine.
 *
 * They must stay equal to `DEFAULT_CONFIDENCE_THRESHOLDS` in
 * `modules/institutions/service.ts` and `DEFAULT_AMBIGUITY_MARGIN` /
 * `DEFAULT_MIN_DETECTION_CONFIDENCE` in `modules/recognition-engine/types.ts`.
 * `policy.test.ts` asserts that equality, so the duplication cannot drift.
 */
export const DEFAULT_FACE_POLICY: FaceRecognitionPolicySettings = {
  presentMin: 0.62,
  reviewMin: 0.45,
  ambiguityMargin: 0.05,
  minDetectionConfidence: 0.5,
};

/**
 * Rules an administrator cannot switch off, and the reason each one exists.
 *
 * Rendered on the settings page as plain statements, not as disabled controls
 * — a greyed-out checkbox invites someone to go looking for the permission
 * that enables it, and there isn't one. These are product invariants; a
 * deployment that needs them changed needs a different product.
 */
export const FIXED_ATTENDANCE_RULES: ReadonlyArray<{ rule: string; why: string }> = [
  {
    rule: "A register with an unresolved Needs Review row cannot be finalized.",
    why:
      "Finalizing past uncertainty is how a maybe becomes a Present that nobody chose. " +
      "The check lives in modules/sessions/service.ts so every finalization path — this " +
      "UI, the API, a future scheduler — is blocked by the same one.",
  },
  {
    rule: "Recognition output is advisory. Only a person can set a final result.",
    why:
      "aiResult and aiConfidence are written once and never overwritten by a correction, " +
      "so the record always shows both what the model said and what the human decided.",
  },
  {
    rule: "Every change to a final result writes an append-only correction row.",
    why:
      "Previous result, new result, who, when, why. Without it, a corrected register and " +
      "a register that was always right are indistinguishable six months later.",
  },
  {
    rule: "Students cannot alter attendance, and no setting grants them that.",
    why: "The student portal's data module is read-only by construction, not by permission.",
  },
];

export class AdminSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminSettingsError";
  }
}
