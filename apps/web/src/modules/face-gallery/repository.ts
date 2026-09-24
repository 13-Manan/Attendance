import type { Prisma, PrismaClient } from "@prisma/client";
import type { GalleryPlacement } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import type { FaceCaptureSource, FaceEnrollmentChannel } from "@/modules/face-enrollment/types";
import type { PlacementRow } from "./policy";

type Client = PrismaClient | Prisma.TransactionClient;

interface ModelKey {
  modelName: string;
  modelVersion: string;
}

/** The classes a student is actively enrolled in — the galleries a new sample
 * is added to. */
export async function listActiveCohortIdsForStudent(studentId: string): Promise<string[]> {
  const rows = await prisma.enrollment.findMany({
    where: { studentId, status: "ACTIVE" },
    select: { cohortId: true },
    orderBy: { cohortId: "asc" },
  });
  return rows.map((r) => r.cohortId);
}

/**
 * The provider person already representing this student in each gallery,
 * under the running model. Only placements of *active* samples count: a
 * person whose samples were all retired is on its way out.
 */
export async function listActivePersonsForStudent(
  studentId: string,
  model: ModelKey,
): Promise<Map<string, string>> {
  const rows = await prisma.faceGalleryPlacement.findMany({
    where: {
      studentId,
      faceEmbedding: { isActive: true, ...model },
    },
    select: { galleryId: true, personId: true },
    orderBy: { createdAt: "asc" },
  });
  const byGallery = new Map<string, string>();
  for (const row of rows) {
    if (!byGallery.has(row.galleryId)) byGallery.set(row.galleryId, row.personId);
  }
  return byGallery;
}

/** Which student a provider person belongs to, for naming a collision. */
export async function findStudentForPerson(
  institutionId: string,
  galleryId: string,
  personId: string,
): Promise<string | null> {
  const row = await prisma.faceGalleryPlacement.findFirst({
    where: { institutionId, galleryId, personId },
    select: { studentId: true },
  });
  return row?.studentId ?? null;
}

export interface InsertGallerySampleInput {
  institutionId: string;
  studentId: string;
  modelName: string;
  modelVersion: string;
  qualityScore: number | null;
  captureSource: FaceCaptureSource;
  channel: FaceEnrollmentChannel;
  enrolledByUserId: string | null;
  /** galleryId → cohortId, for the placement rows. */
  cohortOfGallery: ReadonlyMap<string, string>;
  placements: readonly GalleryPlacement[];
}

/**
 * One sample row with no vector, and its placements, in one write.
 *
 * `embeddingDim` 0 is what the table's CHECK constraint demands of a row
 * without a vector. `weightsVersion`/`preprocessingVersion` are left null:
 * the provider does not report them separately from `modelVersion`.
 */
export async function insertGallerySample(
  input: InsertGallerySampleInput,
  client: Client = prisma,
): Promise<{ id: string }> {
  const row = await client.faceEmbedding.create({
    data: {
      institutionId: input.institutionId,
      studentId: input.studentId,
      modelName: input.modelName,
      modelVersion: input.modelVersion,
      embeddingDim: 0,
      qualityScore: input.qualityScore,
      captureSource: input.captureSource,
      channel: input.channel,
      enrolledByUserId: input.enrolledByUserId,
      sourceImageUrl: null,
    },
    select: { id: true },
  });
  await client.faceGalleryPlacement.createMany({
    data: input.placements.map((p) => {
      const cohortId = input.cohortOfGallery.get(p.galleryId);
      if (!cohortId) throw new Error("gallery_without_cohort");
      return {
        institutionId: input.institutionId,
        faceEmbeddingId: row.id,
        studentId: input.studentId,
        cohortId,
        galleryId: p.galleryId,
        personId: p.personId,
        persistedFaceId: p.persistedFaceId,
      };
    }),
  });
  return row;
}

/** Every placement of these students in one institution, with whether its
 * sample is still active. The input to `planGalleryRemovals`. */
export async function listPlacementsForStudents(
  institutionId: string,
  studentIds: readonly string[],
): Promise<Array<PlacementRow & { faceEmbeddingId: string }>> {
  if (studentIds.length === 0) return [];
  const rows = await prisma.faceGalleryPlacement.findMany({
    where: { institutionId, studentId: { in: [...studentIds] } },
    select: {
      id: true,
      galleryId: true,
      personId: true,
      persistedFaceId: true,
      faceEmbeddingId: true,
      faceEmbedding: { select: { isActive: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    galleryId: r.galleryId,
    personId: r.personId,
    persistedFaceId: r.persistedFaceId,
    faceEmbeddingId: r.faceEmbeddingId,
    active: r.faceEmbedding.isActive,
  }));
}

export async function deletePlacements(institutionId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prisma.faceGalleryPlacement.deleteMany({
    where: { institutionId, id: { in: [...ids] } },
  });
  return result.count;
}

export interface GalleryCandidate {
  personId: string;
  studentId: string;
  /** One of the student's active samples in this gallery. */
  faceEmbeddingId: string;
}

/**
 * The people a class gallery may name, resolved to students.
 *
 * The same scoping rule as the vector loaders in
 * `recognition-results/repository.ts`: only students *actively enrolled* in
 * this cohort (and, for a subject session, in that subject) are candidates.
 * A person in the gallery who has since left the class resolves to nobody,
 * so a stale provider-side face can never mark a student who does not belong
 * in the room. Only active samples under the running model count.
 */
export async function findGalleryCandidates(
  galleryId: string,
  scope: { cohortId: string; cohortSubjectId?: string },
  model: ModelKey,
): Promise<GalleryCandidate[]> {
  const rows = await prisma.faceGalleryPlacement.findMany({
    where: {
      galleryId,
      cohortId: scope.cohortId,
      faceEmbedding: {
        isActive: true,
        ...model,
        student: {
          enrollments: { some: { cohortId: scope.cohortId, status: "ACTIVE" } },
          ...(scope.cohortSubjectId
            ? { subjectEnrollments: { some: { cohortSubjectId: scope.cohortSubjectId } } }
            : {}),
        },
      },
    },
    select: { personId: true, studentId: true, faceEmbeddingId: true },
    orderBy: [{ personId: "asc" }, { createdAt: "asc" }],
  });
  const seen = new Set<string>();
  const out: GalleryCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.personId)) continue;
    seen.add(row.personId);
    out.push(row);
  }
  return out;
}
