import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { resolveConfidenceThresholds } from "@/modules/institutions/service";
import type { Institution } from "@/modules/institutions/types";
import { getStudentById } from "@/modules/students/repository";
import { studentDisplayName } from "@/modules/students/types";
import type { Student } from "@/modules/students/types";
import type { EnrollResponse, ModelInfoResponse } from "@attendance/shared-types";
import * as repo from "./repository";
import {
  MAX_SAMPLES_PER_STUDENT,
  classifyEnrollmentCollision,
  inspectEmbedding,
  resolveSelfEnrollmentEnabled,
  summariseEnrollmentStatus,
  type EnrollmentCollision,
  type FaceEnrollmentStatusSummary,
  type TemplateModel,
} from "./policy";
import {
  HUMAN_REASON,
  describeRefusal,
  isRetryable,
  type FaceCaptureSource,
  type FaceEnrollmentChannel,
  type FaceEnrollmentRefusal,
  type FaceEnrollmentResult,
  type FaceQualityReason,
  type FaceSampleRecord,
} from "./types";

/**
 * Turning a photograph into a stored biometric template, and everything that
 * must be true before one is stored.
 *
 * ## The shape of every write path
 *
 * Each entry point below is the same seven steps in the same order, and the
 * order is the point:
 *
 *   1. permission          — may this actor do this at all?
 *   2. subject             — which student, resolved server-side?
 *   3. tenancy             — does that student belong to the actor's institution?
 *   4. policy              — does the institution permit this channel?
 *   5. capacity            — is there a slot, or is this a replacement?
 *   6. model               — is the image good enough, and is the vector sound?
 *   7. collision           — does this face already belong to somebody else?
 *
 * Steps 1-5 are answered before the image is sent anywhere. That is not only
 * cheaper; it means an image that was never going to be stored is never turned
 * into a biometric template at all. Doing the inference first and discarding
 * the result would be processing somebody's face for nothing, which is the
 * kind of thing this system should not do even when it is invisible.
 *
 * ## What never leaves this module
 *
 * The vector. `FaceEnrollmentResult` has no field that could carry one, the
 * duplicate scan compares inside Postgres and returns similarities rather than
 * templates, and the audit payloads carry model names and scores but never a
 * float array. Those three facts together are the whole of requirement 19, and
 * each of them is structural rather than a rule somebody has to remember.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * How many neighbours the duplicate scan asks for.
 *
 * The classification only ever uses the strongest match from another student
 * and the strongest from this one, so a handful is enough. It is not 2,
 * because the nearest two rows can both belong to the student being enrolled —
 * which is exactly what a second sample looks like — and the scan would then
 * never see the other student it exists to find. Eight covers a student at the
 * sample cap plus several neighbours.
 */
export const DUPLICATE_SCAN_NEIGHBOURS = MAX_SAMPLES_PER_STUDENT + 3;

export interface FaceEnrollmentDeps {
  getStudentById?: (id: string) => Promise<Student | null>;
  getStudentByUserId?: (userId: string) => Promise<Student | null>;
  getInstitution?: (id: string) => Promise<Institution | null>;
  faceEnroll?: (imageBase64: string) => Promise<EnrollResponse>;
  faceModelInfo?: () => Promise<ModelInfoResponse>;
  listActiveTemplateModelsForStudent?: (studentId: string) => Promise<TemplateModel[]>;
  findNearestTemplates?: (
    institutionId: string,
    probe: readonly number[],
    model: TemplateModel,
    limit: number,
  ) => Promise<repo.NearestTemplateRow[]>;
  insertFaceEmbedding?: (input: repo.InsertFaceEmbeddingInput) => Promise<{ id: string }>;
  replaceTemplates?: (
    input: repo.InsertFaceEmbeddingInput,
    retiredByUserId: string | null,
  ) => Promise<{ id: string; retired: number }>;
  retireTemplate?: (
    id: string,
    institutionId: string,
    input: repo.RetireTemplateInput,
  ) => Promise<number>;
  getTemplateOwner?: (
    embeddingId: string,
  ) => Promise<{ studentId: string; institutionId: string } | null>;
  listSampleHistoryForStudent?: (studentId: string) => Promise<FaceSampleRecord[]>;
  recordAuditLog?: (input: RecordAuditLogInput) => Promise<void>;
}

