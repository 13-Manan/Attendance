import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getStudentById } from "@/modules/students/repository";
import type { Student } from "@/modules/students/types";
import * as repo from "./repository";
import {
  classroomImageExpired,
  decideForTemplate,
  resolveRetentionPolicy,
  validateRetentionPolicy,
  writeRetentionPolicy,
  type RetentionPolicyInput,
} from "./policy";
import {
  RetentionPolicyError,
  type BiometricRetentionPolicy,
  type FaceDataDeletionSummary,
  type RetentionSweepSummary,
} from "./types";

/**
 * Face-data retention: reading the policy, changing it, enforcing it, and
 * erasing one student's biometric data on request.
 *
 * ## Which permissions gate this, and why no new ones were invented
 *
 * Reading the policy requires `institution.read`; changing it requires
 * `institution.update` — it is institution configuration stored in
 * `Institution.settings` beside the academic unit labels that key already
 * governs. Erasing a student's face data and running a sweep require
 * `faceEmbedding.manage`, the key that already governs enrollment and
 * deactivation.
 *
 * No new permission key was added, for the reason `modules/integrations/
 * center-service.ts` states at length: `PERMISSIONS` is code but the
 * role→permission rows are seeded *data*, so a new key would exist in this
 * build and in nobody's database, locking every current administrator out of
 * the screen. A retention control nobody can reach is worse than no control.
 *
 * ## Why the sweep has an actor
 *
 * A retention sweep is the kind of job that wants to be a cron with no user
 * attached — and that is exactly the shape in which an unscoped delete gets
 * written. This one takes a `SessionUser`, resolves the institution from that
 * user rather than from an argument, and passes it to every repository call.
 * ADR-0007 already records that no scheduler ships with this build; when one
 * arrives it will need a service account, which is the right thing for it to
 * need before it is allowed to delete biometric templates.
 *
 * ## Deletion is reported, never assumed
 *
 * Every function here returns counts that come from the database's own
 * `count`, not from the length of the list it intended to delete. A sweep that
 * says it deleted four templates deleted four rows.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PrivacyDeps {
  getSettings?: (institutionId: string) => Promise<{ id: string; settings: unknown } | null>;
  writeSettings?: (institutionId: string, settings: Record<string, unknown>) => Promise<void>;
  listTemplates?: typeof repo.listTemplatesForRetention;
  deactivateTemplates?: typeof repo.deactivateTemplates;
  deleteTemplates?: typeof repo.deleteTemplates;
  listTemplateIdsForStudent?: typeof repo.listTemplateIdsForStudent;
  listClassroomImages?: typeof repo.listClassroomImagesForRetention;
  deleteClassroomImages?: typeof repo.deleteClassroomImages;
  getStudentById?: (id: string) => Promise<Student | null>;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
  now?: () => Date;
}

function deps(overrides: PrivacyDeps) {
  return {
    getSettings: overrides.getSettings ?? repo.getInstitutionSettings,
    writeSettings: overrides.writeSettings ?? repo.writeInstitutionSettings,
    listTemplates: overrides.listTemplates ?? repo.listTemplatesForRetention,
    deactivateTemplates: overrides.deactivateTemplates ?? repo.deactivateTemplates,
    deleteTemplates: overrides.deleteTemplates ?? repo.deleteTemplates,
    listTemplateIdsForStudent:
      overrides.listTemplateIdsForStudent ?? repo.listTemplateIdsForStudent,
    listClassroomImages: overrides.listClassroomImages ?? repo.listClassroomImagesForRetention,
    deleteClassroomImages: overrides.deleteClassroomImages ?? repo.deleteClassroomImages,
    getStudentById: overrides.getStudentById ?? getStudentById,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => defaultRecordAuditLog(input)),
    now: overrides.now ?? (() => new Date()),
  };
}

type Permission = "institution.read" | "institution.update" | "faceEmbedding.manage";

/**
 * The institution this actor acts on, or a refusal.
 *
 * The institution is taken from the session and never from a parameter. There
 * is no signature in this module through which a caller can name the tenant
 * whose biometric data is about to be deleted.
 */
function requireInstitution(actor: SessionUser, permission: Permission): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    // A platform-level account has no single institution, and "all of them" is
    // not an acceptable reading of that on a deletion path.
    throw new RetentionPolicyError(
      "This account is not scoped to an institution, so it cannot manage face-data retention.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading and changing the policy
// ---------------------------------------------------------------------------

export async function getRetentionPolicy(
  actor: SessionUser,
  overrides: PrivacyDeps = {},
): Promise<BiometricRetentionPolicy> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.read");
  const row = await d.getSettings(institutionId);
  return resolveRetentionPolicy(row?.settings);
}

/**
 * The policy in force, for internal callers that already know the institution
 * and have already authorized the request.
 *
 * Separate from `getRetentionPolicy` and deliberately not exported through
 * `actions.ts`: it takes an institution id, so it must never be reachable from
 * a request body. It exists for the capture path, which needs to ask "may I
 * store this image" while holding a session it has already validated.
 */
export async function resolveInstitutionPolicy(
  institutionId: string,
  overrides: PrivacyDeps = {},
): Promise<BiometricRetentionPolicy> {
  const d = deps(overrides);
  const row = await d.getSettings(institutionId);
  return resolveRetentionPolicy(row?.settings);
}

