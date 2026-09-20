import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Clock, RateLimitDecision, RateLimitRule, RateLimiter } from "./rate-limit";

/**
 * The shared token bucket (Phase 15).
 *
 * `MemoryRateLimiter` counts per process. This app's Bicep already says
 * `maxReplicas: 5`, so an API key's real ceiling was up to five times its
 * configured allowance, and every restart handed back a full bucket. This
 * implementation keeps the same bucket arithmetic and the same
 * `RateLimiter` interface, and moves the state into Postgres so every replica
 * charges the same bucket.
 *
 * ## Why Postgres and not a cache
 *
 * Because the request already needs Postgres. Every call behind this limiter
 * goes on to read the institution's data, so a second network dependency would
 * add a failure mode without removing one, and would need an Azure resource
 * that does not exist yet. Both ADR-0004 and ADR-0007 name Postgres as the
 * intended upgrade path.
 *
 * ## Atomicity
 *
 * The decision is one statement. There is no read, no arithmetic in
 * JavaScript, and no second write — the refill, the comparison and the charge
 * all happen inside `ON CONFLICT DO UPDATE`, where the expressions referencing
 * `b.*` are evaluated against the existing row while Postgres holds its lock.
 * Two replicas hitting the same key at the same instant therefore serialise on
 * the primary key, which is what makes "both believed they were allowed"
 * impossible.
 *
 * The `WHERE` on the DO UPDATE is what reports the decision: it suppresses the
 * write when the bucket is short, so the statement returns no row, and "no row"
 * means denied. That also preserves the existing rule that a denied request
 * does not consume tokens — here it does not even write, and skipping the
 * write is equivalent because an untouched bucket refills from the same
 * `updatedAt` to the same value.
 *
 * ## Failure behaviour: the error propagates
 *
 * Deliberately not caught. Failing open would silently delete the protection;
 * failing closed with a 429 would tell a well-behaved client to back off for a
 * fault that is ours. Letting it through produces the existing
 * `internal_error` 500 and an `api.v1.unhandled` log line — visible, and
 * honest about what broke. Nothing is lost by refusing here: the same Postgres
 * is about to serve the request body, so a store that cannot answer this
 * cannot answer that either.
 */

/** Milliseconds precision, naive UTC — the convention every timestamp column
 * in this schema uses. `naiveUtc` elsewhere truncates to seconds; a rate
 * limiter that rounded to the second would hand out free requests. */
function naiveUtcMs(date: Date): string {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

/**
 * How long a bucket is worth keeping. Past this the row is treated as a full
 * bucket, which is what an untouched bucket would have refilled to anyway.
 */
const IDLE_EVICTION_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class PostgresRateLimiter implements RateLimiter {
  readonly #now: Clock;
  #lastSweep: number;

  constructor(now: Clock = Date.now) {
    this.#now = now;
    this.#lastSweep = now();
  }

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitDecision> {
    const nowMs = this.#now();
    const now = new Date(nowMs);
    const nowSql = naiveUtcMs(now);
    const expiresSql = naiveUtcMs(new Date(nowMs + IDLE_EVICTION_MS));

    const capacity = Math.max(1, rule.burst);
    const perMs = Math.max(rule.refillPerMinute, 0) / 60_000;
    const charge = Math.max(0, cost);

    // A charge larger than the bucket can never be paid, now or after any
    // amount of refilling. Answer without touching the database rather than
    // writing a row that exists only to be refused.
    if (charge > capacity) {
      return this.#decision(false, capacity, nowMs, capacity, perMs, charge);
    }

    await this.#maybeSweep(nowMs);

    // `effective` is the bucket as of `now`: refilled since `updatedAt`, capped
    // at capacity, and reset to full if the row has expired.
    const effective = Prisma.sql`
      CASE WHEN b."expiresAt" <= ${nowSql}::timestamp THEN ${capacity}::double precision
           ELSE LEAST(
             ${capacity}::double precision,
             b."tokens" + EXTRACT(EPOCH FROM (${nowSql}::timestamp - b."updatedAt")) * 1000 * ${perMs}::double precision
           )
      END`;

    const rows = await prisma.$queryRaw<Array<{ tokens: number }>>(Prisma.sql`
      INSERT INTO "RateLimitBucket" AS b ("key", "tokens", "updatedAt", "expiresAt")
      VALUES (${key}, ${capacity - charge}::double precision, ${nowSql}::timestamp, ${expiresSql}::timestamp)
      ON CONFLICT ("key") DO UPDATE
        SET "tokens"    = ${effective} - ${charge}::double precision,
            "updatedAt" = ${nowSql}::timestamp,
            "expiresAt" = ${expiresSql}::timestamp
        WHERE ${effective} >= ${charge}::double precision
      RETURNING "tokens"
    `);

    if (rows.length > 0) {
      return this.#decision(true, rows[0].tokens, nowMs, capacity, perMs, charge);
    }

    // Denied. Nothing was written, so read what is there purely to fill in the
    // headers. A stale answer here costs a slightly wrong `Retry-After`, never
    // a wrong decision — the decision was already made, atomically, above.
    const current = await prisma.$queryRaw<Array<{ tokens: number; refilled: number }>>(Prisma.sql`
      SELECT b."tokens", ${effective} AS refilled
      FROM "RateLimitBucket" b
      WHERE b."key" = ${key}
    `);
    const tokens = current.length > 0 ? Number(current[0].refilled) : capacity;
    return this.#decision(false, tokens, nowMs, capacity, perMs, charge);
  }

  /** Identical arithmetic to `MemoryRateLimiter`, so the headers do not move. */
  #decision(
    allowed: boolean,
    tokens: number,
    nowMs: number,
    capacity: number,
    perMs: number,
    charge: number,
  ): RateLimitDecision {
    const deficit = allowed ? 0 : charge - tokens;
    return {
      allowed,
      limit: capacity,
      remaining: Math.max(0, Math.floor(tokens)),
      resetAt: nowMs + (perMs > 0 ? Math.ceil((capacity - tokens) / perMs) : 0),
      retryAfterMs: allowed ? 0 : perMs > 0 ? Math.ceil(deficit / perMs) : 60_000,
    };
  }

  /**
   * Opportunistic cleanup, amortised onto request traffic exactly as the
   * in-memory sweep was. No timer: a `setInterval` would hold a container
   * open and would run on every replica at once.
   *
   * A failed sweep must not fail the request it rode in on — expired rows are
   * already treated as full buckets, so leaving them costs disk, not
   * correctness.
   */
  async #maybeSweep(nowMs: number): Promise<void> {
    if (nowMs - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = nowMs;
    const cutoff = naiveUtcMs(new Date(nowMs));
    try {
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM "RateLimitBucket" WHERE "expiresAt" <= ${cutoff}::timestamp`,
      );
    } catch {
      // Intentionally swallowed; see above. The next request retries.
    }
  }
}
