import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import type {
  FaceCaptureSource,
  FaceEnrollmentChannel,
  FaceSampleRecord,
  FaceSampleRetirementReason,
} from "./types";

// FaceEmbedding.embedding is Unsupported("vector(128)") in schema.prisma —
// Prisma's typed client cannot write it. All INSERT/UPDATE/DELETE that
// touch the vector column live in this file and go through $executeRaw so
// the pgvector operator/type coercions are all explicit.

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * pgvector's literal form: a bracketed, comma-separated list cast to `vector`
 * on the server. Built in one place because a vector that reaches SQL in the
 * wrong shape fails as an opaque driver error a long way from its cause.
 */
function vectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

export interface InsertFaceEmbeddingInput {
  institutionId: string;
  studentId: string;
  embedding: number[];
  modelName: string;
  modelVersion: string;
  embeddingDim: number;
  weightsVersion: string | null;
  preprocessingVersion: string | null;
  aligned: boolean | null;
  qualityScore: number | null;
  captureSource: FaceCaptureSource;
  channel: FaceEnrollmentChannel;
  enrolledByUserId: string | null;
  sourceImageUrl?: string | null;
}

/**
 * Inserts a FaceEmbedding row with the vector column populated via
 * pgvector's array-literal cast. Returns the created row's id so callers
 * can produce an audit trail without needing to re-read the row.
 */
export async function insertFaceEmbedding(
  input: InsertFaceEmbeddingInput,
  client: Client = prisma,
): Promise<{ id: string }> {
  // The column is vector(128), so a wrong-length vector is rejected by
  // Postgres anyway — but as an opaque driver error, after the write has
  // been attempted. Checking here names the actual problem (a model whose
  // output dimension does not match the schema) at the point a new backend
  // would introduce it.
  if (input.embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `face embedding has ${input.embedding.length} dimensions, expected ${EMBEDDING_DIMENSION}`,
    );
  }
  if (input.embeddingDim !== input.embedding.length) {
    throw new Error(
      `embeddingDim (${input.embeddingDim}) does not describe the vector being stored (${input.embedding.length})`,
    );
  }

  const id = randomUUID();

  // `createdAt` is written from the application clock rather than the
  // database's `NOW()`.
  //
  // A template's lifecycle now spans two columns, and `retiredAt` is written
  // by the Prisma client — which sends a JavaScript `Date`, and therefore a
  // UTC instant. `NOW()` returns the *session's* wall clock into a
  // `timestamp without time zone` column, so on any deployment whose Postgres
  // timezone is not UTC the two columns hold values on different clocks. The
  // symptom is a history view showing a template retired several hours before
  // it was created, and a retention sweep comparing ages that do not mean the
  // same thing. One clock per row removes the question entirely.
  //
  // The `::timestamptz AT TIME ZONE 'utc'` is load-bearing and not decoration.
  // A `Date` bound into `$executeRaw` reaches Postgres as an absolute instant,
  // and storing it in a `timestamp without time zone` column converts it to
  // the *session's* zone first — reintroducing exactly the bug this is fixing.
  // The cast pins the stored wall time to UTC, which is what Prisma's typed
  // client writes for the same column type, so both halves of the lifecycle
  // agree.
  const createdAt = new Date();

  await client.$executeRaw`
    INSERT INTO "FaceEmbedding" (
      id, "institutionId", "studentId", embedding, "modelName",
      "modelVersion", "weightsVersion", "preprocessingVersion", "embeddingDim",
      aligned, "qualityScore", "captureSource", channel, "enrolledByUserId",
      "sourceImageUrl", "isActive", "createdAt"
    ) VALUES (
      ${id}, ${input.institutionId}, ${input.studentId},
      ${vectorLiteral(input.embedding)}::vector, ${input.modelName},
      ${input.modelVersion}, ${input.weightsVersion}, ${input.preprocessingVersion},
      ${input.embeddingDim}, ${input.aligned}, ${input.qualityScore},
      ${input.captureSource}::"FaceCaptureSource", ${input.channel}::"FaceEnrollmentChannel",
      ${input.enrolledByUserId}, ${input.sourceImageUrl ?? null}, true,
      ${createdAt}::timestamptz AT TIME ZONE 'utc'
    )
  `;
  return { id };
}

export interface NearestTemplateRow {
  embeddingId: string;
  studentId: string;
  similarity: number;
}

/**
 * The templates nearest to a probe vector, within one institution.
 *
 * ## Why this is a database query and not a loop in Node
 *
 * Two reasons, and the second is the important one.
 *
 * The cheap reason: an institution can hold tens of thousands of templates,
 * and pulling a full template each across the wire to sort them in JavaScript
 * would make enrollment slower the bigger the institution gets.
 *
 * The real reason: this comparison is against *other students'* biometric
 * templates. Doing it in SQL means their vectors are read by Postgres and
 * never materialised in the application — what comes back is an id, a student
 * id and a number. A loop in Node would put every student's template in the
 * memory of the process that renders their classmate's enrollment page, for no
 * gain.
 *
 * ## Why no approximate index
 *
 * `<=>` without an HNSW/IVFFlat index is an exact sequential scan. That is
 * deliberate: this is a safety check, and an approximate index trades recall
 * for speed. A neighbour an ANN search happens to miss is a face quietly
 * enrolled under the wrong student — the precise failure the scan exists to
 * prevent. The migration that added the other indexes records the same
 * reasoning.
 *
 * ## Scoping
 *
 * `institutionId` is a required parameter and is always in the WHERE clause:
 * there is no variant of this function that searches across tenants. The model
 * filter is equally required — similarity between vectors from two different
 * models is not a number that means anything, and acting on it would refuse
 * honest enrollments at random.
 */
