-- Gallery-backed face samples (Azure AI Face).
--
-- WHY
--
-- A gallery provider does not hand back a vector. It stores the template
-- itself, in a per-class gallery, and answers "who is this?" by person id. So a
-- sample enrolled under such a provider has no `embedding` to store: the row
-- keeps every piece of provenance and lifecycle metadata it always had, and
-- the pointer into the provider lives in "FaceGalleryPlacement".
--
-- ADDITIVE ONLY
--
-- Every existing row has a vector, so relaxing NOT NULL changes none of them.
-- Recognition and the duplicate scan already filter candidates by the running
-- model, so a vector row and a gallery row are never compared with each other
-- — the old SFace/mock templates stay exactly what they were, and are not
-- presented as Azure templates. No existing attendance record is touched.
--
-- The CHECK below is the part Prisma cannot express: a row either carries a
-- vector or declares itself vector-less with "embeddingDim" = 0. A vector row
-- written without its vector is rejected by Postgres, as it was before.
--
-- REVERSIBILITY
--
--     DROP TABLE "FaceGalleryPlacement";
--     ALTER TABLE "FaceEmbedding" DROP CONSTRAINT "FaceEmbedding_template_present";
--     DELETE FROM "FaceEmbedding" WHERE "embedding" IS NULL;  -- gallery samples
--     ALTER TABLE "FaceEmbedding" ALTER COLUMN "embedding" SET NOT NULL;
--
-- The DELETE is only needed once gallery samples exist, and the provider-side
-- faces should be removed first (see modules/face-gallery).

-- AlterTable
ALTER TABLE "FaceEmbedding" ALTER COLUMN "embedding" DROP NOT NULL;

ALTER TABLE "FaceEmbedding"
  ADD CONSTRAINT "FaceEmbedding_template_present"
  CHECK ("embedding" IS NOT NULL OR "embeddingDim" = 0);

-- CreateTable
CREATE TABLE "FaceGalleryPlacement" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "faceEmbeddingId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "galleryId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "persistedFaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceGalleryPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FaceGalleryPlacement_faceEmbeddingId_idx" ON "FaceGalleryPlacement"("faceEmbeddingId");

-- CreateIndex
CREATE INDEX "FaceGalleryPlacement_galleryId_personId_idx" ON "FaceGalleryPlacement"("galleryId", "personId");

-- CreateIndex
CREATE INDEX "FaceGalleryPlacement_studentId_idx" ON "FaceGalleryPlacement"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "FaceGalleryPlacement_galleryId_persistedFaceId_key" ON "FaceGalleryPlacement"("galleryId", "persistedFaceId");

-- AddForeignKey
ALTER TABLE "FaceGalleryPlacement" ADD CONSTRAINT "FaceGalleryPlacement_faceEmbeddingId_fkey" FOREIGN KEY ("faceEmbeddingId") REFERENCES "FaceEmbedding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
