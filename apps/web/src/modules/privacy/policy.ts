import {
  DEFAULT_RETENTION_POLICY,
  MAX_RETENTION_DAYS,
  RETENTION_SETTINGS_KEY,
  RetentionPolicyError,
  type BiometricRetentionPolicy,
  type ClassroomImageStorage,
  type ExpiringDecision,
  type InactiveStudentAction,
} from "./types";

/**
 * Reading, validating and writing the retention policy — all pure.
 *
 * Nothing in this file touches Prisma, the clock or the session. That is what
 * lets the decisions that matter most be tested exhaustively: "does a
 * malformed settings blob delete anything?", "does saving a policy preserve
 * the integration connections stored beside it?", "is a template one hour
 * inside its window kept?". Those are the questions where being wrong is
 * expensive and being right is invisible.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readNumber(value: unknown): number | null {
  // `Number.isFinite` rather than `typeof === "number"`: NaN and Infinity are
  // both numbers, and both would turn a comparison against a cutoff date into
  // a silent "delete nothing" or "delete everything".
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Clamps a configured day count into range.
 *
 * Out-of-range values are clamped rather than rejected, because this function
 * runs on the *read* path: a stored value that somehow became invalid must
 * still produce a usable policy, and a policy that throws on read would take
 * the settings page down with it. The write path validates and rejects
 * instead, which is where an administrator can be told what is wrong.
 *
 * A negative value clamps to 0 — "no limit" — and never to a cutoff in the
 * future, which is the only clamp direction that cannot delete data.
 */
function clampDays(value: unknown, fallback: number): number {
  const parsed = readNumber(value);
  if (parsed === null) return fallback;
  const whole = Math.floor(parsed);
  if (whole <= 0) return 0;
  return Math.min(whole, MAX_RETENTION_DAYS);
}

function readInactiveAction(value: unknown): InactiveStudentAction {
  return value === "DELETE" ? "DELETE" : DEFAULT_RETENTION_POLICY.onStudentInactive;
}

function readImageStorage(value: unknown): ClassroomImageStorage {
  // Anything unrecognised reads as NEVER. The default for a value nobody can
  // interpret has to be the one that stores no photographs.
  return value === "RETAIN_FOR_DAYS"
    ? "RETAIN_FOR_DAYS"
    : DEFAULT_RETENTION_POLICY.classroomImageStorage;
}

/**
 * The policy in force for an institution, from its raw `settings` Json.
 *
 * Total: any input at all — null, a string, an array, an object with the wrong
 * types in every field — produces a valid policy, and the policy it produces
 * when the input is unusable is `DEFAULT_RETENTION_POLICY`. A settings blob
 * that cannot be understood must not be read as permission to delete.
 */
export function resolveRetentionPolicy(settings: unknown): BiometricRetentionPolicy {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return { ...DEFAULT_RETENTION_POLICY };
  }
  const bucket = (settings as Record<string, unknown>)[RETENTION_SETTINGS_KEY];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
    return { ...DEFAULT_RETENTION_POLICY };
  }
  const raw = bucket as Record<string, unknown>;

  const classroomImageStorage = readImageStorage(raw.classroomImageStorage);
  const classroomImageRetentionDays = clampDays(
    raw.classroomImageRetentionDays,
    DEFAULT_RETENTION_POLICY.classroomImageRetentionDays,
  );

  return {
    faceTemplateRetentionDays: clampDays(
      raw.faceTemplateRetentionDays,
      DEFAULT_RETENTION_POLICY.faceTemplateRetentionDays,
    ),
    onStudentInactive: readInactiveAction(raw.onStudentInactive),
    deactivatedTemplateGraceDays: clampDays(
      raw.deactivatedTemplateGraceDays,
      DEFAULT_RETENTION_POLICY.deactivatedTemplateGraceDays,
    ),
    classroomImageStorage,
    // `RETAIN_FOR_DAYS` with no period is not "keep forever" — it is a
    // half-saved setting, and the safe reading of a half-saved setting about
    // photographs of children is the one that does not keep them. Collapsing
    // it back to NEVER here means the invalid combination cannot exist
    // downstream, so no caller has to remember to check for it.
    classroomImageRetentionDays:
      classroomImageStorage === "RETAIN_FOR_DAYS" ? classroomImageRetentionDays : 0,
  };
}

/**
 * Does this institution's policy permit storing classroom photographs?
 *
 * The gate a future capture path must pass before writing a `SessionImage`
 * row. Exported now, with nothing calling it, deliberately: the retention
 * sweep deletes stored images, and a deletion mechanism without a matching
 * admission check is a policy enforced in one direction only.
 */
