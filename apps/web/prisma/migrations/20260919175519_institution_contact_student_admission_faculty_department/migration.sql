-- Phase 2 (academic / institution management).
--
-- Additive only. Every column added here is nullable, no column is dropped,
-- renamed or re-typed, and no existing row changes meaning — so this applies
-- to a populated production database without a backfill and without a window.
--
--   Institution.contactEmail / contactPhone / addressLine
--     The institution's own contact details. Columns rather than keys inside
--     `Institution.settings`, because everything in that JSON changes how the
--     product behaves and these do not.
--
--   Student.admissionNumber / admissionDate
--     The admission record. Deliberately not unique: some institutions reuse a
--     number on re-admission, and a constraint a clerk has to work around with
--     a fake value is worse than no constraint.
--
--   User.departmentId -> AcademicUnit(id)
--     Which department a college faculty member belongs to. ON DELETE SET NULL
--     so removing a department never deletes a member of staff. The index is
--     explicit because Postgres does not index a foreign key on its own and the
--     faculty directory filters on this column.

-- AlterTable
ALTER TABLE "Institution" ADD COLUMN     "addressLine" TEXT,
ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "contactPhone" TEXT;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "admissionDate" TIMESTAMP(3),
ADD COLUMN     "admissionNumber" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "departmentId" TEXT;

-- CreateIndex
CREATE INDEX "User_departmentId_idx" ON "User"("departmentId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "AcademicUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