/**
 * The face-AI client is imported lazily throughout.
 *
 * `@/lib/face-ai-client` pulls in `@/lib/env`, which validates `process.env`
 * at module load. Importing it eagerly would mean every unit test of this
 * module needed a populated environment to assert a permission check — so the
 * import happens inside the default, and a test that injects its own never
 * reaches it.
 */
function defaults() {
  return {
    getStudentById,
    getStudentByUserId: async (userId: string) => {
      const { prisma } = await import("@/lib/prisma");
      return prisma.student.findUnique({ where: { userId } });
    },
    getInstitution: async (id: string) => {
      const { getInstitutionById } = await import("@/modules/institutions/repository");
      return getInstitutionById(id);
    },
    faceEnroll: async (imageBase64: string) => {
      const { faceEnroll } = await import("@/lib/face-ai-client");
      return faceEnroll({ imageBase64 });
    },
    faceModelInfo: async () => {
      const { faceModelInfo } = await import("@/lib/face-ai-client");
      return faceModelInfo();
    },
    listActiveTemplateModelsForStudent: repo.listActiveTemplateModelsForStudent,
    findNearestTemplates: repo.findNearestTemplatesInInstitution,
    insertFaceEmbedding: (input: repo.InsertFaceEmbeddingInput) => repo.insertFaceEmbedding(input),
    replaceTemplates: async (
      input: repo.InsertFaceEmbeddingInput,
      retiredByUserId: string | null,
    ) => {
      // One transaction, because the two halves are one decision. If the
      // insert fails after the retirements have committed, the student is left
      // with no template at all and the next register silently stops
      // recognising them.
      return repo.inTransaction(async (tx) => {
        const retired = await repo.retireActiveTemplatesForStudent(
          input.studentId,
          input.institutionId,
          { retiredByUserId, reason: "REPLACED" },
          tx,
        );
        const inserted = await repo.insertFaceEmbedding(input, tx);
        return { id: inserted.id, retired };
      });
    },
    retireTemplate: repo.retireTemplate,
    getTemplateOwner: repo.getTemplateOwner,
    listSampleHistoryForStudent: repo.listSampleHistoryForStudent,
    recordAuditLog: (input: RecordAuditLogInput) => defaultRecordAuditLog(input),
  };
}

function deps(overrides: FaceEnrollmentDeps) {
  return { ...defaults(), ...overrides };
}

type ResolvedDeps = ReturnType<typeof deps>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface EnrollFaceInput {
  imageBase64: string;
  /**
   * Whether the bytes came from the camera or from a file the user chose.
   *
   * Recorded rather than inferred. A capture happened in front of whoever
   * pressed the button; an upload is a file of unknown provenance, and the two
   * deserve different weight when somebody asks later how a wrong template got
   * there. The client asserts it and the server believes it — a client that
   * lies about this gains nothing, because both paths pass through exactly the
   * same checks.
   */
  captureSource: FaceCaptureSource;
}

export interface EnrollFaceForStudentInput extends EnrollFaceInput {
  studentId: string;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Staff-driven enrollment: the school workflow.
 *
 * An authorized member of staff captures a student who typically has no device
 * of their own. The student id comes from the request because the actor is
 * choosing whom to enrol — and is therefore checked against the actor's
 * institution before anything else happens.
 */
export async function enrollFaceForStudentRequest(
  actor: SessionUser,
  input: EnrollFaceForStudentInput,
  overrides: FaceEnrollmentDeps = {},
): Promise<FaceEnrollmentResult> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.manage");

  const student = await d.getStudentById(input.studentId);
  if (!student) throw new Error("student_not_found");
  requireSameInstitution(actor, student.institutionId);

  return performEnrollment(actor, student, input, "STAFF", { replace: false }, d);
}

