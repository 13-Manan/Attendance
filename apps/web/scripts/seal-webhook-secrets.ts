/**
 * Encrypts webhook signing secrets that are still stored in plaintext.
 *
 * ## Why this is a script and not a SQL migration
 *
 * Because the transformation needs the application's encryption key, and a
 * `.sql` file has no access to it. It is also not the kind of thing to do
 * blind: each row is encrypted, decrypted again, and compared against what it
 * started as *before* the new value is written. A secret that seals but does
 * not open is an endpoint that silently stops producing verifiable
 * signatures, and the integrator finds out days later when nothing they
 * receive validates.
 *
 * ## Safety
 *
 * - Idempotent. Already-sealed rows are skipped, so re-running is harmless.
 * - Verify-before-replace. Nothing is overwritten until the round trip is
 *   proven for that exact value.
 * - One row at a time. A failure stops the run with the remaining rows
 *   untouched rather than leaving a half-converted table.
 * - Never prints a secret, sealed or plaintext.
 *
 * ## Running it
 *
 *   WEBHOOK_SECRET_KEK=... DATABASE_URL=... \
 *     node --import ./scripts/register-test-loader.mjs ./scripts/seal-webhook-secrets.ts
 *
 * With no `WEBHOOK_SECRET_KEK` the key is derived from `AUTH_SECRET`; see
 * `lib/secret-box.ts` for why that is an acceptable default and why an
 * explicit key is preferred in production.
 *
 * `--dry-run` reports what would change and writes nothing.
 */
import { prisma } from "@/lib/prisma";
import { isSealed, sealSecret, verifySeal } from "@/lib/secret-box";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const rows = await prisma.webhookEndpoint.findMany({
    select: { id: true, secret: true, institutionId: true },
  });

  let sealed = 0;
  let alreadySealed = 0;
  let failed = 0;

  for (const row of rows) {
    if (isSealed(row.secret)) {
      alreadySealed++;
      continue;
    }

    const candidate = sealSecret(row.secret);
    if (!verifySeal(row.secret, candidate)) {
      // Stop. A key that cannot round-trip its own output is misconfigured,
      // and converting the rest of the table under it would destroy them all.
      failed++;
      console.error(
        `endpoint ${row.id}: sealed value did not decrypt back to the original — stopping.`,
      );
      break;
    }

    if (!dryRun) {
      await prisma.webhookEndpoint.update({
        where: { id: row.id },
        data: { secret: candidate },
      });
    }
    sealed++;
  }

  console.log(
    JSON.stringify({
      dryRun,
      total: rows.length,
      sealed,
      alreadySealed,
      failed,
    }),
  );

  if (failed > 0) process.exitCode = 1;
}

await main();
await prisma.$disconnect();
