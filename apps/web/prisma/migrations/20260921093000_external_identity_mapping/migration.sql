-- External identifiers, mapped rather than overloaded.
--
-- WHY
--
-- An ERP calls a student STU-10092; this platform calls them a cuid. Until now
-- the importer had nowhere to put the ERP's id except `Student.studentCode`,
-- which is the *institution's own* roll number — a different fact, editable by
-- the institution, and immediately contradicted the moment a second system is
-- integrated.
--
-- THE TWO UNIQUE KEYS
--
-- (institutionId, provider, entityType, externalId)
--   Two institutions using the same vendor will both have a student
--   "STU-10092", and they are different people. institutionId in the key makes
--   that representable instead of a collision. provider in the key lets one
--   institution run an ERP and an LMS without their id spaces colliding.
--
-- (institutionId, provider, entityType, internalId)
--   The reverse: one record has at most one id per provider, so "which id does
--   the ERP know this student by" cannot have two answers.
--
-- internalId is a plain column, not a foreign key: it is polymorphic across
-- four entity types and Prisma models no polymorphic relation. This platform
-- deactivates rather than deletes, and every read re-resolves the target, so a
-- dangling row surfaces as "not found" rather than as corruption.
--
-- Additive only. No existing table, column or row is touched, so this is safe
-- to apply to a populated database and there is nothing to back-fill.

-- CreateEnum
CREATE TYPE "ExternalEntityType" AS ENUM ('STUDENT', 'FACULTY', 'COHORT', 'SUBJECT');

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "entityType" "ExternalEntityType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalIdentity_institutionId_entityType_internalId_idx" ON "ExternalIdentity"("institutionId", "entityType", "internalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_institutionId_provider_entityType_external_key" ON "ExternalIdentity"("institutionId", "provider", "entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_institutionId_provider_entityType_internal_key" ON "ExternalIdentity"("institutionId", "provider", "entityType", "internalId");

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

