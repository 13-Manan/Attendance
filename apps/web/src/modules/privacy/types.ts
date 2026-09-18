/**
 * Face-data retention policy — the configurable answer to "how long may we
 * keep this, and what happens when we may not?".
 *
 * ## Why it is configuration and not a constant
 *
 * The right retention period for a biometric template is not a fact about
 * this software. It is a fact about an institution's jurisdiction, its own
 * privacy notice, and the consent it collected — a school under a data
 * protection authority that requires erasure within thirty days of a pupil
 * leaving, and a university that must retain examination-attendance evidence
 * for a full academic year, are both right. A number compiled into the
 * application is a number one of them has to violate.
 *
 * So the policy lives in `Institution.settings` (a Json column — no schema
 * change), it is resolved in exactly one place, and the defaults are the
 * conservative end of the range rather than the convenient end.
 *
 * ## The defaults, and why they are what they are
 *
 * - Classroom images are **not stored at all**. This is what the code already
 *   did — `modules/attendance-capture` forwards the bytes to face-ai and
 *   discards them, and no code path has ever written a `SessionImage` row.
 *   Making it the default of an explicit policy turns an implementation
 *   detail into a promise: storage is now something an institution has to
 *   switch on deliberately, name a period for, and see in an audit log.
 *   "Do not automatically retain classroom photos forever" is enforced by
 *   there being no setting that means forever.
 * - Templates survive as long as the student is `ACTIVE`, and are
 *   **deactivated** when the student is not. Deactivation, not deletion, is
 *   the default because a student marked inactive in error is common and a
 *   deleted biometric template cannot be restored — only re-collected from
 *   the person, which is the cost this default avoids imposing on them.
 * - A deactivated template is then **hard-deleted after 30 days**. This is
 *   the part that makes deactivation a retention policy rather than a
 *   euphemism: without it, "soft delete" means keeping biometric data
 *   indefinitely in a row nobody looks at.
 *
 * Every field has a documented meaning for `0`, and in every case `0` means
 * "no time limit" rather than "immediately" — the opposite convention would
 * make a missing or zeroed value destroy data.
 */

/** What happens to a student's templates when they stop being ACTIVE. */
export type InactiveStudentAction = "DEACTIVATE" | "DELETE";

/** Whether classroom photographs may be persisted at all. */
export type ClassroomImageStorage = "NEVER" | "RETAIN_FOR_DAYS";

export interface BiometricRetentionPolicy {
  /**
   * Days a face template may live after it was enrolled, counted from
   * `FaceEmbedding.createdAt`. `0` means no age limit — the template lives as
   * long as the student is active, which is the common case for a school that
   * re-enrolls faces only when recognition degrades.
   *
   * Set it to force periodic re-collection: a template that expires is
   * deactivated and then deleted on the ordinary grace schedule, and the
   * student is asked to enroll again.
   */
  faceTemplateRetentionDays: number;

  /**
   * Applied when `Student.status` is anything other than `ACTIVE` —
   * INACTIVE, TRANSFERRED or COMPLETED. `DEACTIVATE` (the default) makes the
   * templates invisible to recognition and starts the grace clock;
   * `DELETE` removes them on the next sweep with no grace period, for an
   * institution whose policy is erasure on departure.
   */
  onStudentInactive: InactiveStudentAction;

  /**
   * Days a deactivated template is kept before it is hard-deleted, counted
   * from `FaceEmbedding.createdAt` — the schema has no `deactivatedAt`
   * column and this phase does not change the schema, so the clock starts at
   * enrollment rather than at deactivation. That is the *conservative*
   * direction of error: a template deactivated long after enrollment is
   * deleted sooner than a `deactivatedAt` column would have deleted it,
   * never later. Recorded here so the next person reads a decision rather
   * than finding a bug.
   *
   * `0` means deactivated templates are never automatically deleted; they
   * still can be, explicitly, through the deletion workflow.
   */
  deactivatedTemplateGraceDays: number;

  /**
   * `NEVER` — the default, and what the code does today — means classroom
   * photographs are held in memory for the length of one recognition call
   * and never written anywhere. Any `SessionImage` row found under this
   * setting is deleted by the sweep, because under this policy it should not
   * exist.
   *
   * `RETAIN_FOR_DAYS` is for an institution whose own policy explicitly
   * requires keeping the evidence — an examination board, a disciplinary
   * process. It is meaningless without `classroomImageRetentionDays`.
   */
  classroomImageStorage: ClassroomImageStorage;

  /**
   * Days a stored classroom image is kept. Only consulted when
   * `classroomImageStorage` is `RETAIN_FOR_DAYS`, and required to be at least
   * 1 in that case — there is deliberately no way to express "keep classroom
   * photographs forever", because a photograph of thirty children with no end
   * date is not a retention policy.
   */
  classroomImageRetentionDays: number;
}

/**
 * The shipped defaults. Applied to any institution that has never configured
 * a policy, which is all of them until an administrator opens the settings
 * page — so these are the real-world behaviour, not a placeholder.
 */
export const DEFAULT_RETENTION_POLICY: BiometricRetentionPolicy = {
  faceTemplateRetentionDays: 0,
  onStudentInactive: "DEACTIVATE",
  deactivatedTemplateGraceDays: 30,
  classroomImageStorage: "NEVER",
  classroomImageRetentionDays: 0,
};

/**
 * Upper bound on any configured number of days, ~10 years.
 *
 * Not an opinion about the right period — it is a guard against a typo. An
 * administrator who means 30 and types 3000000 has expressed "forever" by
 * accident, and the one setting this policy must never be able to express by
 * accident is forever.
 */
export const MAX_RETENTION_DAYS = 3_650;

/** The key `Institution.settings` stores the policy under. */
export const RETENTION_SETTINGS_KEY = "biometricRetention";

/**
 * What the policy says should happen to one stored template.
 *
 * A closed union rather than a boolean pair, so the sweep cannot express
 * "deactivate and delete" and cannot accidentally express nothing. The two
 * distinct `DEACTIVATE_*` arms exist because the reason ends up in the audit
 * log: "this template was hidden because the student left" and "this template
 * was hidden because it aged out" are different facts about a person, and an
 * administrator answering a subject-access request needs the difference.
 */
export type ExpiringDecision =
  | "KEEP"
  | "DEACTIVATE_INACTIVE_STUDENT"
  | "DEACTIVATE_EXPIRED"
  | "DELETE";

/** What one sweep did. Returned to the caller and written to the audit log. */
export interface RetentionSweepSummary {
  institutionId: string;
  /** Templates deactivated because the student is no longer ACTIVE. */
  deactivatedForInactiveStudent: number;
  /** Templates deactivated because they passed `faceTemplateRetentionDays`. */
  deactivatedForAge: number;
  /** Templates hard-deleted: past the grace window, or `onStudentInactive: DELETE`. */
  deletedTemplates: number;
  /** `SessionImage` rows removed. */
  deletedClassroomImages: number;
  /** ISO timestamp the sweep ran at. */
  ranAt: string;
  /** The policy that was in force, echoed so the audit row is self-contained. */
  policy: BiometricRetentionPolicy;
}

/** Result of an explicit, administrator-initiated erasure for one student. */
export interface FaceDataDeletionSummary {
  studentId: string;
  deletedTemplates: number;
  deletedAt: string;
}

export class RetentionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}
