-- Indexes for the query patterns the application actually issues.
--
-- Every statement below is traceable to a named read in the codebase; the
-- reasoning for each sits next to the corresponding @@index in
-- prisma/schema.prisma rather than being duplicated here. Three existing
-- single-column indexes are replaced by composites that lead with the same
-- column, so nothing loses coverage — a btree on (a, b) answers every query a
-- btree on (a) could.
--
-- DATA IMPACT: none. Indexes do not read, write or move row data. No column,
-- constraint, foreign key, default or enum is touched, so no application code
-- path changes behaviour and no value can be lost.
--
-- LOCKING: plain CREATE INDEX takes a SHARE lock, which blocks writes to the
-- table for the duration. Against the empty database this migration is being
-- authored for that is instantaneous. Against a populated production database
-- it is not — use the CONCURRENTLY procedure in docs/DATABASE_OPERATIONS.md
-- ("Applying index migrations to a live database") instead of running this file
-- directly.
--
-- ROLLBACK: fully reversible with no data loss. See the down-migration at the
-- foot of this file, kept as a comment because Prisma Migrate does not execute
-- down files.

-- CreateIndex
CREATE INDEX "CohortFaculty_userId_idx" ON "CohortFaculty"("userId");

-- CreateIndex
CREATE INDEX "StudentSubjectEnrollment_cohortSubjectId_idx" ON "StudentSubjectEnrollment"("cohortSubjectId");

-- CreateIndex
CREATE INDEX "Enrollment_cohortId_status_idx" ON "Enrollment"("cohortId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_institutionId_status_idx" ON "Enrollment"("institutionId", "status");

-- CreateIndex
CREATE INDEX "AttendanceSession_institutionId_status_sessionDate_idx" ON "AttendanceSession"("institutionId", "status", "sessionDate");

-- CreateIndex
CREATE INDEX "AttendanceSession_cohortId_sessionDate_idx" ON "AttendanceSession"("cohortId", "sessionDate");

-- CreateIndex
CREATE INDEX "AttendanceRecord_studentId_idx" ON "AttendanceRecord"("studentId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_matchedEmbeddingId_idx" ON "AttendanceRecord"("matchedEmbeddingId");

-- CreateIndex
CREATE INDEX "AuditLog_institutionId_createdAt_idx" ON "AuditLog"("institutionId", "createdAt" DESC);

-- DropIndex
-- Superseded by AttendanceSession_institutionId_status_sessionDate_idx above,
-- which leads with the same column.
DROP INDEX "AttendanceSession_institutionId_idx";

-- DropIndex
-- Superseded by AttendanceSession_cohortId_sessionDate_idx.
DROP INDEX "AttendanceSession_cohortId_idx";

-- DropIndex
-- Superseded by AuditLog_institutionId_createdAt_idx.
DROP INDEX "AuditLog_institutionId_idx";

-- ---------------------------------------------------------------------------
-- Down migration (not executed by Prisma; run by hand to revert)
--
--   CREATE INDEX "AuditLog_institutionId_idx" ON "AuditLog"("institutionId");
--   CREATE INDEX "AttendanceSession_cohortId_idx" ON "AttendanceSession"("cohortId");
--   CREATE INDEX "AttendanceSession_institutionId_idx" ON "AttendanceSession"("institutionId");
--   DROP INDEX "AuditLog_institutionId_createdAt_idx";
--   DROP INDEX "AttendanceRecord_matchedEmbeddingId_idx";
--   DROP INDEX "AttendanceRecord_studentId_idx";
--   DROP INDEX "AttendanceSession_cohortId_sessionDate_idx";
--   DROP INDEX "AttendanceSession_institutionId_status_sessionDate_idx";
--   DROP INDEX "Enrollment_institutionId_status_idx";
--   DROP INDEX "Enrollment_cohortId_status_idx";
--   DROP INDEX "StudentSubjectEnrollment_cohortSubjectId_idx";
--   DROP INDEX "CohortFaculty_userId_idx";
--
-- Reverting also requires reverting the matching @@index lines in
-- prisma/schema.prisma, or the next `prisma migrate dev` will regenerate this
-- migration as drift.
-- ---------------------------------------------------------------------------
