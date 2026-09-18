import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RATE_LIMIT,
  MemoryRateLimiter,
  NoopRateLimiter,
  WRITE_RATE_LIMIT,
  rateLimitHeaders,
  rateLimitKey,
} from "./rate-limit.ts";

/** A clock the test drives, so nothing here depends on wall time. */
function fakeClock(start = 1_000_000) {
  let current = start;
  const clock = () => current;
  return {
    clock,
    advance(ms: number) {
      current += ms;
    },
    get now() {
      return current;
    },
  };
}

const RULE = { burst: 3, refillPerMinute: 60 } as const;

// ---------------------------------------------------------------------------
// The bucket
// ---------------------------------------------------------------------------

test("a fresh key starts full and drains one token per request", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  assert.deepEqual(
    [0, 1, 2].map(() => limiter.consumeSync("k", RULE).remaining),
    [2, 1, 0],
  );
});

test("the request past the burst is denied", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.consumeSync("k", RULE).allowed, true);
  const denied = limiter.consumeSync("k", RULE);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0);
});

test("a denied request does not consume tokens, so a retry loop can recover", () => {
  // The bug this guards: charging for rejections means every retry pushes the
  // reset further out and the integration never comes back on its own.
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  for (let i = 0; i < 3; i += 1) limiter.consumeSync("k", RULE);

  const first = limiter.consumeSync("k", RULE);
  for (let i = 0; i < 50; i += 1) limiter.consumeSync("k", RULE);
  const last = limiter.consumeSync("k", RULE);

  assert.equal(last.retryAfterMs, first.retryAfterMs, "hammering must not extend the wait");

  time.advance(first.retryAfterMs);
  assert.equal(limiter.consumeSync("k", RULE).allowed, true);
});

test("tokens refill at the configured rate", () => {
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  for (let i = 0; i < 3; i += 1) limiter.consumeSync("k", RULE);
  assert.equal(limiter.consumeSync("k", RULE).allowed, false);

  time.advance(1_000); // 60/minute → one token per second
  assert.equal(limiter.consumeSync("k", RULE).allowed, true);
});

test("refill never exceeds the burst capacity", () => {
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  limiter.consumeSync("k", RULE);
  time.advance(24 * 60 * 60 * 1000);
  const decision = limiter.consumeSync("k", RULE);
  assert.equal(decision.remaining, RULE.burst - 1, "an idle day does not bank a day of tokens");
});

test("buckets are independent per key", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  for (let i = 0; i < 3; i += 1) limiter.consumeSync("a", RULE);
  assert.equal(limiter.consumeSync("a", RULE).allowed, false);
  assert.equal(limiter.consumeSync("b", RULE).allowed, true, "one client must not throttle another");
});

test("read and write allowances are separate buckets for the same key", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  const writeKey = rateLimitKey("key-1", "write");
  const readKey = rateLimitKey("key-1", "read");
  for (let i = 0; i < 3; i += 1) limiter.consumeSync(writeKey, RULE);

  assert.equal(limiter.consumeSync(writeKey, RULE).allowed, false);
  assert.equal(
    limiter.consumeSync(readKey, RULE).allowed,
    true,
    "a device 429ed on submission must still fetch tomorrow's roster",
  );
});

test("cost weights a single call", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  assert.equal(limiter.consumeSync("k", RULE, 3).allowed, true);
  assert.equal(limiter.consumeSync("k", RULE, 1).allowed, false);
});

test("a cost beyond the burst is denied rather than deadlocking the bucket", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  const decision = limiter.consumeSync("k", RULE, 99);
  assert.equal(decision.allowed, false);
  assert.equal(limiter.consumeSync("k", RULE, 1).allowed, true, "the bucket was not drained by the refusal");
});

test("a zero-refill rule reports a finite retry rather than Infinity", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  const rule = { burst: 1, refillPerMinute: 0 };
  assert.equal(limiter.consumeSync("k", rule).allowed, true);
  const denied = limiter.consumeSync("k", rule);
  assert.equal(denied.allowed, false);
  assert.equal(Number.isFinite(denied.retryAfterMs), true);
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

test("idle buckets are swept, and sweeping does not change any answer", () => {
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  limiter.consumeSync("old", RULE);
  assert.equal(limiter.size, 1);

  time.advance(2 * 60 * 60 * 1000);
  limiter.consumeSync("new", RULE);

  assert.equal(limiter.size, 1, "the idle key was evicted");
  // A full bucket and an absent bucket are the same answer, which is what
  // makes eviction safe.
  assert.equal(limiter.consumeSync("old", RULE).remaining, RULE.burst - 1);
});

test("a partially drained bucket survives a sweep that is not yet due", () => {
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  for (let i = 0; i < 3; i += 1) limiter.consumeSync("k", RULE);
  time.advance(100);
  assert.equal(limiter.consumeSync("k", RULE).allowed, false);
});

test("reset forgets everything", () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  for (let i = 0; i < 3; i += 1) limiter.consumeSync("k", RULE);
  limiter.reset();
  assert.equal(limiter.size, 0);
  assert.equal(limiter.consumeSync("k", RULE).allowed, true);
});

// ---------------------------------------------------------------------------
// The async surface and the no-op
// ---------------------------------------------------------------------------

test("the async consume matches the sync core", async () => {
  const limiter = new MemoryRateLimiter(fakeClock().clock);
  const decision = await limiter.consume("k", RULE);
  assert.equal(decision.allowed, true);
  assert.equal(decision.limit, RULE.burst);
});

test("the no-op limiter allows everything, explicitly", async () => {
  const limiter = new NoopRateLimiter();
  for (let i = 0; i < 1000; i += 1) {
    assert.equal((await limiter.consume("k", RULE)).allowed, true);
  }
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test("allowed responses carry RateLimit headers and no Retry-After", () => {
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  const headers = rateLimitHeaders(limiter.consumeSync("k", RULE), time.now);
  assert.equal(headers["RateLimit-Limit"], "3");
  assert.equal(headers["RateLimit-Remaining"], "2");
  assert.equal("Retry-After" in headers, false);
});

test("Retry-After is whole seconds, rounded up, never zero", () => {
  const time = fakeClock();
  const limiter = new MemoryRateLimiter(time.clock);
  for (let i = 0; i < 3; i += 1) limiter.consumeSync("k", RULE);
  const headers = rateLimitHeaders(limiter.consumeSync("k", RULE), time.now);
  const retryAfter = Number(headers["Retry-After"]);
  assert.equal(Number.isInteger(retryAfter), true);
  assert.ok(retryAfter >= 1, "a Retry-After of 0 invites an immediate, guaranteed-denied retry");
});

test("the shipped rules give writes a tighter allowance than reads", () => {
  assert.ok(WRITE_RATE_LIMIT.burst < DEFAULT_RATE_LIMIT.burst);
  assert.ok(WRITE_RATE_LIMIT.refillPerMinute <= DEFAULT_RATE_LIMIT.refillPerMinute);
});

test("rateLimitKey separates key from bucket", () => {
  assert.equal(rateLimitKey("key-1", "read"), "key-1:read");
  assert.notEqual(rateLimitKey("key-1", "read"), rateLimitKey("key-1", "write"));
});