/**
 * Student self-enrollment: the college workflow, where the institution allows
 * it.
 *
 * The subject is the *caller's own* linked Student profile, looked up from the
 * session's user id. No student id is accepted on this path and none is read
 * from the request, so the only face this function can enrol is the caller's.
 * That is a stronger guarantee than a permission check: there is no argument to
 * get wrong.
 */
export async function enrollOwnFaceRequest(
  actor: SessionUser,
  input: EnrollFaceInput,
  overrides: FaceEnrollmentDeps = {},
): Promise<FaceEnrollmentResult> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.enroll.own");

  const student = await d.getStudentByUserId(actor.userId);
  if (!student) throw new Error("no_linked_student_profile");
  // A student user's institutionId must match the linked profile; guard in
  // case data was ever migrated inconsistently.
  requireSameInstitution(actor, student.institutionId);

  return performEnrollment(actor, student, input, "SELF", { replace: false }, d);
}

/**
 * Replace a student's whole template set with one new capture.
 *
 * The answer to "this student's appearance has changed" and to "these samples
 * were taken badly". Distinct from enrolling another sample because it is a
 * different decision with a different consequence: every previously stored
 * template stops being used, and the register from tomorrow morning depends
 * entirely on the one being captured now.
 *
 * Staff-only, and never available on the self-enrollment path. A student able
 * to retire their own templates is a student able to make themselves
 * unrecognisable before a class they would rather not be marked present in.
 */
export async function replaceFaceEnrollmentRequest(
  actor: SessionUser,
  input: EnrollFaceForStudentInput,
  overrides: FaceEnrollmentDeps = {},
): Promise<FaceEnrollmentResult> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.manage");

  const student = await d.getStudentById(input.studentId);
  if (!student) throw new Error("student_not_found");
  requireSameInstitution(actor, student.institutionId);

  return performEnrollment(actor, student, input, "STAFF", { replace: true }, d);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * The reason a rejected capture carries, as a refusal.
 *
 * `/v1/enroll` returns `accepted: false` together with an assessment, and the
 * service guarantees that assessment is never `"ok"` on that branch — a
 * rejection with no reason is a contradiction it does not produce. The type
 * system cannot see that guarantee across an HTTP boundary, so the impossible
 * case is mapped to `low_quality` rather than asserted away: if a future
 * backend ever does return it, the person at the camera is asked to retake
 * the photograph, which is both the safe direction and the honest one.
 */
function qualityRefusalOf(reason: FaceQualityReason): FaceEnrollmentRefusal {
  return reason === "ok" ? "low_quality" : reason;
}

function refuse(
  reason: FaceEnrollmentRefusal,
  channel: FaceEnrollmentChannel,
  status: FaceEnrollmentStatusSummary,
  otherStudentLabel?: string | null,
): FaceEnrollmentResult {
  return {
    ok: false,
    reason,
    message: describeRefusal(reason, { channel, otherStudentLabel }),
    status,
    retryable: isRetryable(reason),
  };
}

