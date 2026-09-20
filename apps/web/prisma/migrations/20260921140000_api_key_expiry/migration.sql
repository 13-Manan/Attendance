-- API keys may carry an expiry.
--
-- WHY
--
-- Rotation was issue-then-revoke, which works but requires somebody to
-- remember the second step. An expiry makes a key that was issued for a
-- one-off migration or a trial integration stop on its own.
--
-- NULLABLE, AND NULL FOR EVERY EXISTING ROW
--
-- Every key issued before this column existed has no expiry and keeps
-- working. Back-filling a date would silently switch off live integrations to
-- tidy up a schema, which is an outage rather than a hardening.
--
-- An expired key is refused with the same 401 as a revoked one, so the API
-- does not tell a caller which of the two happened.
--
-- Additive only. No existing column or row is altered.

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMP(3);

