import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS,
  MAX_LEDGER_ENTRIES,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  appliedOperations,
  backoffDelayMs,
  hasApplied,
  isDue,
  ledgerEntry,
  withAppliedOperation,
} from "./idempotency.ts";
import { OFFLINE_SYNC_METADATA_KEY } from "./types.ts";

function entry(operationId: string, appliedAt = "2026-09-16T10:00:00.000Z") {
  return ledgerEntry({
    operationId,
    deviceId: "device-1",
    kind: "attendance.session",
    appliedAt,
  });
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

test("appliedOperations reads an empty ledger from every shape of junk", () => {
  // Each of these must mean "nothing applied yet" rather than throw. The safe
  // direction is to re-apply, because application is itself idempotent.
  for (const metadata of [
    null,
    undefined,
    {},
    [],
    "string",
    42,
    { [OFFLINE_SYNC_METADATA_KEY]: null },
    { [OFFLINE_SYNC_METADATA_KEY]: "nope" },
    { [OFFLINE_SYNC_METADATA_KEY]: [] },
    { [OFFLINE_SYNC_METADATA_KEY]: { appliedOperations: "nope" } },
    { [OFFLINE_SYNC_METADATA_KEY]: { appliedOperations: {} } },
  ]) {
    assert.deepEqual(appliedOperations(metadata), [], `for ${JSON.stringify(metadata)}`);
  }
});

test("appliedOperations drops malformed entries but keeps the good ones", () => {
  const metadata = {
    [OFFLINE_SYNC_METADATA_KEY]: {
      appliedOperations: [entry("op-1"), null, "op-2", { deviceId: "d" }, entry("op-3")],
    },
  };
  assert.deepEqual(
    appliedOperations(metadata).map((op) => op.operationId),
    ["op-1", "op-3"],
  );
});

test("hasApplied matches on operationId alone, not on the device", () => {
  const metadata = withAppliedOperation({}, entry("op-1"));
  const found = hasApplied(metadata, "op-1");
  assert.equal(found?.operationId, "op-1");
  assert.equal(found?.deviceId, "device-1");
  assert.equal(hasApplied(metadata, "op-2"), null);
});

// ---------------------------------------------------------------------------
// Writing the ledger
// ---------------------------------------------------------------------------

test("withAppliedOperation merges rather than clobbering other metadata buckets", () => {
  // The review module keeps `attendanceReview` in the same JSON column. Losing
  // it would erase who finalized a register.
  const before = {
    attendanceReview: { finalizedBy: "user-9" },
    [OFFLINE_SYNC_METADATA_KEY]: {
      capturedByDeviceId: "device-0",
      capturedOffline: true,
      appliedOperations: [entry("op-1")],
    },
  };
  const after = withAppliedOperation(before, entry("op-2"), { capturedByDeviceId: "device-1" });

  assert.deepEqual(after.attendanceReview, { finalizedBy: "user-9" });
  const bucket = after[OFFLINE_SYNC_METADATA_KEY] as Record<string, unknown>;
  // `extra` overwrites the field it names, and leaves the rest of the bucket.
  assert.equal(bucket.capturedByDeviceId, "device-1");
  assert.equal(bucket.capturedOffline, true);
  assert.deepEqual(appliedOperations(after).map((op) => op.operationId), ["op-1", "op-2"]);
});

test("withAppliedOperation is itself idempotent — replaying an entry does not duplicate it", () => {
  const once = withAppliedOperation({}, entry("op-1", "2026-09-16T10:00:00.000Z"));
  const twice = withAppliedOperation(once, entry("op-1", "2026-09-16T11:00:00.000Z"));

  const ledger = appliedOperations(twice);
  assert.equal(ledger.length, 1);
  // The newer timestamp wins: the entry is replaced, not appended beside itself.
  assert.equal(ledger[0].appliedAt, "2026-09-16T11:00:00.000Z");
});

test("withAppliedOperation trims to the most recent MAX_LEDGER_ENTRIES", () => {
  let metadata: unknown = {};
  for (let i = 0; i < MAX_LEDGER_ENTRIES + 25; i += 1) {
    metadata = withAppliedOperation(metadata, entry(`op-${i}`));
  }
  const ledger = appliedOperations(metadata);
  assert.equal(ledger.length, MAX_LEDGER_ENTRIES);
  // The oldest fell off the front; the newest is at the back.
  assert.equal(ledger[0].operationId, "op-25");
  assert.equal(ledger.at(-1)?.operationId, `op-${MAX_LEDGER_ENTRIES + 24}`);
});

test("withAppliedOperation survives a metadata column holding something absurd", () => {
  const after = withAppliedOperation("not an object", entry("op-1"));
  assert.equal(hasApplied(after, "op-1")?.operationId, "op-1");
});

test("ledgerEntry omits conflictCount when there were no conflicts", () => {
  assert.equal("conflictCount" in entry("op-1"), false);
  const withConflicts = ledgerEntry({
    operationId: "op-2",
    deviceId: "device-1",
    kind: "attendance.session",
    appliedAt: "2026-09-16T10:00:00.000Z",
    conflictCount: 3,
  });
  assert.equal(withConflicts.conflictCount, 3);
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test("backoffDelayMs grows exponentially at the top of the jitter window", () => {
  const max = () => 0.999_999;
  const first = backoffDelayMs(1, max);
  const second = backoffDelayMs(2, max);
  const third = backoffDelayMs(3, max);

  assert.ok(first < RETRY_BASE_MS, "attempt 1 stays inside the base window");
  assert.ok(second > first);
  assert.ok(third > second);
  assert.ok(third < RETRY_BASE_MS * 4);
});

test("backoffDelayMs never exceeds the ceiling, however many attempts", () => {
  for (const attempt of [1, 5, 10, 50, 1_000, Number.MAX_SAFE_INTEGER]) {
    const delay = backoffDelayMs(attempt, () => 0.999_999);
    assert.ok(Number.isFinite(delay), `attempt ${attempt} produced ${delay}`);
    assert.ok(delay < RETRY_MAX_MS, `attempt ${attempt} produced ${delay}`);
    assert.ok(delay >= 0);
  }
});

test("backoffDelayMs uses full jitter, so thirty tablets do not retry in lockstep", () => {
  // The property that matters when a school's Wi-Fi returns: the same attempt
  // number on different devices must produce different delays spread across
  // the whole window, not a deterministic 1s/2s/4s stampede.
  const attempt = 6;
  const lowest = backoffDelayMs(attempt, () => 0);
  const highest = backoffDelayMs(attempt, () => 0.999_999);
  const middle = backoffDelayMs(attempt, () => 0.5);

  assert.equal(lowest, 0);
  assert.ok(middle > lowest && middle < highest);
  // Full jitter means the bottom of the range is reachable — not merely a
  // small wobble around an exponential midpoint.
  assert.ok(lowest < highest / 100);
});

test("backoffDelayMs treats attempt 0 as attempt 1 rather than producing a negative window", () => {
  assert.equal(backoffDelayMs(0, () => 0.999_999), backoffDelayMs(1, () => 0.999_999));
  assert.ok(backoffDelayMs(-5, () => 0.5) >= 0);
});

// ---------------------------------------------------------------------------
// Due-ness
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-16T12:00:00.000Z");

test("isDue only ever picks up PENDING work", () => {
  for (const status of ["SYNCING", "SYNCED", "FAILED", "CONFLICT"]) {
    assert.equal(isDue({ status, attemptCount: 0, nextAttemptAt: null }, NOW), false, status);
  }
  assert.equal(isDue({ status: "PENDING", attemptCount: 0, nextAttemptAt: null }, NOW), true);
});

test("isDue respects the backoff window", () => {
  const future = new Date(NOW.getTime() + 30_000).toISOString();
  const past = new Date(NOW.getTime() - 1).toISOString();
  assert.equal(isDue({ status: "PENDING", attemptCount: 2, nextAttemptAt: future }, NOW), false);
  assert.equal(isDue({ status: "PENDING", attemptCount: 2, nextAttemptAt: past }, NOW), true);
  // Exactly due counts as due.
  assert.equal(
    isDue({ status: "PENDING", attemptCount: 2, nextAttemptAt: NOW.toISOString() }, NOW),
    true,
  );
});

test("isDue stops at MAX_ATTEMPTS so exhausted work parks instead of spinning", () => {
  assert.equal(
    isDue({ status: "PENDING", attemptCount: MAX_ATTEMPTS - 1, nextAttemptAt: null }, NOW),
    true,
  );
  assert.equal(
    isDue({ status: "PENDING", attemptCount: MAX_ATTEMPTS, nextAttemptAt: null }, NOW),
    false,
  );
});
