-- Face templates become 128-dimensional.
--
-- WHY
--
-- SFace (`face_recognition_sface_2021dec.onnx`) emits a [1, 128] vector. That
-- was verified against the model graph itself during the Phase 4.5 audit, not
-- read off a model card. The column was `vector(512)` because the scaffold that
-- predated any model choice assumed an ArcFace-family 512-d recogniser.
--
-- Padding or randomly projecting 128 up to 512 to avoid this migration was
-- considered and rejected: it adds no information, quadruples storage and
-- comparison cost, and leaves a number in the schema that describes nothing
-- real.
--
-- HAND-WRITTEN, deliberately
--
-- `prisma migrate dev` emitted only the `embeddingDim` default below. Prisma has
-- no vector scalar, so `FaceEmbedding.embedding` is `Unsupported("vector(128)")`
-- and the differ treats it as opaque — it does not notice the width changed and
-- will not generate the ALTER. The same hand-patch was needed for the baseline
-- migration (see 20260917000000_init/migration.sql). Do not regenerate this file
-- and expect the vector statement to survive.
--
-- DATA LOSS PROFILE
--
-- This is destructive to any existing 512-d template, because a 512-d vector
-- cannot be reinterpreted as a 128-d one. It is safe here only because both the
-- local development database and production hold **zero** FaceEmbedding rows —
-- checked immediately before writing this migration. The guard below turns that
-- assumption into a check rather than a hope: if any row exists, the migration
-- aborts with an instruction instead of destroying biometric data.
--
-- REVERSIBILITY
--
-- Structurally reversible, semantically not. The down direction is:
--
--     ALTER TABLE "FaceEmbedding" ALTER COLUMN "embedding" TYPE vector(512);
--     ALTER TABLE "FaceEmbedding" ALTER COLUMN "embeddingDim" SET DEFAULT 512;
--
-- which restores the column width but cannot restore any vector, because a
-- 128-d template carries no 512-d original to return to. Reverting therefore
-- means re-enrolling every student, exactly as applying it does. Prisma has no
-- down-migration mechanism; this is recorded for an operator running it by hand.

-- Refuse rather than destroy. A wrong-length vector cannot be converted, and a
-- silent truncation of biometric data is not an acceptable failure mode.
DO $$
DECLARE
    existing_rows BIGINT;
BEGIN
    SELECT COUNT(*) INTO existing_rows FROM "FaceEmbedding";
    IF existing_rows > 0 THEN
        RAISE EXCEPTION
            'Refusing to change the face template width: % row(s) exist in "FaceEmbedding". '
            'A 512-dimensional vector cannot be converted to 128 dimensions — the values are '
            'not comparable and there is no correct conversion. Every affected student must be '
            're-enrolled under the new model. Retire the existing templates deliberately '
            '(see modules/face-enrollment retirement paths, which preserve the audit trail) '
            'before applying this migration.',
            existing_rows;
    END IF;
END $$;

-- The column width is the real enforcement: Postgres rejects an insert of the
-- wrong length outright, which is what makes the application-level length check
-- in modules/face-enrollment/repository.ts a better error message rather than
-- the actual guarantee.
--
-- No index depends on this column. There is deliberately no ANN (HNSW/IVFFlat)
-- index — nothing in the codebase uses the `<=>` operator, so one would have no
-- reader and only add write cost (docs/BENCHMARKS.md §4). If that ever changes,
-- the index must be rebuilt after this statement, not before.
ALTER TABLE "FaceEmbedding" ALTER COLUMN "embedding" TYPE vector(128);

-- AlterTable
ALTER TABLE "FaceEmbedding" ALTER COLUMN "embeddingDim" SET DEFAULT 128;
