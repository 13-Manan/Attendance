import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";

// FaceEmbedding.embedding is Unsupported("vector(512)") in schema.prisma —
// Prisma's typed client cannot write it. All INSERT/UPDATE/DELETE that
// touch the vector column live in this file and go through $executeRaw so
// the pgvector operator/type coercions are all explicit.

type Client = PrismaClient | Prisma.TransactionClient;

export interface InsertFaceEmbeddingInput {
  institutionId: string;
  studentId: string;
  embedding: number[];
  modelName: string;
  modelVersion: string;
  embeddingDim: number;
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
  // The column is vector(512), so a wrong-length vector is rejected by
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
  // pgvector expects a bracketed, comma-separated literal ('[a,b,c]') that
  // we cast to vector on the server side.
  const literal = `[${input.embedding.join(",")}]`;

  await client.$executeRaw`
    INSERT INTO "FaceEmbedding" (
      id, "institutionId", "studentId", embedding, "modelName",
      "modelVersion", "embeddingDim", "sourceImageUrl", "isActive", "createdAt"
    ) VALUES (
      ${id}, ${input.institutionId}, ${input.studentId},
      ${literal}::vector, ${input.modelName}, ${input.modelVersion},
      ${input.embeddingDim}, ${input.sourceImageUrl ?? null}, true, NOW()
    )
  `;
  return { id };
}

export function countActiveEmbeddingsForStudent(studentId: string): Promise<number> {
  return prisma.faceEmbedding.count({
    where: { studentId, isActive: true },
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

export async function deactivateFaceEmbedding(
  id: string,
  client: Client = prisma,
): Promise<void> {
  await client.faceEmbedding.update({
    where: { id },
    data: { isActive: false },
  });
}
