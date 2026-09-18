/**
 * Rate limiting for the public integration API.
 *
 * ## The abstraction is the deliverable
 *
 * `RateLimiter` is an interface with one method, and every caller depends on
 * the interface. The in-process token bucket below is the implementation this
 * build ships; a Redis or Upstash implementation is the same 20 lines against
 * a `INCR`/`EXPIRE` pair or a Lua script, and swapping it changes no route, no
 * service, and no test.
 *
 * ## Read this before trusting the in-process limiter in production
 *
 * `MemoryRateLimiter` counts *per process*. Behind two app instances an API
 * key gets twice its limit; behind serverless functions that scale to n, it
 * gets n times its limit and loses its counters on every cold start. That is
 * not a bug to be fixed here — a correct distributed limiter needs shared
 * state, and inventing one over Postgres would put a write on the hot path of
 * every read request.
 *
 * So the honest statement: this limiter stops a runaway integration script
 * and a misconfigured polling loop, which is what it is for. It is not a
 * defence against a determined attacker, and on a multi-instance deployment
 * the real ceiling is `instances × limit`. `RATE_LIMIT_BACKEND` in
 * docs/INTEGRATIONS.md records what to set before that matters.
 *
 * ## Why a token bucket
 *
 * An ERP sync is bursty by nature: silent for an hour, then 200 requests
 * paging through a roster. A fixed window either permits that burst and
 * therefore permits it 60 times an hour, or forbids it and breaks the sync.
 * A bucket separates the two questions — `burst` is how much can arrive at
 * once, `refillPerMinute` is the sustained rate — and lets an institution
 * allow a fast nightly sync without allowing a fast permanent poll.
 *
 * Pure except for the clock, which is injected. See rate-limit.test.ts.
 */

export interface RateLimitRule {
  /** Maximum requests that can arrive back-to-back. Bucket capacity. */
  burst: number;
  /** Sustained requests per minute. Bucket refill rate. */
  refillPerMinute: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket capacity — the `RateLimit-Limit` header. */
  limit: number;
  /** Whole requests still available right now. */
  remaining: number;
  /** Epoch ms at which `remaining` would return to `limit`. */
  resetAt: number;
  /** 0 when allowed; otherwise how long until one token exists. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /**
   * Charges `cost` against `key` and says whether the request may proceed.
   *
   * Async because the production implementation talks to a network store.
   * Returning a decision rather than throwing keeps the "allowed" and
   * "denied" paths identical at the call site — both need the headers.
   */
  consume(key: string, rule: RateLimitRule, cost?: number): Promise<RateLimitDecision>;
}

/**
 * Default ceiling for a key with no configured override.
 *
 * 120/minute sustained with a 240 burst: enough for a nightly roster sync
 * paging 100 students at a time to finish a 20,000-student institution in
 * under two minutes, and far below what a polling loop with a missing `sleep`
 * would produce. Institutions raise it per key in the Integration Center.
 */
export const DEFAULT_RATE_LIMIT: RateLimitRule = { burst: 240, refillPerMinute: 120 };

/**
 * Deliberately tighter than the read limit. Writes cost a transaction and can
 * change a register; a client that needs more than two per second is either
 * misbehaving or should be using the import pipeline, which is the supported
 * way to move ten thousand rows.
 */
export const WRITE_RATE_LIMIT: RateLimitRule = { burst: 60, refillPerMinute: 60 };

export type Clock = () => number;

interface Bucket {
  /** Fractional tokens available as of `updatedAt`. */
  tokens: number;
  updatedAt: number;
}

/**
 * How long an idle bucket is kept before the sweep discards it.
 *
 * Discarding a full bucket is free — a key with no recent traffic would refill
 * to capacity anyway, so recreating it on the next request gives the same
 * answer. Only *partially drained* buckets carry information, and they refill
 * within `burst / refillPerMinute` minutes. An hour is comfortably past that
 * for any sane rule.
 */
const IDLE_EVICTION_MS = 60 * 60 * 1000;