export async function findNearestTemplatesInInstitution(
  institutionId: string,
  probe: readonly number[],
  model: { modelName: string; modelVersion: string },
  limit: number,
  client: Client = prisma,
): Promise<NearestTemplateRow[]> {
  if (probe.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `probe vector has ${probe.length} dimensions, expected ${EMBEDDING_DIMENSION}`,
    );
  }

  const literal = vectorLiteral(probe);

  // `<=>` is pgvector's cosine *distance*, so similarity is 1 - distance. The
  // ORDER BY repeats the expression rather than sorting on the alias because
  // that is the form pgvector's planner recognises as a distance ordering.
  const rows = await client.$queryRaw<
    Array<{ embeddingId: string; studentId: string; similarity: number }>
  >`
    SELECT
      fe.id                                       AS "embeddingId",
      fe."studentId"                              AS "studentId",
      1 - (fe.embedding <=> ${literal}::vector)   AS similarity
    FROM "FaceEmbedding" fe
    WHERE fe."institutionId" = ${institutionId}
      AND fe."isActive" = TRUE
      AND fe.embedding IS NOT NULL
      AND fe."modelName" = ${model.modelName}
      AND fe."modelVersion" = ${model.modelVersion}
    ORDER BY fe.embedding <=> ${literal}::vector
    LIMIT ${limit}
  `;

  // Postgres returns the computed column as a numeric-ish value; Number() is
  // belt and braces for a driver that hands back a string.
  return rows.map((row) => ({
    embeddingId: row.embeddingId,
    studentId: row.studentId,
    similarity: Number(row.similarity),
  }));
}

/**
 * How similar a probe is to each of *this* student's own comparable templates.
 *
 * ## Why this is not a filter over `findNearestTemplatesInInstitution`
 *
 * That query returns the nearest few templates in the whole institution. The
 * student's own samples appear in it when the new photograph resembles them —
 * and are missing precisely when it does not, which is the case worth
 * catching. Reading "no own rows in the neighbour list" as "this student has
 * no samples" would make the mismatch check silently pass on every mismatch.
 *
 * Same privacy shape as the institution-wide scan: the comparison happens in
 * Postgres and what comes back is an id and a number. No vector is
 * materialised in the application. Scoped to the student, the institution and
 * the running model — similarity across models is not a meaningful number.
 */
export async function findOwnTemplateSimilarities(
  institutionId: string,
  studentId: string,
  probe: readonly number[],
  model: { modelName: string; modelVersion: string },
  client: Client = prisma,
): Promise<NearestTemplateRow[]> {
  if (probe.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `probe vector has ${probe.length} dimensions, expected ${EMBEDDING_DIMENSION}`,
    );
  }

  const literal = vectorLiteral(probe);
  const rows = await client.$queryRaw<
    Array<{ embeddingId: string; studentId: string; similarity: number }>
  >`
    SELECT
      fe.id                                       AS "embeddingId",
      fe."studentId"                              AS "studentId",
      1 - (fe.embedding <=> ${literal}::vector)   AS similarity
    FROM "FaceEmbedding" fe
    WHERE fe."institutionId" = ${institutionId}
      AND fe."studentId" = ${studentId}
      AND fe."isActive" = TRUE
      AND fe.embedding IS NOT NULL
      AND fe."modelName" = ${model.modelName}
      AND fe."modelVersion" = ${model.modelVersion}
    ORDER BY fe.embedding <=> ${literal}::vector
  `;

  return rows.map((row) => ({
    embeddingId: row.embeddingId,
    studentId: row.studentId,
    similarity: Number(row.similarity),
  }));
}

export function countActiveEmbeddingsForStudent(studentId: string): Promise<number> {
  return prisma.faceEmbedding.count({
    where: { studentId, isActive: true },
  });
}

/**
 * The model that produced each of a student's active templates.
 *
 * Feeds `summariseEnrollmentStatus`, which needs to know whether any stored
 * template can still be compared against what the deployment runs today. Two
 * columns and nothing else — the caller is counting, not listing.
 */
export function listActiveTemplateModelsForStudent(
  studentId: string,
): Promise<Array<{ modelName: string; modelVersion: string }>> {
  return prisma.faceEmbedding.findMany({
    where: { studentId, isActive: true },
    select: { modelName: true, modelVersion: true },
  });
}

/**
 * Metadata-only listing (no vectors) — safe to send to a UI. The embedding
 * column is deliberately never selected here; a caller that needs the raw
 * vector must go through a separate, permission-gated $queryRaw helper.
 */