export async function updateRetentionPolicy(
  actor: SessionUser,
  input: RetentionPolicyInput,
  overrides: PrivacyDeps = {},
): Promise<BiometricRetentionPolicy> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  // Validated before anything is read back, so an invalid submission cannot
  // trigger a settings write at all.
  const next = validateRetentionPolicy(input);

  const row = await d.getSettings(institutionId);
  const previous = resolveRetentionPolicy(row?.settings);
  await d.writeSettings(institutionId, writeRetentionPolicy(row?.settings, next));

  // Both halves are logged. Shortening a retention period is an instruction to
  // destroy data on the next sweep, and the question after the fact is always
  // "who shortened it, and from what" — a row holding only the new value
  // cannot answer the second half.
  await d.audit({
    action: "face_data.retention_policy_updated",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: previous,
    afterJson: next,
  });

  return next;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Applies the policy to every template and stored image in the institution.
 *
 * Deactivations run before deletions and each is a single bulk statement, so a
 * sweep over a large roster is a handful of queries rather than one per row.
 *
 * Idempotent: a second run over an unchanged database deactivates nothing new
 * and deletes nothing new, because every decision is a function of the row's
 * current state. That matters because whatever eventually calls this — a cron,
 * an admin button, a retry after a timeout — will call it more than once.
 */
export async function runRetentionSweep(
  actor: SessionUser,
  overrides: PrivacyDeps = {},
): Promise<RetentionSweepSummary> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "faceEmbedding.manage");

  const settingsRow = await d.getSettings(institutionId);
  const policy = resolveRetentionPolicy(settingsRow?.settings);
  const now = d.now();

  const candidates = await d.listTemplates(institutionId);

  const deactivateForStudent: string[] = [];
  const deactivateForAge: string[] = [];
  const toDelete: string[] = [];

  for (const candidate of candidates) {
    switch (decideForTemplate(candidate, policy, now)) {
      case "DEACTIVATE_INACTIVE_STUDENT":
        deactivateForStudent.push(candidate.id);
        break;
      case "DEACTIVATE_EXPIRED":
        deactivateForAge.push(candidate.id);
        break;
      case "DELETE":
        toDelete.push(candidate.id);
        break;
      case "KEEP":
        break;
    }
  }

  // Two calls rather than one over the concatenation: the counts are reported
  // separately and an audit row that says "12 deactivated" without saying why
  // is a row nobody can act on.
  const deactivatedForInactiveStudent = await d.deactivateTemplates(
    institutionId,
    deactivateForStudent,
  );
  const deactivatedForAge = await d.deactivateTemplates(institutionId, deactivateForAge);
  const deletedTemplates = await d.deleteTemplates(institutionId, toDelete);

  const images = await d.listClassroomImages(institutionId);
  const expiredImages = images
    .filter((image) => classroomImageExpired(image.capturedAt, policy, now))
    .map((image) => image.id);
  const deletedClassroomImages = await d.deleteClassroomImages(institutionId, expiredImages);

  const summary: RetentionSweepSummary = {
    institutionId,
    deactivatedForInactiveStudent,
    deactivatedForAge,
    deletedTemplates,
    deletedClassroomImages,
    ranAt: now.toISOString(),
    policy,
  };

  // Written even when every count is zero. "The sweep ran on Tuesday and found
  // nothing to do" is the evidence that the policy is being enforced; only
  // logging the runs that deleted something would make an enforcement gap
  // invisible in exactly the period it mattered.
  //
  // The payload holds counts, ids of nothing, and no embedding — a retention
  // log that recorded which students lost templates would reconstruct the
  // biometric roster it was written to protect. The per-template rows below
  // carry the student id; this one is the aggregate.
  await d.audit({
    action: "face_data.retention_purged",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    afterJson: summary,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// Explicit erasure
// ---------------------------------------------------------------------------

/**
 * Erases every face template a student has — active, deactivated, all of them.
 *
 * This is the workflow behind "delete my face data": a request from a student
 * or a parent that an administrator acts on, independent of any retention
 * period. It deletes rather than deactivates, because a deactivation in answer
 * to an erasure request is an answer that is not true.
 *
 * What survives is the attendance register. `deleteTemplates` clears the
 * advisory `matchedEmbeddingId` pointer and leaves every record's date,
 * `finalResult` and correction history intact — erasing a biometric template
 * must not put holes in a statutory attendance record, and those are separable
 * precisely because the register never stored the biometric data itself.
 *
 * Re-enrollment is unaffected: a student whose templates are deleted can enrol
 * again, which is the difference between erasure and a ban.
 */
export async function deleteStudentFaceData(
  actor: SessionUser,
  studentId: string,
  overrides: PrivacyDeps = {},
): Promise<FaceDataDeletionSummary> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "faceEmbedding.manage");

  const student = await d.getStudentById(studentId);
  if (!student) throw new RetentionPolicyError("That student no longer exists.");
  // Belt and braces: the repository call below is scoped by `institutionId`
  // anyway, so a cross-tenant id would delete nothing. The explicit check is
  // what turns "deletes nothing" into "is refused" — silently reporting zero
  // deletions to an administrator who believes they erased a record is the
  // worse of the two failures.
  requireSameInstitution(actor, student.institutionId);

  const ids = await d.listTemplateIdsForStudent(institutionId, studentId);
  const deletedTemplates = await d.deleteTemplates(institutionId, ids);
  const deletedAt = d.now().toISOString();

  await d.audit({
    action: "face_enrollment.deleted",
    entityType: "Student",
    entityId: studentId,
    institutionId,
    actorUserId: actor.userId,
    // Counts and ids of the deleted rows, never a vector. The embedding ids
    // are safe and useful: they are what a prior `face_enrollment.created` row
    // is keyed on, so the two rows together show a template's whole life.
    afterJson: { studentId, deletedTemplates, embeddingIds: ids, deletedAt },
  });

  return { studentId, deletedTemplates, deletedAt };
}

export { RetentionPolicyError };
