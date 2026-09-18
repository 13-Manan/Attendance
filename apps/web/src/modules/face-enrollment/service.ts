import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getStudentById } from "@/modules/students/repository";
import type { Student } from "@/modules/students/types";
import type { EnrollResponse } from "@attendance/shared-types";
import {
  countActiveEmbeddingsForStudent,
  insertFaceEmbedding,
  type InsertFaceEmbeddingInput,
} from "./repository";
import { HUMAN_REASON, type FaceEnrollmentResult } from "./types";

/** Product-level cap on stored face samples per student. Keeps the vector
 * search cheap and prevents unbounded growth if a UI is misused; multiple
 * samples remain supported (Phase 3 spec) up to this cap. */
export const MAX_SAMPLES_PER_STUDENT = 5;

export interface EnrollFaceForStudentInput {
  studentId: string;
  imageBase64: string;
}

export interface EnrollFaceForStudentDeps {
  getStudentById?: (id: string) => Promise<Student | null>;
  faceEnroll?: (imageBase64: string) => Promise<EnrollResponse>;
  countActiveEmbeddingsForStudent?: (studentId: string) => Promise<number>;
  insertFaceEmbedding?: (input: InsertFaceEmbeddingInput) => Promise<{ id: string }>;
  recordAuditLog?: (input: RecordAuditLogInput) => Promise<void>;
}

/**
 * Staff-driven enrollment. The Phase 3 "school workflow": an authorized
 * admin/class-teacher captures a photo of a student who typically does not
 * have a personal device.
 *
 * Security shape (in order — each check must be provable without hitting
 * the DB for the injected repository/service to be trivially testable):
 *   1. Caller has faceEmbedding.manage.
 *   2. Target student belongs to the caller's institution.
 *   3. face-ai returns accepted=true (quality gate).
 *   4. Under the per-student sample cap.
 *
 * The embedding is NEVER returned to the caller — only its id and a
 * quality score. This is the Phase 3 "no raw embeddings in responses"
 * invariant, kept true at the module boundary rather than in each caller.
 */
export async function enrollFaceForStudentRequest(
  actor: SessionUser,
  input: EnrollFaceForStudentInput,
  deps: EnrollFaceForStudentDeps = {},
): Promise<FaceEnrollmentResult> {
  requirePermission(actor, "faceEmbedding.manage");

  const getStudent = deps.getStudentById ?? getStudentById;
  const student = await getStudent(input.studentId);
  if (!student) throw new Error("student_not_found");
  requireSameInstitution(actor, student.institutionId);

  return performEnrollment(actor, student, input.imageBase64, "STAFF", deps);
}

export interface EnrollOwnFaceInput {
  imageBase64: string;
}

export interface EnrollOwnFaceDeps extends EnrollFaceForStudentDeps {
  getStudentByUserId?: (userId: string) => Promise<Student | null>;
}

/**
 * Student self-enrollment (college workflow). Uses the CALLER's linked
 * Student profile — never a studentId from the request body — so the only
 * face this method can enroll belongs to the caller. The permission
 * (`faceEmbedding.enroll.own`) is scoped so students can't reach staff
 * enrollment paths, and staff-only permissions cannot exercise this path
 * with someone else's userId.
 */
export async function enrollOwnFaceRequest(
  actor: SessionUser,
  input: EnrollOwnFaceInput,
  deps: EnrollOwnFaceDeps = {},
): Promise<FaceEnrollmentResult> {
  requirePermission(actor, "faceEmbedding.enroll.own");

  const getStudentByUserId =
    deps.getStudentByUserId ??
    (async (userId: string) => {
      const { prisma } = await import("@/lib/prisma");
      return prisma.student.findUnique({ where: { userId } });
    });

  const student = await getStudentByUserId(actor.userId);
  if (!student) throw new Error("no_linked_student_profile");
  // A student user's institutionId must match the linked profile; guard
  // in case data was ever migrated inconsistently.
  requireSameInstitution(actor, student.institutionId);

  return performEnrollment(actor, student, input.imageBase64, "SELF", deps);
}

