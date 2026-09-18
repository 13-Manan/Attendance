-- Baseline migration: the entire schema as of Phase 15, from an empty database.
--
-- Generated with
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- and then hand-patched in exactly two places, both of which the schema header
-- in prisma/schema.prisma has always said would be needed:
--
--   1. CREATE EXTENSION vector, immediately below. Prisma has no vector scalar,
--      so "FaceEmbedding"."embedding" is declared Unsupported("vector(512)")
--      and the generated SQL emits `vector(512)` without ever creating the type.
--      Without this statement the CREATE TABLE fails with `type "vector" does
--      not exist`.
--   2. role_key_platform_unique, at the foot of the file. Postgres does not
--      treat two NULLs as equal, so @@unique([institutionId, key]) on "Role"
--      does not stop two platform-wide (institutionId IS NULL) roles sharing a
--      key. A partial unique index does.
--
-- Nothing else was altered. This migration only creates; it drops nothing and
-- alters nothing, so it is non-destructive by construction and safe to apply to
-- an empty database. It is NOT safe to apply to a database that already has
-- these tables -- see docs/DATABASE_OPERATIONS.md, "Adopting an existing
-- database", for the baseline-resolve procedure.

-- CreateExtension
-- pgvector. Must exist before any CREATE TABLE that uses the `vector` type.
-- Requires a server with the pgvector extension installed (see
-- docs/DATABASE_OPERATIONS.md); the Docker image pgvector/pgvector:pg16 used by
-- the repository's docker-compose.yml ships with it.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('SCHOOL', 'COLLEGE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AcademicUnitKind" AS ENUM ('DEPARTMENT', 'GRADE', 'SEMESTER', 'COURSE', 'SECTION', 'GENERIC');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TRANSFERRED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('OPEN', 'CAPTURING', 'PROCESSING', 'REVIEW', 'FINALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceResult" AS ENUM ('PRESENT', 'ABSENT', 'NEEDS_REVIEW', 'NOT_EVALUATED');

-- CreateEnum
CREATE TYPE "CorrectionSource" AS ENUM ('FACULTY_REVIEW', 'ROLL_CALL', 'ADMIN_OVERRIDE', 'PUBLIC_API');

