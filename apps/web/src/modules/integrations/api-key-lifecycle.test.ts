import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";

/**
 * Loaded lazily, inside the guarded hooks.
 *
 * `api-key-auth.ts` imports `lib/env`, which parses the environment at module
 * load and throws without a DATABASE_URL. A top-level import would therefore
 * blow up the whole file before `skip` could take effect, turning "skipped
 * because no database" into a hard failure for everyone running the plain
 * unit suite.
 */
type AuthModule = typeof import("./api-key-auth.ts");
let auth: AuthModule;

/**
 * Phase 11 — an API key's whole life, against a real database.
 *
 * Revocation and expiry are the two ways a key stops working, and both have
 * to be enforced at the point of authentication rather than by a UI that
 * stops listing it. The tests are database-backed because the enforcement is
 * a row read: a stubbed repository would happily agree with whatever the
 * service believed.
 *
 * The property tying them together is that a refused key never says *why*.
 * "Revoked" and "expired" both mean a key that once existed, and confirming
 * that to whoever now holds it is a disclosure on its own.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INSTITUTION = "apikey-life-inst";

async function cleanup() {
  await prisma.apiKey.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.institution.deleteMany({ where: { id: INSTITUTION } });
}

before(async () => {
  if (SKIP) return;
  auth = await import("./api-key-auth.ts");
  await cleanup();
  await prisma.institution.create({
    data: { id: INSTITUTION, name: "Key Lifecycle", type: "SCHOOL" },
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

/** `authenticateApiKey` reads the header off a Request, as a route does. */
function asRequest(authorization: string | null): Request {
  return new Request("https://example.test/api/v1/students", {
    headers: authorization === null ? {} : { Authorization: authorization },
  });
}

/** Issues a real key row and returns the plaintext only the caller ever sees. */
async function issue(overrides: { expiresAt?: Date | null; revokedAt?: Date | null } = {}) {
  const { rawKey, hashedKey } = auth.generateApiKey();
  const row = await prisma.apiKey.create({
    data: {
      institutionId: INSTITUTION,
      name: `k-${Math.random().toString(36).slice(2, 8)}`,
      hashedKey,
      scopes: ["students:read"],
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    },
  });
  return { rawKey, id: row.id };
}

test("a valid key authenticates and reports its institution and scopes", { skip: SKIP }, async () => {
  const { rawKey } = await issue();
  const context = await auth.authenticateApiKey(asRequest(`Bearer ${rawKey}`));
  assert.ok(context);
  assert.equal(context.institutionId, INSTITUTION);
  assert.deepEqual(context.scopes, ["students:read"]);
});

test("the plaintext key is never what is stored", { skip: SKIP }, async () => {
  const { rawKey, id } = await issue();
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
  assert.notEqual(row.hashedKey, rawKey);
  assert.equal(row.hashedKey.includes(rawKey), false);
  // And the raw key is not recoverable from the row by any column.
  assert.equal(JSON.stringify(row).includes(rawKey), false);
});

test("a revoked key is refused", { skip: SKIP }, async () => {
  const { rawKey, id } = await issue();
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${rawKey}`)), null);
});

test("an expired key is refused", { skip: SKIP }, async () => {
  const { rawKey } = await issue({ expiresAt: new Date(Date.now() - 60_000) });
  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${rawKey}`)), null);
});

test("a key expiring in the future still works", { skip: SKIP }, async () => {
  const { rawKey } = await issue({ expiresAt: new Date(Date.now() + 3_600_000) });
  assert.ok(await auth.authenticateApiKey(asRequest(`Bearer ${rawKey}`)));
});

test("a key with no expiry never expires", { skip: SKIP }, async () => {
  // Every key issued before the column existed has `expiresAt: null`.
  // Back-filling a date would have switched off live integrations to tidy up
  // a schema, which is an outage rather than a hardening.
  const { rawKey, id } = await issue({ expiresAt: null });
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
  assert.equal(row.expiresAt, null);
  assert.ok(await auth.authenticateApiKey(asRequest(`Bearer ${rawKey}`)));
});

test("expiry is enforced to the second, not to the day", { skip: SKIP }, async () => {
  const justPast = await issue({ expiresAt: new Date(Date.now() - 1_000) });
  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${justPast.rawKey}`)), null);
});

test("revoked and expired are indistinguishable to the caller", { skip: SKIP }, async () => {
  // Both null. The route turns either into the same 401, so a caller cannot
  // learn that a key they hold was once real.
  const revoked = await issue({ revokedAt: new Date() });
  const expired = await issue({ expiresAt: new Date(Date.now() - 1) });
  const unknown = "att_live_this_key_never_existed_at_all";

  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${revoked.rawKey}`)), null);
  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${expired.rawKey}`)), null);
  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${unknown}`)), null);
});

test("a malformed or missing authorization header authenticates nothing", { skip: SKIP }, async () => {
  for (const header of [null, "", "Bearer", "Basic abc", "att_live_no_scheme", "Bearer  "]) {
    assert.equal(await auth.authenticateApiKey(asRequest(header)), null, String(header));
  }
});

test("rotation is possible: a new key works while the old one is revoked", { skip: SKIP }, async () => {
  const oldKey = await issue();
  const newKey = await issue();

  // Overlap — both valid, which is what makes a rotation non-disruptive.
  assert.ok(await auth.authenticateApiKey(asRequest(`Bearer ${oldKey.rawKey}`)));
  assert.ok(await auth.authenticateApiKey(asRequest(`Bearer ${newKey.rawKey}`)));

  await prisma.apiKey.update({ where: { id: oldKey.id }, data: { revokedAt: new Date() } });
  assert.equal(await auth.authenticateApiKey(asRequest(`Bearer ${oldKey.rawKey}`)), null);
  assert.ok(await auth.authenticateApiKey(asRequest(`Bearer ${newKey.rawKey}`)), "the new key is unaffected");
});

test("two keys never collide on their stored hash", { skip: SKIP }, async () => {
  const a = await issue();
  const b = await issue();
  const rows = await prisma.apiKey.findMany({
    where: { id: { in: [a.id, b.id] } },
    select: { hashedKey: true },
  });
  assert.notEqual(rows[0].hashedKey, rows[1].hashedKey);
});