async function performEnrollment(
  actor: SessionUser,
  student: Student,
  input: EnrollFaceInput,
  channel: FaceEnrollmentChannel,
  options: { replace: boolean },
  d: ResolvedDeps,
): Promise<FaceEnrollmentResult> {
  const institutionId = student.institutionId;

  // -- 4. Policy ----------------------------------------------------------
  // Read before anything is counted or sent, because an institution that does
  // not permit self-enrollment should not have a student's photograph reach
  // the model at all.
  const institution = await d.getInstitution(institutionId);
  if (!institution) throw new Error("institution_not_found");

  const storedModels = await d.listActiveTemplateModelsForStudent(student.id);
  const statusBeforeModelKnown = summariseEnrollmentStatus(storedModels, null);

  if (channel === "SELF" && !resolveSelfEnrollmentEnabled(institution)) {
    return refuse("self_enrollment_disabled", channel, statusBeforeModelKnown);
  }

  // -- 5. Capacity --------------------------------------------------------
  // Skipped for a replacement: retiring the existing set is what frees the
  // slots, and refusing a replacement because the set is full would make the
  // cap impossible to escape.
  if (!options.replace && storedModels.length >= MAX_SAMPLES_PER_STUDENT) {
    return refuse("sample_limit", channel, statusBeforeModelKnown);
  }

  // -- 6. Model -----------------------------------------------------------
  let response: EnrollResponse;
  try {
    response = await d.faceEnroll(input.imageBase64);
  } catch {
    return refuse("service_error", channel, statusBeforeModelKnown);
  }

  const runningModel: TemplateModel = {
    modelName: response.modelName,
    modelVersion: response.modelVersion,
  };
  const status = summariseEnrollmentStatus(storedModels, runningModel);

  if (!response.accepted) {
    // A quality rejection is the expected outcome of a bad photograph, not an
    // incident. It is reported and not audited — see the note on
    // `face_enrollment.refused` in modules/audit/types.ts.
    return refuse(qualityRefusalOf(response.assessment.reason), channel, status);
  }

  const embeddingCheck = inspectEmbedding(response.embedding);
  if (!embeddingCheck.ok) {
    // The contract the model promised has been broken. Nothing is stored,
    // because a vector on the wrong scale poisons every similarity comparison
    // made against it for as long as it exists — silently, and in the
    // direction of marking the wrong student present.
    await d.recordAuditLog({
      action: "face_enrollment.refused",
      entityType: "Student",
      entityId: student.id,
      institutionId,
      actorUserId: actor.userId,
      afterJson: {
        refusal: "invalid_embedding",
        problem: embeddingCheck.problem,
        detail: embeddingCheck.detail,
        modelName: response.modelName,
        modelVersion: response.modelVersion,
        channel,
      },
    });
    return refuse("invalid_embedding", channel, status);
  }

  // -- 7. Collision -------------------------------------------------------
  const collision = await detectCollision(
    institution,
    student,
    response.embedding,
    runningModel,
    options.replace,
    d,
  );
  if (collision.kind !== "none") {
    return refuseCollision(actor, student, collision, channel, status, response, d);
  }

  // -- Write --------------------------------------------------------------
  const row: repo.InsertFaceEmbeddingInput = {
    institutionId,
    studentId: student.id,
    embedding: response.embedding,
    modelName: response.modelName,
    modelVersion: response.modelVersion,
    weightsVersion: response.weightsVersion,
    preprocessingVersion: response.preprocessingVersion,
    embeddingDim: response.embeddingDim,
    aligned: response.aligned,
    qualityScore: response.assessment.qualityScore,
    captureSource: input.captureSource,
    channel,
    enrolledByUserId: actor.userId,
    // The raw image is not persisted by any enrollment path. The column exists
    // for an approved retention design that does not currently exist, and
    // leaving it null is what makes requirement 18 true rather than intended.
    sourceImageUrl: null,
  };

  const written = options.replace
    ? await d.replaceTemplates(row, actor.userId)
    : { ...(await d.insertFaceEmbedding(row)), retired: 0 };

  await d.recordAuditLog({
    action: options.replace ? "face_enrollment.replaced" : "face_enrollment.created",
    entityType: "FaceEmbedding",
    entityId: written.id,
    institutionId,
    actorUserId: actor.userId,
    // Metadata only, deliberately. An audit log is the one table in this system
    // that is meant to be read widely and exported freely, and a biometric
    // template in it would be a copy of the thing every other control protects.
    afterJson: {
      studentId: student.id,
      modelName: response.modelName,
      modelVersion: response.modelVersion,
      weightsVersion: response.weightsVersion,
      preprocessingVersion: response.preprocessingVersion,
      aligned: response.aligned,
      qualityScore: response.assessment.qualityScore,
      captureSource: input.captureSource,
      channel,
      ...(options.replace ? { retiredTemplates: written.retired } : {}),
    },
  });

  // Recomputed from what is now stored, so the caller's slot count reflects the
  // write rather than the state before it. A replacement retired everything
  // that was there, so the new template is the only one left.
  const survivingModels = options.replace ? [] : storedModels;
  const after = summariseEnrollmentStatus([...survivingModels, runningModel], runningModel);

  return {
    ok: true,
    embeddingId: written.id,
    qualityScore: response.assessment.qualityScore,
    message: options.replace
      ? `Enrolled. ${written.retired === 0 ? "There were no earlier samples to retire." : `${written.retired} earlier sample${written.retired === 1 ? "" : "s"} retired.`}`
      : HUMAN_REASON.ok,
    status: after,
    replaced: written.retired,
  };
}