export function listActiveEmbeddingMetadataForStudent(studentId: string) {
  return prisma.faceEmbedding.findMany({
    where: { studentId, isActive: true },
    select: {
      id: true,
      studentId: true,
      institutionId: true,
      modelName: true,
      modelVersion: true,
      embeddingDim: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Every template a student has ever had, live and retired, newest first.
 *
 * The enrollment history the phase brief asks for. Retired rows are included
 * because their absence is the thing worth seeing: "this student was enrolled
 * in September and somebody withdrew it in November" is a different situation
 * from "this student was never enrolled", and a list of active templates makes
 * the two identical.
 *
 * Selected field by field. `embedding` is not in the list and cannot be added
 * by accident — Prisma cannot type the column, so a `select` that named it
 * would not compile.
 */
export async function listSampleHistoryForStudent(
  studentId: string,
): Promise<FaceSampleRecord[]> {
  const rows = await prisma.faceEmbedding.findMany({
    where: { studentId },
    select: {
      id: true,
      createdAt: true,
      modelName: true,
      modelVersion: true,
      weightsVersion: true,
      preprocessingVersion: true,
      embeddingDim: true,
      aligned: true,
      qualityScore: true,
      captureSource: true,
      channel: true,
      isActive: true,
      retiredAt: true,
      retirementReason: true,
      enrolledBy: { select: { name: true } },
      retiredBy: { select: { name: true } },
    },
    // Live templates first, then by recency. An administrator opening this
    // page is nearly always asking "what is in use right now", and a retired
    // row from this morning should not sit above the template being used.
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    modelName: row.modelName,
    modelVersion: row.modelVersion,
    weightsVersion: row.weightsVersion,
    preprocessingVersion: row.preprocessingVersion,
    embeddingDim: row.embeddingDim,
    aligned: row.aligned,
    qualityScore: row.qualityScore,
    captureSource: row.captureSource,
    channel: row.channel,
    enrolledByName: row.enrolledBy?.name ?? null,
    isActive: row.isActive,
    retiredAt: row.retiredAt,
    retiredByName: row.retiredBy?.name ?? null,
    retirementReason: row.retirementReason,
  }));
}

export interface RetireTemplateInput {
  retiredByUserId: string | null;
  reason: FaceSampleRetirementReason;
}

/**
 * Retires one template.
 *
 * A soft delete: the row stays, `isActive` goes false, and who/when/why are
 * recorded. Recognition filters on `isActive`, so a retired template is
 * invisible to the pipeline from the next query onward while remaining
 * readable by the history view. Erasing biometric data outright is a separate,
 * deliberately separate path in `modules/privacy`.
 *
 * Scoped by `institutionId` as well as `id` — the caller has already checked
 * the tenant, and this makes a mistake there a no-op rather than a write.
 */
export async function retireTemplate(
  id: string,
  institutionId: string,
  input: RetireTemplateInput,
  client: Client = prisma,
): Promise<number> {
  const result = await client.faceEmbedding.updateMany({
    where: { id, institutionId, isActive: true },
    data: {
      isActive: false,
      retiredAt: new Date(),
      retiredByUserId: input.retiredByUserId,
      retirementReason: input.reason,
    },
  });
  return result.count;
}

/**
 * Retires every live template a student holds, and reports how many.
 *
 * The first half of a replacement. Runs inside the caller's transaction so a
 * failed insert cannot leave a student with nothing — see
 * `replaceFaceEnrollmentRequest`.
 */
export async function retireActiveTemplatesForStudent(
  studentId: string,
  institutionId: string,
  input: RetireTemplateInput,
  client: Client = prisma,
): Promise<number> {
  const result = await client.faceEmbedding.updateMany({
    where: { studentId, institutionId, isActive: true },
    data: {
      isActive: false,
      retiredAt: new Date(),
      retiredByUserId: input.retiredByUserId,
      retirementReason: input.reason,
    },
  });
  return result.count;
}

/**
 * The institution and student a template belongs to.
 *
 * Read before any write so the tenant check happens against the row's own
 * institution rather than against whatever the caller believed it to be.
 */
export function getTemplateOwner(
  embeddingId: string,
): Promise<{ studentId: string; institutionId: string } | null> {
  return prisma.faceEmbedding.findUnique({
    where: { id: embeddingId },
    select: { studentId: true, institutionId: true },
  });
}

/**
 * Runs `work` in a database transaction.
 *
 * Wrapped rather than used directly by the service so the service keeps no
 * import of the Prisma client, which is what lets every one of its tests run
 * without a database.
 */
export function inTransaction<T>(work: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(work);
}

/**
 * Retained for callers written before templates carried a reason.
 *
 * @deprecated Use `retireTemplate`, which records who retired a template and
 * why. Left in place because `modules/privacy` and the retention sweep import
 * it, and changing their behaviour is not this phase's business.
 */
export async function deactivateFaceEmbedding(id: string, client: Client = prisma): Promise<void> {
  await client.faceEmbedding.update({
    where: { id },
    data: { isActive: false },
  });
}
