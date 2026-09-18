import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classroomImageExpired,
  decideForTemplate,
  mayStoreClassroomImages,
  resolveRetentionPolicy,
  validateRetentionPolicy,
  writeRetentionPolicy,
  type RetentionCandidate,
  type RetentionPolicyInput,
} from "./policy.ts";
import {
  DEFAULT_RETENTION_POLICY,
  MAX_RETENTION_DAYS,
  RETENTION_SETTINGS_KEY,
  RetentionPolicyError,
  type BiometricRetentionPolicy,
} from "./types.ts";

/**
 * Retention policy codec and decision tests.
 *
 * The whole file is pure, so "what would this policy do to this template at
 * this instant" is a question with an exact answer and no database. That is
 * the point of splitting these functions out: the code that decides whether a
 * child's biometric template is destroyed should be the code with the most
 * tests, and it cannot be if it needs Postgres to run.
 *
 * The bias throughout is one-directional. Every ambiguous input is asserted to
 * produce *keep*, never *delete* — a bug that keeps data too long is a
 * compliance finding, and a bug that deletes it is unrecoverable.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function policy(overrides: Partial<BiometricRetentionPolicy> = {}): BiometricRetentionPolicy {
  return { ...DEFAULT_RETENTION_POLICY, ...overrides };
}

function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    id: "emb-1",
    studentId: "stu-1",
    isActive: true,
    createdAt: daysAgo(1),
    studentStatus: "ACTIVE",
    ...overrides,
  };
}

function validInput(overrides: Partial<RetentionPolicyInput> = {}): RetentionPolicyInput {
  return {
    faceTemplateRetentionDays: 0,
    onStudentInactive: "DEACTIVATE",
    deactivatedTemplateGraceDays: 30,
    classroomImageStorage: "NEVER",
    classroomImageRetentionDays: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveRetentionPolicy — reading
// ---------------------------------------------------------------------------

test("an institution that has never configured anything gets the shipped defaults", () => {
  assert.deepEqual(resolveRetentionPolicy(null), DEFAULT_RETENTION_POLICY);
  assert.deepEqual(resolveRetentionPolicy(undefined), DEFAULT_RETENTION_POLICY);
  assert.deepEqual(resolveRetentionPolicy({}), DEFAULT_RETENTION_POLICY);
});

test("garbage in the settings column reads as the defaults, never as permission to delete", () => {
  // Each of these is a shape a Json column can genuinely hold. None of them
  // may be interpreted as "retain for 0 days".
  for (const junk of [
    "a string",
    42,
    [],
    [1, 2, 3],
    { [RETENTION_SETTINGS_KEY]: null },
    { [RETENTION_SETTINGS_KEY]: "nope" },
    { [RETENTION_SETTINGS_KEY]: [] },
    { [RETENTION_SETTINGS_KEY]: { faceTemplateRetentionDays: "thirty" } },
    { [RETENTION_SETTINGS_KEY]: { faceTemplateRetentionDays: Number.NaN } },
    { [RETENTION_SETTINGS_KEY]: { faceTemplateRetentionDays: Number.POSITIVE_INFINITY } },
  ]) {
    const resolved = resolveRetentionPolicy(junk);
    assert.equal(
      resolved.faceTemplateRetentionDays,
      DEFAULT_RETENTION_POLICY.faceTemplateRetentionDays,
      `unexpected retention for ${JSON.stringify(junk)}`,
    );
    assert.equal(resolved.classroomImageStorage, "NEVER");
  }
});

test("a stored policy is read back field for field", () => {
  const resolved = resolveRetentionPolicy({
    [RETENTION_SETTINGS_KEY]: {
      faceTemplateRetentionDays: 365,
      onStudentInactive: "DELETE",
      deactivatedTemplateGraceDays: 7,
      classroomImageStorage: "RETAIN_FOR_DAYS",
      classroomImageRetentionDays: 14,
    },
  });
  assert.deepEqual(resolved, {
    faceTemplateRetentionDays: 365,
    onStudentInactive: "DELETE",
    deactivatedTemplateGraceDays: 7,
    classroomImageStorage: "RETAIN_FOR_DAYS",
    classroomImageRetentionDays: 14,
  });
});

test("an out-of-range period is clamped on read rather than taking the settings page down", () => {
  const resolved = resolveRetentionPolicy({
    [RETENTION_SETTINGS_KEY]: { faceTemplateRetentionDays: 9_999_999 },
  });
  assert.equal(resolved.faceTemplateRetentionDays, MAX_RETENTION_DAYS);
});

test("a negative period clamps to no-limit, never to a cutoff that deletes", () => {
  const resolved = resolveRetentionPolicy({
    [RETENTION_SETTINGS_KEY]: { faceTemplateRetentionDays: -30, deactivatedTemplateGraceDays: -1 },
  });
  assert.equal(resolved.faceTemplateRetentionDays, 0);
  assert.equal(resolved.deactivatedTemplateGraceDays, 0);
  // And 0 means "keep", which is what the decision function has to agree on.
  assert.equal(decideForTemplate(candidate({ createdAt: daysAgo(4000) }), resolved, NOW), "KEEP");
});

test("an unrecognised image-storage value reads as NEVER", () => {
  const resolved = resolveRetentionPolicy({
    [RETENTION_SETTINGS_KEY]: { classroomImageStorage: "FOREVER", classroomImageRetentionDays: 99 },
  });
  assert.equal(resolved.classroomImageStorage, "NEVER");
  assert.equal(resolved.classroomImageRetentionDays, 0);
});

test("RETAIN_FOR_DAYS with no period collapses to NEVER instead of meaning forever", () => {
  const resolved = resolveRetentionPolicy({
    [RETENTION_SETTINGS_KEY]: { classroomImageStorage: "RETAIN_FOR_DAYS", classroomImageRetentionDays: 0 },
  });
  assert.equal(mayStoreClassroomImages(resolved), false);
});

// ---------------------------------------------------------------------------
// validateRetentionPolicy — writing
// ---------------------------------------------------------------------------

test("there is no way to save a policy that keeps classroom photographs forever", () => {
  assert.throws(
    () =>
      validateRetentionPolicy(
        validInput({ classroomImageStorage: "RETAIN_FOR_DAYS", classroomImageRetentionDays: 0 }),
      ),
    RetentionPolicyError,
  );
});

test("storing classroom images requires an explicit period of at least one day", () => {
  const saved = validateRetentionPolicy(
    validInput({ classroomImageStorage: "RETAIN_FOR_DAYS", classroomImageRetentionDays: 1 }),
  );
  assert.equal(saved.classroomImageStorage, "RETAIN_FOR_DAYS");
  assert.equal(saved.classroomImageRetentionDays, 1);
});

test("a retention period is rejected, not silently clamped, when it is out of range", () => {
  // The read path clamps; the write path must not, so an administrator is
  // never shown a number they did not choose.
  assert.throws(
    () => validateRetentionPolicy(validInput({ faceTemplateRetentionDays: MAX_RETENTION_DAYS + 1 })),
    RetentionPolicyError,
  );
  assert.throws(
    () => validateRetentionPolicy(validInput({ faceTemplateRetentionDays: -1 })),
    RetentionPolicyError,
  );
  assert.throws(
    () => validateRetentionPolicy(validInput({ deactivatedTemplateGraceDays: 12.5 })),
    RetentionPolicyError,
  );
});

test("an unknown enum value is refused rather than defaulted", () => {
  assert.throws(
    () => validateRetentionPolicy(validInput({ onStudentInactive: "PURGE" })),
    RetentionPolicyError,
  );
  assert.throws(
    () => validateRetentionPolicy(validInput({ classroomImageStorage: "SOMETIMES" })),
    RetentionPolicyError,
  );
});

test("turning image storage off zeroes the stale period rather than leaving it armed", () => {
  const saved = validateRetentionPolicy(
    validInput({ classroomImageStorage: "NEVER", classroomImageRetentionDays: 30 }),
  );
  assert.equal(saved.classroomImageRetentionDays, 0);
});

// ---------------------------------------------------------------------------
// writeRetentionPolicy — coexistence
// ---------------------------------------------------------------------------

test("saving a retention policy preserves every other key in the settings column", () => {
  // These are the real neighbours: the Integration Center's connections and
  // the institution's academic configuration live in the same Json column, and
  // a read-modify-write that dropped them would silently delete an
  // administrator's ERP credentials.
  const existing = {
    integrations: { connections: [{ id: "int-1", name: "SIS" }] },
    academicUnitLabels: { level1: "School" },
    attendanceMode: "HYBRID",
    confidenceThresholds: { autoPresent: 0.82 },
    lowAttendanceThreshold: 75,
  };
  const next = writeRetentionPolicy(existing, policy({ faceTemplateRetentionDays: 90 }));

  assert.deepEqual(next.integrations, existing.integrations);
  assert.deepEqual(next.academicUnitLabels, existing.academicUnitLabels);
  assert.equal(next.attendanceMode, "HYBRID");
  assert.deepEqual(next.confidenceThresholds, existing.confidenceThresholds);
  assert.equal(next.lowAttendanceThreshold, 75);
  assert.equal(
    (next[RETENTION_SETTINGS_KEY] as BiometricRetentionPolicy).faceTemplateRetentionDays,
    90,
  );
});

test("writing does not mutate the settings object it was handed", () => {
  const existing = { attendanceMode: "HYBRID" };
  writeRetentionPolicy(existing, policy());
  assert.deepEqual(existing, { attendanceMode: "HYBRID" });
});

test("a policy survives a round trip through the shape a Json column returns", () => {
  const saved = validateRetentionPolicy(
    validInput({
      faceTemplateRetentionDays: 400,
      onStudentInactive: "DELETE",
      classroomImageStorage: "RETAIN_FOR_DAYS",
      classroomImageRetentionDays: 3,
    }),
  );
  const column = JSON.parse(JSON.stringify(writeRetentionPolicy({}, saved))) as unknown;
  assert.deepEqual(resolveRetentionPolicy(column), saved);
});

// ---------------------------------------------------------------------------
// decideForTemplate — the decisions that destroy data
// ---------------------------------------------------------------------------

test("under the defaults, an active student's template is kept indefinitely", () => {
  assert.equal(decideForTemplate(candidate({ createdAt: daysAgo(4000) }), policy(), NOW), "KEEP");
});

test("a template one millisecond inside its window is kept", () => {
  const p = policy({ faceTemplateRetentionDays: 30 });
  const exactlyAtCutoff = new Date(NOW.getTime() - 30 * DAY);
  assert.equal(decideForTemplate(candidate({ createdAt: exactlyAtCutoff }), p, NOW), "KEEP");
  assert.equal(
    decideForTemplate(candidate({ createdAt: new Date(exactlyAtCutoff.getTime() - 1) }), p, NOW),
    "DEACTIVATE_EXPIRED",
  );
});

test("an expired template is deactivated first, not deleted outright", () => {
  // Expiry and erasure are separate events, and the grace period between them
  // is the institution's, not this function's, to shorten.
  const p = policy({ faceTemplateRetentionDays: 30, deactivatedTemplateGraceDays: 30 });
  assert.equal(
    decideForTemplate(candidate({ createdAt: daysAgo(31) }), p, NOW),
    "DEACTIVATE_EXPIRED",
  );
  // On a later sweep the same row — now inactive — leaves by the grace rule.
  assert.equal(
    decideForTemplate(candidate({ createdAt: daysAgo(31), isActive: false }), p, NOW),
    "DELETE",
  );
});

test("a student who stops being ACTIVE has their templates deactivated by default", () => {
  for (const status of ["INACTIVE", "TRANSFERRED", "COMPLETED"]) {
    assert.equal(
      decideForTemplate(candidate({ studentStatus: status }), policy(), NOW),
      "DEACTIVATE_INACTIVE_STUDENT",
      `status ${status}`,
    );
  }
});

test("an institution whose policy is erasure-on-departure gets erasure, with no grace period", () => {
  const p = policy({ onStudentInactive: "DELETE" });
  // Enrolled today, student marked inactive today: still deleted. That is what
  // the setting says, and softening it here would mean the screen lied.
  assert.equal(
    decideForTemplate(candidate({ studentStatus: "TRANSFERRED", createdAt: NOW }), p, NOW),
    "DELETE",
  );
});

test("a deactivated template does not survive indefinitely — that is what makes deactivation a policy", () => {
  const p = policy({ deactivatedTemplateGraceDays: 30 });
  assert.equal(decideForTemplate(candidate({ isActive: false, createdAt: daysAgo(29) }), p, NOW), "KEEP");
  assert.equal(
    decideForTemplate(candidate({ isActive: false, createdAt: daysAgo(31) }), p, NOW),
    "DELETE",
  );
});

test("a zero grace period means deactivated templates are never swept, not swept immediately", () => {
  const p = policy({ deactivatedTemplateGraceDays: 0 });
  assert.equal(
    decideForTemplate(candidate({ isActive: false, createdAt: daysAgo(4000) }), p, NOW),
    "KEEP",
  );
});

test("an active student's active template is never deleted by the sweep, whatever the dates", () => {
  // The strongest invariant in the module: enrolment does not expire into
  // erasure while the student is still here and still enrolled.
  const p = policy({
    faceTemplateRetentionDays: 1,
    deactivatedTemplateGraceDays: 1,
    onStudentInactive: "DELETE",
  });
  assert.notEqual(decideForTemplate(candidate({ createdAt: daysAgo(9999) }), p, NOW), "DELETE");
});

// ---------------------------------------------------------------------------
// classroomImageExpired
// ---------------------------------------------------------------------------

test("under the default policy a stored classroom image is expired the moment it exists", () => {
  assert.equal(classroomImageExpired(NOW, policy(), NOW), true);
});

test("an institution that explicitly retains classroom images keeps them for exactly the period", () => {
  const p = policy({ classroomImageStorage: "RETAIN_FOR_DAYS", classroomImageRetentionDays: 7 });
  assert.equal(classroomImageExpired(daysAgo(6), p, NOW), false);
  assert.equal(classroomImageExpired(new Date(NOW.getTime() - 7 * DAY), p, NOW), false);
  assert.equal(classroomImageExpired(daysAgo(8), p, NOW), true);
});

test("mayStoreClassroomImages is false unless an institution deliberately turned it on", () => {
  assert.equal(mayStoreClassroomImages(policy()), false);
  assert.equal(
    mayStoreClassroomImages(
      policy({ classroomImageStorage: "RETAIN_FOR_DAYS", classroomImageRetentionDays: 7 }),
    ),
    true,
  );
});