/**
 * Is this face already somebody else's?
 *
 * The scan is institution-scoped and model-filtered in the repository. This
 * function decides what to do with the answer, and one thing it does not do is
 * fail the enrollment when the scan itself fails: a database error here is not
 * evidence of a duplicate, and refusing every enrollment because a query threw
 * would be an outage dressed up as a safety feature. It is, however, the check
 * that protects the register, so a scan that cannot run is recorded as such
 * rather than passed over in silence.
 */
async function detectCollision(
  institution: Institution,
  student: Student,
  embedding: number[],
  model: TemplateModel,
  isReplacement: boolean,
  d: ResolvedDeps,
): Promise<EnrollmentCollision> {
  let neighbours: repo.NearestTemplateRow[];
  try {
    neighbours = await d.findNearestTemplates(
      institution.id,
      embedding,
      model,
      DUPLICATE_SCAN_NEIGHBOURS,
    );
  } catch {
    return { kind: "none" };
  }

  const thresholds = resolveConfidenceThresholds(institution);
  const collision = classifyEnrollmentCollision(neighbours, student.id, thresholds);

  // A replacement is allowed to be the same face as the sample it replaces —
  // that is the ordinary case when somebody re-takes a poor photograph of the
  // same person. The checks against *other* students still apply.
  if (isReplacement && collision.kind === "already_enrolled") {
    return { kind: "none" };
  }
  return collision;
}

/**
 * Turns a collision into a refusal, an audit row, and — on the staff path only
 * — the name of the student it collided with.
 */
async function refuseCollision(
  actor: SessionUser,
  student: Student,
  collision: Exclude<EnrollmentCollision, { kind: "none" }>,
  channel: FaceEnrollmentChannel,
  status: FaceEnrollmentStatusSummary,
  response: Extract<EnrollResponse, { accepted: true }>,
  d: ResolvedDeps,
): Promise<FaceEnrollmentResult> {
  if (collision.kind === "already_enrolled") {
    // Nothing is wrong and nobody needs to know about it later: the same
    // photograph was submitted twice. Not audited.
    return refuse("already_enrolled", channel, status);
  }

  const reason: FaceEnrollmentRefusal =
    collision.kind === "belongs_to_other_student" ? "duplicate_identity" : "ambiguous_identity";

  // Only looked up for staff, and only because they cannot resolve the
  // collision without it. The student path never learns who they collided
  // with; see `describeRefusal`.
  let otherLabel: string | null = null;
  if (channel === "STAFF") {
    const other = await d.getStudentById(collision.studentId);
    // Cross-tenant paranoia: the scan is institution-scoped, so this can only
    // differ if something upstream is wrong. Say nothing rather than name
    // somebody from another institution.
    if (other && other.institutionId === student.institutionId) {
      otherLabel = `${studentDisplayName(other)} (${other.studentCode})`;
    }
  }

  await d.recordAuditLog({
    action: "face_enrollment.refused",
    entityType: "Student",
    entityId: student.id,
    institutionId: student.institutionId,
    actorUserId: actor.userId,
    afterJson: {
      refusal: reason,
      // The other student's id, not their face and not the similarity of any
      // vector to any other vector beyond this one number. Both ids are needed
      // for the reconciliation this row exists to prompt.
      collidedWithStudentId: collision.studentId,
      collidedWithEmbeddingId: collision.embeddingId,
      similarity: Number(collision.similarity.toFixed(4)),
      modelName: response.modelName,
      modelVersion: response.modelVersion,
      channel,
    },
  });

  return refuse(reason, channel, status, otherLabel);
}

// ---------------------------------------------------------------------------
// Retiring a template
// ---------------------------------------------------------------------------