async function performEnrollment(
  actor: SessionUser,
  student: Student,
  imageBase64: string,
  channel: "STAFF" | "SELF",
  deps: EnrollFaceForStudentDeps,
): Promise<FaceEnrollmentResult> {
  const countFn = deps.countActiveEmbeddingsForStudent ?? countActiveEmbeddingsForStudent;
  const activeCount = await countFn(student.id);
  if (activeCount >= MAX_SAMPLES_PER_STUDENT) {
    return {
      ok: false,
      reason: "duplicate",
      message: `This student already has the maximum of ${MAX_SAMPLES_PER_STUDENT} active face samples. Deactivate an older sample before enrolling another.`,
    };
  }

  const enrollFn =
    deps.faceEnroll ??
    (async (body: string) => {
      // Lazy import — keeps `@/lib/env` (which validates process.env at
      // module load) out of the import graph of pure unit tests.
      const { faceEnroll } = await import("@/lib/face-ai-client");
      return faceEnroll({ imageBase64: body });
    });

  let response: EnrollResponse;
  try {
    response = await enrollFn(imageBase64);
  } catch {
    return {
      ok: false,
      reason: "service_error",
      message: "Face recognition service is temporarily unavailable. Please try again.",
    };
  }

  if (!response.accepted) {
    return {
      ok: false,
      reason: response.assessment.reason,
      message: HUMAN_REASON[response.assessment.reason] ?? "Image was rejected. Please recapture.",
    };
  }

  const insertFn = deps.insertFaceEmbedding ?? insertFaceEmbedding;
  const inserted = await insertFn({
    institutionId: student.institutionId,
    studentId: student.id,
    embedding: response.embedding,
    modelName: response.modelName,
    modelVersion: response.modelVersion,
    embeddingDim: response.embeddingDim,
    sourceImageUrl: null,
  });

  const auditFn = deps.recordAuditLog ?? ((i: RecordAuditLogInput) => defaultRecordAuditLog(i));
  await auditFn({
    action: "face_enrollment.created",
    entityType: "FaceEmbedding",
    entityId: inserted.id,
    institutionId: student.institutionId,
    actorUserId: actor.userId,
    // Deliberately never log the embedding vector — audit trail must be
    // safe to export and read broadly. Log only metadata.
    afterJson: {
      studentId: student.id,
      modelName: response.modelName,
      modelVersion: response.modelVersion,
      channel,
      qualityScore: response.assessment.qualityScore,
    },
  });

  return {
    ok: true,
    embeddingId: inserted.id,
    qualityScore: response.assessment.qualityScore,
    message: HUMAN_REASON.ok,
  };
}

export interface DeactivateFaceEmbeddingDeps {
  getStudentById?: (id: string) => Promise<Student | null>;
  deactivateFaceEmbedding?: (id: string) => Promise<void>;
  getEmbeddingStudentId?: (embeddingId: string) => Promise<string | null>;
  recordAuditLog?: (input: RecordAuditLogInput) => Promise<void>;
}

async function defaultGetEmbeddingStudentId(embeddingId: string): Promise<string | null> {
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.faceEmbedding.findUnique({
    where: { id: embeddingId },
    select: { studentId: true },
  });
  return row?.studentId ?? null;
}

/**
 * Phase 3 "deletion/deactivation capability." Deactivate is a soft delete:
 * the row remains for audit, but future recognition queries filter to
 * `isActive = true` so a deactivated sample is invisible to the pipeline.
 * A hard delete of biometric templates lives in a later phase (data-
 * retention policy).
 */
export async function deactivateFaceEmbeddingRequest(
  actor: SessionUser,
  embeddingId: string,
  deps: DeactivateFaceEmbeddingDeps = {},
): Promise<void> {
  requirePermission(actor, "faceEmbedding.manage");

  const getSid = deps.getEmbeddingStudentId ?? defaultGetEmbeddingStudentId;
  const studentId = await getSid(embeddingId);
  if (!studentId) throw new Error("face_embedding_not_found");

  const getStudent = deps.getStudentById ?? getStudentById;
  const student = await getStudent(studentId);
  if (!student) throw new Error("student_not_found");
  requireSameInstitution(actor, student.institutionId);

  const deactivateFn =
    deps.deactivateFaceEmbedding ??
    (async (id: string) => {
      const { deactivateFaceEmbedding } = await import("./repository");
      await deactivateFaceEmbedding(id);
    });
  await deactivateFn(embeddingId);

  const auditFn = deps.recordAuditLog ?? ((i: RecordAuditLogInput) => defaultRecordAuditLog(i));
  await auditFn({
    action: "face_enrollment.deactivated",
    entityType: "FaceEmbedding",
    entityId: embeddingId,
    institutionId: student.institutionId,
    actorUserId: actor.userId,
    afterJson: { studentId },
  });
}

export { ForbiddenError };
