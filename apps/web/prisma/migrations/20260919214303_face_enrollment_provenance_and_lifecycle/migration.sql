-- Phase 3 (student face enrollment): provenance and lifecycle for a template.
--
-- Additive only. Every column added here is nullable, no column is dropped,
-- renamed or re-typed, and the vector column is not touched — so this applies
-- to a populated production database without rewriting a table of biometric
-- data and without a window.
--
-- ## No backfill, deliberately
--
-- Rows written before this migration were produced by a pipeline that did not
-- record which weights, which preprocessing, whether the crop was aligned, or
-- who pressed the button. A default would make every one of those rows assert
-- something nobody checked, and these are the columns an investigation into a
-- wrong template would rely on. NULL means "not recorded", and
-- `modules/face-enrollment/status.ts` reads it as a reason to re-enrol rather
-- than as a fact about the capture.
--
-- The same argument covers `retiredAt` on rows that are already
-- `isActive = false`: we do not know when they were deactivated, and inventing
-- a timestamp would put a date in an audit view that nothing observed.
--
-- ## Indexes
--
-- `(institutionId, isActive)` serves the duplicate scan, which asks for one
-- institution's live templates. `(studentId, isActive)` serves the per-student
-- history, which asks for live and retired together and orders within one
-- student. The two foreign-key indexes exist because Postgres does not create
-- them on its own and both columns are joined when the history view names the
-- person who acted.
--
-- Deliberately NOT added: an HNSW/IVFFlat index on `embedding`. The duplicate
-- scan is a safety check, and an approximate index trades recall for speed —
-- a missed neighbour there means a face silently enrolled under the wrong
-- student, which is the exact failure the scan exists to prevent. The scan is
-- an exact, institution-scoped, model-filtered sequential comparison with a
-- bounded pool; see `findNearestTemplatesInInstitution`.

-- CreateEnum
CREATE TYPE "FaceCaptureSource" AS ENUM ('CAMERA', 'UPLOAD');

-- CreateEnum
CREATE TYPE "FaceEnrollmentChannel" AS ENUM ('STAFF', 'SELF');

-- CreateEnum
CREATE TYPE "FaceSampleRetirementReason" AS ENUM ('REPLACED', 'WITHDRAWN', 'RETENTION', 'STUDENT_INACTIVE');

-- AlterTable
ALTER TABLE "FaceEmbedding" ADD COLUMN     "aligned" BOOLEAN,
ADD COLUMN     "captureSource" "FaceCaptureSource",
ADD COLUMN     "channel" "FaceEnrollmentChannel",
ADD COLUMN     "enrolledByUserId" TEXT,
ADD COLUMN     "preprocessingVersion" TEXT,
ADD COLUMN     "qualityScore" DOUBLE PRECISION,
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "retiredByUserId" TEXT,
ADD COLUMN     "retirementReason" "FaceSampleRetirementReason",
ADD COLUMN     "weightsVersion" TEXT;

-- CreateIndex
CREATE INDEX "FaceEmbedding_institutionId_isActive_idx" ON "FaceEmbedding"("institutionId", "isActive");

-- CreateIndex
CREATE INDEX "FaceEmbedding_studentId_isActive_idx" ON "FaceEmbedding"("studentId", "isActive");

-- CreateIndex
CREATE INDEX "FaceEmbedding_enrolledByUserId_idx" ON "FaceEmbedding"("enrolledByUserId");

-- CreateIndex
CREATE INDEX "FaceEmbedding_retiredByUserId_idx" ON "FaceEmbedding"("retiredByUserId");

-- AddForeignKey
ALTER TABLE "FaceEmbedding" ADD CONSTRAINT "FaceEmbedding_enrolledByUserId_fkey" FOREIGN KEY ("enrolledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceEmbedding" ADD CONSTRAINT "FaceEmbedding_retiredByUserId_fkey" FOREIGN KEY ("retiredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
