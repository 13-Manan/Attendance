-- Institutions can be suspended.
--
-- WHY
--
-- `platform.institution.suspend` has existed in the permission catalogue
-- since the role model was written, and nothing consumed it because there was
-- no column to write. The platform admin dashboard is the first surface that
-- needs it.
--
-- A TIMESTAMP, NOT A BOOLEAN
--
-- "When did this tenant stop being served" is the question asked during an
-- incident, and a boolean cannot answer it.
--
-- NULLABLE, AND NULL FOR EVERY EXISTING ROW
--
-- An institution created before this column existed is active, not in an
-- unknown state. Nothing is back-filled and no default is applied.
--
-- NOT A DELETE
--
-- Suspension is reversible and cascades to nothing. Attendance records, audit
-- history and enrolments all remain; what it expresses is that the tenant
-- should stop being served, which is a decision somebody may reverse tomorrow.
--
-- Additive only. No existing column or row is altered.

-- AlterTable
ALTER TABLE "Institution" ADD COLUMN     "suspendedAt" TIMESTAMP(3);