-- CreateEnum
CREATE TYPE "CohortFacultyRole" AS ENUM ('PRIMARY', 'ASSISTANT');

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "InstitutionType" NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT,
    "campusId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "employeeCode" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "institutionId" TEXT,
    "campusId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "campusId" TEXT,
    "userId" TEXT,
    "studentCode" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicUnit" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "campusId" TEXT,
    "parentId" TEXT,
    "kind" "AcademicUnitKind" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicSession" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cohort" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "academicUnitId" TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "termLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortFaculty" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CohortFacultyRole" NOT NULL DEFAULT 'PRIMARY',

    CONSTRAINT "CohortFaculty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortSubject" (
    "id" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "facultyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CohortSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentSubjectEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "cohortSubjectId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentSubjectEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unenrolledAt" TIMESTAMP(3),

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSession" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "cohortSubjectId" TEXT,
    "facultyId" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" "SessionStatus" NOT NULL DEFAULT 'OPEN',
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AttendanceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionImage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceEmbedding" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "embedding" vector(512) NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "embeddingDim" INTEGER NOT NULL DEFAULT 512,
    "sourceImageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceRecord" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "aiResult" "AttendanceResult" NOT NULL DEFAULT 'NOT_EVALUATED',
    "aiConfidence" DOUBLE PRECISION,
    "matchedEmbeddingId" TEXT,
    "finalResult" "AttendanceResult" NOT NULL DEFAULT 'NOT_EVALUATED',
    "isManuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "previousResult" "AttendanceResult" NOT NULL,
    "newResult" "AttendanceResult" NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "source" "CorrectionSource" NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT,
    "actorUserId" TEXT,
    "actorApiKeyId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campus_institutionId_idx" ON "Campus"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Campus_institutionId_code_key" ON "Campus"("institutionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_institutionId_idx" ON "User"("institutionId");

-- CreateIndex
CREATE INDEX "User_campusId_idx" ON "User"("campusId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Role_institutionId_idx" ON "Role"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_institutionId_key_key" ON "Role"("institutionId", "key");

-- CreateIndex
CREATE INDEX "RolePermission_roleId_idx" ON "RolePermission"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permission_key" ON "RolePermission"("roleId", "permission");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_userId_idx" ON "UserRoleAssignment"("userId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_institutionId_idx" ON "UserRoleAssignment"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRoleAssignment_userId_roleId_institutionId_campusId_key" ON "UserRoleAssignment"("userId", "roleId", "institutionId", "campusId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_institutionId_studentCode_key" ON "Student"("institutionId", "studentCode");

-- CreateIndex
CREATE INDEX "AcademicUnit_institutionId_idx" ON "AcademicUnit"("institutionId");

-- CreateIndex
CREATE INDEX "AcademicUnit_parentId_idx" ON "AcademicUnit"("parentId");

-- CreateIndex
CREATE INDEX "AcademicSession_institutionId_idx" ON "AcademicSession"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicSession_institutionId_name_key" ON "AcademicSession"("institutionId", "name");

-- CreateIndex
CREATE INDEX "Cohort_institutionId_idx" ON "Cohort"("institutionId");

-- CreateIndex
CREATE INDEX "Cohort_academicUnitId_idx" ON "Cohort"("academicUnitId");

-- CreateIndex
CREATE INDEX "Cohort_academicSessionId_idx" ON "Cohort"("academicSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortFaculty_cohortId_userId_key" ON "CohortFaculty"("cohortId", "userId");

-- CreateIndex
CREATE INDEX "Subject_institutionId_idx" ON "Subject"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_institutionId_code_key" ON "Subject"("institutionId", "code");

-- CreateIndex
CREATE INDEX "CohortSubject_cohortId_idx" ON "CohortSubject"("cohortId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortSubject_cohortId_subjectId_key" ON "CohortSubject"("cohortId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentSubjectEnrollment_studentId_cohortSubjectId_key" ON "StudentSubjectEnrollment"("studentId", "cohortSubjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_studentId_cohortId_key" ON "Enrollment"("studentId", "cohortId");

-- CreateIndex
CREATE INDEX "AttendanceSession_institutionId_idx" ON "AttendanceSession"("institutionId");

-- CreateIndex
CREATE INDEX "AttendanceSession_cohortId_idx" ON "AttendanceSession"("cohortId");

-- CreateIndex
CREATE INDEX "AttendanceSession_cohortSubjectId_idx" ON "AttendanceSession"("cohortSubjectId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionImage_sessionId_sequenceNumber_key" ON "SessionImage"("sessionId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "FaceEmbedding_institutionId_idx" ON "FaceEmbedding"("institutionId");

-- CreateIndex
CREATE INDEX "FaceEmbedding_studentId_idx" ON "FaceEmbedding"("studentId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_institutionId_idx" ON "AttendanceRecord"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_sessionId_studentId_key" ON "AttendanceRecord"("sessionId", "studentId");

-- CreateIndex
CREATE INDEX "AttendanceCorrection_attendanceRecordId_idx" ON "AttendanceCorrection"("attendanceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");

-- CreateIndex
CREATE INDEX "ApiKey_institutionId_idx" ON "ApiKey"("institutionId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_institutionId_idx" ON "WebhookEndpoint"("institutionId");

-- CreateIndex
CREATE INDEX "AuditLog_institutionId_idx" ON "AuditLog"("institutionId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Campus" ADD CONSTRAINT "Campus_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicUnit" ADD CONSTRAINT "AcademicUnit_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicUnit" ADD CONSTRAINT "AcademicUnit_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademicUnit" ADD CONSTRAINT "AcademicUnit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AcademicUnit"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AcademicSession" ADD CONSTRAINT "AcademicSession_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_academicUnitId_fkey" FOREIGN KEY ("academicUnitId") REFERENCES "AcademicUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_academicSessionId_fkey" FOREIGN KEY ("academicSessionId") REFERENCES "AcademicSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortFaculty" ADD CONSTRAINT "CohortFaculty_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortFaculty" ADD CONSTRAINT "CohortFaculty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortSubject" ADD CONSTRAINT "CohortSubject_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortSubject" ADD CONSTRAINT "CohortSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortSubject" ADD CONSTRAINT "CohortSubject_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubjectEnrollment" ADD CONSTRAINT "StudentSubjectEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubjectEnrollment" ADD CONSTRAINT "StudentSubjectEnrollment_cohortSubjectId_fkey" FOREIGN KEY ("cohortSubjectId") REFERENCES "CohortSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_cohortSubjectId_fkey" FOREIGN KEY ("cohortSubjectId") REFERENCES "CohortSubject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionImage" ADD CONSTRAINT "SessionImage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendanceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceEmbedding" ADD CONSTRAINT "FaceEmbedding_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AttendanceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_matchedEmbeddingId_fkey" FOREIGN KEY ("matchedEmbeddingId") REFERENCES "FaceEmbedding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CreateIndex
-- Platform-wide system roles are the rows with institutionId IS NULL. The
-- compound unique above cannot constrain them, because `institutionId = NULL`
-- is never true in SQL and Postgres therefore considers every such row
-- distinct. Without this index the seed could create a second STUDENT role on
-- its second run and permission lookups would silently resolve to whichever one
-- Postgres happened to return first. prisma/seed.ts documents the matching
-- find-then-write behaviour on the application side.
CREATE UNIQUE INDEX "role_key_platform_unique" ON "Role"("key") WHERE "institutionId" IS NULL;
