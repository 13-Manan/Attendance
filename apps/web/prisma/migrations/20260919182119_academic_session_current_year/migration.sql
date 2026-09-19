-- Phase 2: the current academic year.
--
-- Additive only. One new NOT NULL column with a default, so every existing row
-- is valid the moment it is added and no table is rewritten in a way that
-- changes what a row means.
--
-- `isCurrent` is not `isActive`. An institution routinely has two un-archived
-- sessions at once — the one running and the one it has already set up for
-- next year — so the year that is *current* has to be its own fact. At most
-- one per institution; that is enforced in a transaction by
-- `setCurrentAcademicSessionForRequest`, because Postgres could express it as
-- a partial unique index but Prisma cannot declare one, and a schema whose
-- constraints live in two places is a schema nobody can read.

-- AlterTable
ALTER TABLE "AcademicSession" ADD COLUMN     "isCurrent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: give every institution that already has an un-archived session a
-- sensible current year, so nobody logs in after this deploy to be told they
-- have no academic year at all.
--
-- The session running today wins. If none is (the gap between two years, or an
-- institution that has only ever set up a future one), the most recently
-- started is marked instead — a guess, and one an administrator changes in a
-- single click on the sessions page. Exactly one row per institution is
-- touched, and no row's existing data changes.
UPDATE "AcademicSession" AS s
SET "isCurrent" = true
FROM (
  SELECT DISTINCT ON ("institutionId") "id"
  FROM "AcademicSession"
  WHERE "isActive" = true
  ORDER BY
    "institutionId",
    ((now() AT TIME ZONE 'utc') BETWEEN "startDate" AND "endDate") DESC,
    "startDate" DESC,
    "createdAt" DESC
) AS pick
WHERE s."id" = pick."id";
