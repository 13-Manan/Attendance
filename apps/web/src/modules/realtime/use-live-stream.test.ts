import { test } from "node:test";
import assert from "node:assert/strict";
import { reconnectDelayMs } from "./use-live-stream.ts";

/**
 * Phase 16 — the retry schedule.
 *
 * The hook itself needs a DOM and a live server, and is exercised in the
 * browser. What is worth pinning here is the arithmetic that decides how hard
 * a disconnected classroom hammers a replica that is still coming up, because
 * getting it wrong turns a rolling deploy into a self-inflicted load test and
 * it is the kind of mistake that only shows up under a real outage.
 */

/** Deterministic stand-ins for Math.random, to test the jitter envelope. */
const LOW = () => 0;
const MID = () => 0.5;
const HIGH = () => 1;

test("the delay grows with each attempt", () => {
  const delays = [0, 1, 2, 3, 4].map((n) => reconnectDelayMs(n, MID));
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(
      delays[i] > delays[i - 1],
      `attempt ${i} (${delays[i]}ms) should wait longer than ${i - 1} (${delays[i - 1]}ms)`,
    );
  }
});

test("the delay is capped, so a long outage becomes a slow poll", () => {
  // Without a ceiling, 2^n reaches hours and a tab left open overnight never
  // reconnects at all.
  for (const attempt of [10, 20, 100, 1_000]) {
    const delay = reconnectDelayMs(attempt, HIGH);
    assert.ok(delay <= 30_000, `attempt ${attempt} waited ${delay}ms`);
  }
});

test("the first retry is quick but never immediate", () => {
  // Zero would be a hot loop against a server that is already struggling.
  for (const random of [LOW, MID, HIGH]) {
    const delay = reconnectDelayMs(0, random);
    assert.ok(delay >= 1_000, `first retry was ${delay}ms`);
    assert.ok(delay <= 1_500, `first retry was ${delay}ms, too slow to feel responsive`);
  }
});

test("jitter spreads clients instead of synchronising them", () => {
  // Every client watching a replaced replica retries at once otherwise, which
  // is the thundering herd the cap alone does not prevent.
  const low = reconnectDelayMs(4, LOW);
  const high = reconnectDelayMs(4, HIGH);
  assert.ok(high > low, `jitter produced no spread: ${low} vs ${high}`);

  const samples = new Set(Array.from({ length: 50 }, () => reconnectDelayMs(4)));
  assert.ok(samples.size > 1, "real randomness should not return a constant");
});

test("no attempt is ever negative or zero", () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const random of [LOW, MID, HIGH]) {
      assert.ok(reconnectDelayMs(attempt, random) > 0);
    }
  }
});

test("a negative attempt is treated as the first", () => {
  // Defensive: an attempt counter can only go up in the hook, but a delay of
  // NaN or a huge negative exponent would be a silent hang rather than a bug.
  assert.equal(reconnectDelayMs(-5, MID), reconnectDelayMs(0, MID));
});

test("the whole schedule stays inside its documented envelope", () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const delay = reconnectDelayMs(attempt);
    assert.ok(
      delay >= 1_000 && delay <= 30_000,
      `attempt ${attempt} produced ${delay}ms, outside 1s–30s`,
    );
  }
});