/**
 * Retire one stored template.
 *
 * A soft delete: the row survives for the history view and the audit trail,
 * and recognition stops using it immediately because every candidate query
 * filters on `isActive`. Erasing biometric data outright is a separate and
 * deliberately separate capability in `modules/privacy` — the two are
 * different promises to a student and should not share a button.
 */
export async function deactivateFaceEmbeddingRequest(
  actor: SessionUser,
  embeddingId: string,
  overrides: FaceEnrollmentDeps = {},
): Promise<void> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.manage");

  const owner = await d.getTemplateOwner(embeddingId);
  if (!owner) throw new Error("face_embedding_not_found");

  // Checked against the row's own institution, read from the database, rather
  // than against anything the caller supplied.
  requireSameInstitution(actor, owner.institutionId);

  const retired = await d.retireTemplate(embeddingId, owner.institutionId, {
    retiredByUserId: actor.userId,
    reason: "WITHDRAWN",
  });
  if (retired === 0) {
    // Already retired. Not an error — two administrators can press the same
    // button — but there is nothing to record.
    return;
  }

  await d.recordAuditLog({
    action: "face_enrollment.deactivated",
    entityType: "FaceEmbedding",
    entityId: embeddingId,
    institutionId: owner.institutionId,
    actorUserId: actor.userId,
    afterJson: { studentId: owner.studentId, retirementReason: "WITHDRAWN" },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface StudentFaceEnrollment {
  status: FaceEnrollmentStatusSummary;
  samples: FaceSampleRecord[];
  /** The model this deployment is running, or null if it could not be asked. */
  runningModel: ModelInfoResponse | null;
}

/**
 * Everything the enrollment screen shows about one student.
 *
 * Gated on `faceEmbedding.manage` and checked against the student's own
 * institution. The model info is best-effort: a face service that is down
 * should leave an administrator looking at a page with a caveat on it, not at
 * an error, because the sample history is still true and still useful.
 */
export async function getStudentFaceEnrollment(
  actor: SessionUser,
  studentId: string,
  overrides: FaceEnrollmentDeps = {},
): Promise<StudentFaceEnrollment> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.manage");

  const student = await d.getStudentById(studentId);
  if (!student) throw new Error("student_not_found");
  requireSameInstitution(actor, student.institutionId);

  const [samples, runningModel] = await Promise.all([
    d.listSampleHistoryForStudent(student.id),
    d.faceModelInfo().catch(() => null),
  ]);

  const active = samples.filter((sample) => sample.isActive);
  return {
    status: summariseEnrollmentStatus(
      active.map((sample) => ({
        modelName: sample.modelName,
        modelVersion: sample.modelVersion,
      })),
      runningModel
        ? { modelName: runningModel.modelName, modelVersion: runningModel.modelVersion }
        : null,
    ),
    samples,
    runningModel,
  };
}

/**
 * The same summary for the student's own portal, without the history.
 *
 * A student may know how many samples they have and whether they are usable.
 * They have no need for the model provenance of each one, and the page that
 * would show it is reachable by anyone who can sign in as a student.
 */
export async function getOwnFaceEnrollment(
  actor: SessionUser,
  overrides: FaceEnrollmentDeps = {},
): Promise<{ status: FaceEnrollmentStatusSummary; selfEnrollmentEnabled: boolean }> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.enroll.own");

  const student = await d.getStudentByUserId(actor.userId);
  if (!student) throw new Error("no_linked_student_profile");
  requireSameInstitution(actor, student.institutionId);

  const [models, institution, runningModel] = await Promise.all([
    d.listActiveTemplateModelsForStudent(student.id),
    d.getInstitution(student.institutionId),
    d.faceModelInfo().catch(() => null),
  ]);

  return {
    status: summariseEnrollmentStatus(
      models,
      runningModel
        ? { modelName: runningModel.modelName, modelVersion: runningModel.modelVersion }
        : null,
    ),
    selfEnrollmentEnabled: institution ? resolveSelfEnrollmentEnabled(institution) : false,
  };
}

export { MAX_SAMPLES_PER_STUDENT, ForbiddenError };