export function mayStoreClassroomImages(policy: BiometricRetentionPolicy): boolean {
  return policy.classroomImageStorage === "RETAIN_FOR_DAYS" && policy.classroomImageRetentionDays > 0;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface RetentionPolicyInput {
  faceTemplateRetentionDays: number;
  onStudentInactive: string;
  deactivatedTemplateGraceDays: number;
  classroomImageStorage: string;
  classroomImageRetentionDays: number;
}

function requireDays(value: number, label: string): number {
  const parsed = readNumber(value);
  if (parsed === null || !Number.isInteger(parsed)) {
    throw new RetentionPolicyError(`${label} must be a whole number of days.`);
  }
  if (parsed < 0) {
    throw new RetentionPolicyError(`${label} cannot be negative.`);
  }
  if (parsed > MAX_RETENTION_DAYS) {
    throw new RetentionPolicyError(
      `${label} cannot exceed ${MAX_RETENTION_DAYS} days (about ten years).`,
    );
  }
  return parsed;
}

/**
 * Validates an administrator's submission into a policy, or explains the
 * refusal in a sentence they can act on.
 *
 * Rejecting rather than clamping, unlike the read path: a person who typed a
 * number should be told it was not accepted, not quietly given a different
 * one. A silently-adjusted retention period is a privacy notice that does not
 * match the system.
 */
export function validateRetentionPolicy(input: RetentionPolicyInput): BiometricRetentionPolicy {
  if (input.onStudentInactive !== "DEACTIVATE" && input.onStudentInactive !== "DELETE") {
    throw new RetentionPolicyError(
      "Choose what happens to face data when a student is no longer active: deactivate it, or delete it.",
    );
  }
  if (
    input.classroomImageStorage !== "NEVER" &&
    input.classroomImageStorage !== "RETAIN_FOR_DAYS"
  ) {
    throw new RetentionPolicyError(
      "Choose whether classroom photographs are stored: never, or for a fixed number of days.",
    );
  }

  const classroomImageRetentionDays = requireDays(
    input.classroomImageRetentionDays,
    "Classroom image retention",
  );
  if (input.classroomImageStorage === "RETAIN_FOR_DAYS" && classroomImageRetentionDays < 1) {
    // The one place a 0 is refused instead of read as "no limit". There is no
    // supported way to keep a classroom photograph indefinitely, and this is
    // the check that makes that true rather than merely stated.
    throw new RetentionPolicyError(
      "Storing classroom photographs requires a retention period of at least one day. " +
        "There is no option to keep them indefinitely.",
    );
  }

  return {
    faceTemplateRetentionDays: requireDays(
      input.faceTemplateRetentionDays,
      "Face template retention",
    ),
    onStudentInactive: input.onStudentInactive,
    deactivatedTemplateGraceDays: requireDays(
      input.deactivatedTemplateGraceDays,
      "Deactivated template grace period",
    ),
    classroomImageStorage: input.classroomImageStorage,
    classroomImageRetentionDays:
      input.classroomImageStorage === "RETAIN_FOR_DAYS" ? classroomImageRetentionDays : 0,
  };
}

/**
 * Merges a policy into an existing settings object without disturbing it.
 *
 * `Institution.settings` is shared: `academicUnitLabels`, `attendanceMode`,
 * `confidenceThresholds`, `lowAttendanceThreshold` and the entire Integration
 * Center connection list all live in the same column. Writing the whole column
 * back is the only update Postgres offers here, so this function exists to
 * make "preserve everything I do not own" a property with a test rather than a
 * habit.
 */
export function writeRetentionPolicy(
  settings: unknown,
  policy: BiometricRetentionPolicy,
): Record<string, unknown> {
  const base =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {};
  base[RETENTION_SETTINGS_KEY] = { ...policy };
  return base;
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface RetentionCandidate {
  id: string;
  studentId: string;
  isActive: boolean;
  createdAt: Date;
  studentStatus: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function olderThanDays(createdAt: Date, days: number, now: Date): boolean {
  // `days === 0` means no limit, and is checked by callers before they get
  // here; guarded again so this helper is safe to call unconditionally.
  if (days <= 0) return false;
  return now.getTime() - createdAt.getTime() > days * DAY_MS;
}

/**
 * What the policy says should happen to one template, right now.
 *
 * Pure and total, taking `now` as an argument, so the boundary cases — a
 * template exactly at its cutoff, a template one millisecond past it — are
 * testable without waiting or mocking a clock.
 *
 * The order of the rules is the order of severity, and it matters:
 *
 * 1. An inactive student under a `DELETE` policy is deleted outright. The
 *    institution has said departure means erasure; a grace period would
 *    contradict the setting they chose.
 * 2. An already-deactivated template past its grace window is deleted. This
 *    is what stops "deactivated" from meaning "kept forever, quietly".
 * 3. An active template belonging to a non-ACTIVE student is deactivated.
 * 4. An active template past its age limit is deactivated. It then leaves by
 *    rule 2 on a later sweep, so an expiring template gets the same grace
 *    period as any other — expiry is not a reason to erase faster than the
 *    institution's own deletion policy.
 *
 * Anything not matched is kept. "Keep" is the default arm on purpose: a rule
 * this function fails to express results in data surviving, not in data
 * disappearing.
 */
export function decideForTemplate(
  candidate: RetentionCandidate,
  policy: BiometricRetentionPolicy,
  now: Date,
): ExpiringDecision {
  const studentIsActive = candidate.studentStatus === "ACTIVE";

  if (!studentIsActive && policy.onStudentInactive === "DELETE") {
    return "DELETE";
  }

  if (!candidate.isActive) {
    return policy.deactivatedTemplateGraceDays > 0 &&
      olderThanDays(candidate.createdAt, policy.deactivatedTemplateGraceDays, now)
      ? "DELETE"
      : "KEEP";
  }

  if (!studentIsActive) {
    return "DEACTIVATE_INACTIVE_STUDENT";
  }

  if (
    policy.faceTemplateRetentionDays > 0 &&
    olderThanDays(candidate.createdAt, policy.faceTemplateRetentionDays, now)
  ) {
    return "DEACTIVATE_EXPIRED";
  }

  return "KEEP";
}

/** Whether a stored classroom image has outlived the policy. */
export function classroomImageExpired(
  capturedAt: Date,
  policy: BiometricRetentionPolicy,
  now: Date,
): boolean {
  // Under NEVER every stored image is expired the moment it exists: the
  // policy says these are not kept, so a row that is here at all is one the
  // sweep removes rather than one it starts a clock for.
  if (!mayStoreClassroomImages(policy)) return true;
  return olderThanDays(capturedAt, policy.classroomImageRetentionDays, now);
}
