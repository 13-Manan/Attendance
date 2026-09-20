import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { PostgresRateLimiter } from "./rate-limit-postgres.ts";
import { MemoryRateLimiter, type RateLimitRule } from "./rate-limit.ts";

/**
 * Phase 15 — the shared token bucket, against the real database.
 *
 * The thing under test is atomicity, and atomicity cannot be demonstrated
 * against a stub: a fake store executes callers one at a time and would report
 * success for an implementation that reads, computes and writes in three
 * separate steps. Only Postgres can show whether two callers arriving together
 * both walk away believing they were allowed.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const PREFIX = "rl-test:";

async function clear() {
  await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: PREFIX } } });
}

before(async () => {
  if (SKIP) return;
  await clear();
});

beforeEach(async () => {
  if (SKIP) return;
  await clear();
});

after(async () => {
  if (SKIP) return;
  await clear();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Atomicity — the reason this phase exists
// ---------------------------------------------------------------------------

test("concurrent callers cannot exceed the burst", { skip: SKIP }, async () => {
  const rule: RateLimitRule = { burst: 10, refillPerMinute: 0 };
  const key = `${PREFIX}atomic`;

  // Two limiter objects standing in for two replicas: separate instances,
  // separate in-process state, one database.
  const a = new PostgresRateLimiter();
  const b = new PostgresRateLimiter();

  // 40 requests launched together, alternating between the two "replicas".
  const decisions = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).consume(key, rule)),
  );

  const allowed = decisions.filter((d) => d.allowed).length;
  assert.equal(allowed, 10, `${allowed} requests were allowed against a burst of 10`);
  assert.equal(decisions.length - allowed, 30);

  const row = await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key } });
  assert.ok(row.tokens >= 0, `tokens went negative: ${row.tokens}`);
  assert.ok(row.tokens < 1, `bucket should be drained, holds ${row.tokens}`);
});

test("the boundary request is allowed exactly once", { skip: SKIP }, async () => {
  // The classic read-compute-write race: two callers at the last token.
  const rule: RateLimitRule = { burst: 1, refillPerMinute: 0 };
  const key = `${PREFIX}boundary`;

  const results = await Promise.all([
    new PostgresRateLimiter().consume(key, rule),
    new PostgresRateLimiter().consume(key, rule),
    new PostgresRateLimiter().consume(key, rule),
  ]);
  assert.equal(results.filter((r) => r.allowed).length, 1);
});

test("a denied request does not consume tokens", { skip: SKIP }, async () => {
  const rule: RateLimitRule = { burst: 2, refillPerMinute: 0 };
  const key = `${PREFIX}no-charge`;
  const limiter = new PostgresRateLimiter();

  await limiter.consume(key, rule);
  await limiter.consume(key, rule);
  const first = await limiter.consume(key, rule);
  const second = await limiter.consume(key, rule);

  assert.equal(first.allowed, false);
  assert.equal(second.allowed, false);
  // Denial must not push the reset further out, or a client in a retry loop
  // could never recover.
  assert.equal(first.remaining, second.remaining);
});

// ---------------------------------------------------------------------------
// Agreement with the specification
// ---------------------------------------------------------------------------

test("it decides identically to the in-memory limiter", { skip: SKIP }, async () => {
  // The memory limiter is the written specification of the bucket arithmetic.
  // A shared implementation that drifted from it would change the public API's
  // observable behaviour, which this phase is not allowed to do.
  const rule: RateLimitRule = { burst: 5, refillPerMinute: 60 };
  let clock = Date.UTC(2026, 8, 20, 12, 0, 0);
  const now = () => clock;

  const pg = new PostgresRateLimiter(now);
  const mem = new MemoryRateLimiter(now);
  const key = `${PREFIX}agreement`;

  for (const step of [0, 0, 0, 0, 0, 0, 1_000, 30_000, 60_000, 0, 0]) {
    clock += step;
    const fromPg = await pg.consume(key, rule);
    const fromMem = await mem.consume(key, rule);
    assert.equal(fromPg.allowed, fromMem.allowed, `allowed differed at t+${clock}`);
    assert.equal(fromPg.limit, fromMem.limit);
    assert.equal(fromPg.remaining, fromMem.remaining, `remaining differed at t+${clock}`);
  }
});

test("tokens refill over time", { skip: SKIP }, async () => {
  const rule: RateLimitRule = { burst: 4, refillPerMinute: 60 };
  let clock = Date.UTC(2026, 8, 20, 9, 0, 0);
  const limiter = new PostgresRateLimiter(() => clock);
  const key = `${PREFIX}refill`;

  for (let i = 0; i < 4; i += 1) await limiter.consume(key, rule);
  assert.equal((await limiter.consume(key, rule)).allowed, false, "bucket should be empty");

  clock += 2_000; // 60/min = 1/sec
  const after = await limiter.consume(key, rule);
  assert.equal(after.allowed, true, "two seconds should buy two tokens");
});

test("a charge larger than the bucket is refused without writing a row", { skip: SKIP }, async () => {
  const key = `${PREFIX}oversized`;
  const decision = await new PostgresRateLimiter().consume(key, { burst: 3, refillPerMinute: 60 }, 99);
  assert.equal(decision.allowed, false);
  assert.equal(await prisma.rateLimitBucket.count({ where: { key } }), 0);
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

test("an expired bucket is treated as full", { skip: SKIP }, async () => {
  const rule: RateLimitRule = { burst: 3, refillPerMinute: 0 };
  const key = `${PREFIX}ttl`;
  let clock = Date.UTC(2026, 8, 20, 10, 0, 0);
  const limiter = new PostgresRateLimiter(() => clock);

  for (let i = 0; i < 3; i += 1) await limiter.consume(key, rule);
  assert.equal((await limiter.consume(key, rule)).allowed, false);

  // Past the row's expiry. With refillPerMinute: 0 nothing would ever refill,
  // so allowance here can only come from the expiry rule.
  clock += 61 * 60 * 1000;
  const revived = await limiter.consume(key, rule);
  assert.equal(revived.allowed, true, "an expired bucket must not stay drained forever");
});

test("every write carries an expiry, so no key is permanent", { skip: SKIP }, async () => {
  const key = `${PREFIX}expiry-set`;
  const before = Date.now();
  await new PostgresRateLimiter().consume(key, { burst: 5, refillPerMinute: 60 });
  const row = await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key } });
  assert.ok(row.expiresAt.getTime() > before, "expiresAt must be in the future");
  assert.ok(
    row.expiresAt.getTime() - row.updatedAt.getTime() > 0,
    "expiresAt must be after updatedAt",
  );
});

test("the sweep deletes expired rows", { skip: SKIP }, async () => {
  const stale = `${PREFIX}stale`;
  await prisma.rateLimitBucket.create({
    data: {
      key: stale,
      tokens: 0,
      updatedAt: new Date(Date.UTC(2020, 0, 1)),
      expiresAt: new Date(Date.UTC(2020, 0, 1)),
    },
  });

  // The sweep is amortised onto traffic and runs at most once per interval,
  // measured from construction — so it cannot fire on the first request of a
  // fresh process. Advance the clock past the interval and then send traffic,
  // which is what a real replica does five minutes after it starts.
  let clock = Date.now();
  const limiter = new PostgresRateLimiter(() => clock);
  clock += 10 * 60 * 1000;
  await limiter.consume(`${PREFIX}sweeper`, { burst: 5, refillPerMinute: 60 });

  assert.equal(await prisma.rateLimitBucket.count({ where: { key: stale } }), 0);
});

// ---------------------------------------------------------------------------
// Key isolation
// ---------------------------------------------------------------------------

test("buckets do not bleed into one another", { skip: SKIP }, async () => {
  const rule: RateLimitRule = { burst: 2, refillPerMinute: 0 };
  const limiter = new PostgresRateLimiter();

  await limiter.consume(`${PREFIX}keyA:read`, rule);
  await limiter.consume(`${PREFIX}keyA:read`, rule);
  assert.equal((await limiter.consume(`${PREFIX}keyA:read`, rule)).allowed, false);

  // A different bucket on the same key, and a different key entirely: both
  // must be untouched. Exhausting a write allowance must not stop a roster
  // read.
  assert.equal((await limiter.consume(`${PREFIX}keyA:write`, rule)).allowed, true);
  assert.equal((await limiter.consume(`${PREFIX}keyB:read`, rule)).allowed, true);
});

// ---------------------------------------------------------------------------
// Survives a replica restart
// ---------------------------------------------------------------------------

test("state survives the limiter object being discarded", { skip: SKIP }, async () => {
  // Standing in for a container restart: the process-local object is gone, the
  // shared row is not. Under the old limiter this handed back a full bucket.
  const rule: RateLimitRule = { burst: 3, refillPerMinute: 0 };
  const key = `${PREFIX}restart`;

  const before = new PostgresRateLimiter();
  for (let i = 0; i < 3; i += 1) await before.consume(key, rule);

  const afterRestart = new PostgresRateLimiter();
  assert.equal(
    (await afterRestart.consume(key, rule)).allowed,
    false,
    "a restart must not reset the allowance",
  );
});