/** Sweep at most this often, and only while requests are arriving. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: Clock;
  #lastSweep: number;

  /**
   * No `setInterval`. A timer would keep a serverless instance alive and,
   * worse, would make this module untestable without fake timers. The sweep
   * is amortised onto `consume`, which is the only thing that can grow the
   * map in the first place.
   */
  constructor(now: Clock = Date.now) {
    this.#now = now;
    this.#lastSweep = now();
  }

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitDecision> {
    return this.consumeSync(key, rule, cost);
  }

  /** The real logic. Synchronous so tests can assert without awaiting a clock. */
  consumeSync(key: string, rule: RateLimitRule, cost = 1): RateLimitDecision {
    const now = this.#now();
    this.#maybeSweep(now);

    const capacity = Math.max(1, rule.burst);
    const perMs = Math.max(rule.refillPerMinute, 0) / 60_000;

    const existing = this.#buckets.get(key);
    const tokens = existing
      ? Math.min(capacity, existing.tokens + (now - existing.updatedAt) * perMs)
      : capacity;

    const charge = Math.max(0, cost);
    const allowed = tokens >= charge;
    // A denied request does NOT consume tokens. Charging for rejections means
    // a client stuck in a retry loop can never recover — every retry pushes
    // the reset further out, and an integration that hit the limit once stays
    // broken until someone notices. Denial is already the punishment.
    const remainingTokens = allowed ? tokens - charge : tokens;

    this.#buckets.set(key, { tokens: remainingTokens, updatedAt: now });

    const deficit = allowed ? 0 : charge - tokens;
    return {
      allowed,
      limit: capacity,
      remaining: Math.max(0, Math.floor(remainingTokens)),
      resetAt: now + (perMs > 0 ? Math.ceil((capacity - remainingTokens) / perMs) : 0),
      // `perMs === 0` means a rule of zero sustained rate: nothing will ever
      // refill, so report the window rather than Infinity, which would
      // serialise to `null` in a header and tell the client nothing.
      retryAfterMs: allowed ? 0 : perMs > 0 ? Math.ceil(deficit / perMs) : 60_000,
    };
  }

  /** Test/ops affordance: forget everything. Never called by request paths. */
  reset(): void {
    this.#buckets.clear();
  }

  get size(): number {
    return this.#buckets.size;
  }

  #maybeSweep(now: number): void {
    if (now - this.#lastSweep < SWEEP_INTERVAL_MS) return;
    this.#lastSweep = now;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt > IDLE_EVICTION_MS) this.#buckets.delete(key);
    }
  }
}

/**
 * A limiter that permits everything, for tests and for a deployment that
 * terminates rate limiting at the gateway. Explicit and named, so "no rate
 * limiting" is a configuration someone chose rather than a null check
 * somewhere that silently skipped it.
 */
export class NoopRateLimiter implements RateLimiter {
  async consume(_key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    return {
      allowed: true,
      limit: rule.burst,
      remaining: rule.burst,
      resetAt: Date.now(),
      retryAfterMs: 0,
    };
  }
}

/**
 * The process-wide limiter.
 *
 * Module-level singleton for the same reason `lib/prisma.ts` is one: the
 * state only means anything if every request shares it. A limiter constructed
 * per request would permit every request.
 */
export const rateLimiter: RateLimiter = new MemoryRateLimiter();

/**
 * Bucket identity.
 *
 * Keyed by API key *and* by bucket name so a client that exhausts its write
 * allowance can still read — a biometric device that gets 429ed on submission
 * must still be able to fetch tomorrow's roster. Institution is not part of
 * the key: the key already belongs to exactly one institution, and including
 * it would let a client multiply its allowance by nothing at all.
 */
export function rateLimitKey(apiKeyId: string, bucket: string): string {
  return `${apiKeyId}:${bucket}`;
}

/**
 * IETF draft `RateLimit-*` headers plus `Retry-After`.
 *
 * `Retry-After` is in whole seconds per RFC 9110 and is rounded *up* —
 * rounding down produces a retry that arrives fractionally early and is
 * denied again, which is how a well-behaved client ends up looking like an
 * abusive one.
 */
export function rateLimitHeaders(decision: RateLimitDecision, now: number): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.max(0, Math.ceil((decision.resetAt - now) / 1000))),
  };
  if (!decision.allowed) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
  }
  return headers;
}
