import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeIndicator,
  describeSyncError,
  syncIndicator,
  type IndicatorInput,
} from "./status.ts";

function input(overrides: Partial<IndicatorInput> = {}): IndicatorInput {
  return { isOffline: false, pending: 0, syncing: 0, failed: 0, conflicts: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// Which state wins
// ---------------------------------------------------------------------------

test("an empty queue on a live connection is the only way to reach SYNCED", () => {
  assert.equal(syncIndicator(input()), "SYNCED");
  for (const busy of [{ pending: 1 }, { syncing: 1 }, { failed: 1 }, { conflicts: 1 }]) {
    assert.notEqual(syncIndicator(input(busy)), "SYNCED", JSON.stringify(busy));
  }
  assert.notEqual(syncIndicator(input({ isOffline: true })), "SYNCED");
});

test("severity order is CONFLICT > FAILED > OFFLINE > SYNCING > PENDING > SYNCED", () => {
  const everything = input({
    isOffline: true,
    pending: 3,
    syncing: 2,
    failed: 1,
    conflicts: 1,
  });
  assert.equal(syncIndicator(everything), "CONFLICT");
  assert.equal(syncIndicator({ ...everything, conflicts: 0 }), "FAILED");
  assert.equal(syncIndicator({ ...everything, conflicts: 0, failed: 0 }), "OFFLINE");
  assert.equal(
    syncIndicator({ ...everything, conflicts: 0, failed: 0, isOffline: false }),
    "SYNCING",
  );
  assert.equal(
    syncIndicator({ ...everything, conflicts: 0, failed: 0, isOffline: false, syncing: 0 }),
    "PENDING",
  );
});

test("a conflict outranks being offline, because being offline resolves itself", () => {
  // The case this exists for: a teacher with an unresolved disagreement whose
  // device is also offline must not see a cloud icon everyone ignores.
  assert.equal(syncIndicator(input({ isOffline: true, conflicts: 1 })), "CONFLICT");
  assert.equal(syncIndicator(input({ isOffline: true, failed: 1 })), "FAILED");
});

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

test("every non-synced state names a number the teacher can act on", () => {
  const cases: Array<[IndicatorInput, string]> = [
    [input({ isOffline: true, pending: 2 }), "2"],
    [input({ pending: 4 }), "4"],
    [input({ syncing: 3 }), "3"],
    [input({ failed: 5 }), "5"],
    [input({ conflicts: 6 }), "6"],
  ];
  for (const [value, expected] of cases) {
    const { label } = describeIndicator(syncIndicator(value), value);
    assert.ok(label.includes(expected), `${label} should mention ${expected}`);
  }
});

test("'Synced' is never said while anything is queued", () => {
  for (const value of [
    input({ pending: 1 }),
    input({ syncing: 1 }),
    input({ failed: 1 }),
    input({ conflicts: 1 }),
    input({ isOffline: true }),
  ]) {
    const { label } = describeIndicator(syncIndicator(value), value);
    assert.equal(/synced/i.test(label), false, label);
  }
  assert.equal(describeIndicator("SYNCED", input()).label, "Synced");
});

test("the failure wording says the attendance is still saved, never that it is lost", () => {
  // A teacher who reads "Sync failed" and assumes the register is gone will
  // re-take it, and then there are two.
  const failed = describeIndicator("FAILED", input({ failed: 2 }));
  assert.match(failed.detail, /still saved on this device/i);
  assert.equal(/lost|deleted|discarded/i.test(failed.detail), false);

  const offlineWithWork = describeIndicator("OFFLINE", input({ isOffline: true, pending: 2 }));
  assert.match(offlineWithWork.detail, /saved on this device/i);
});

test("the conflict wording promises nothing was overwritten", () => {
  const conflict = describeIndicator("CONFLICT", input({ conflicts: 1 }));
  assert.match(conflict.detail, /nothing was overwritten/i);
});

test("offline with an empty queue invites capture instead of warning", () => {
  const quiet = describeIndicator("OFFLINE", input({ isOffline: true }));
  assert.equal(quiet.label, "Offline");
  assert.match(quiet.detail, /still open a class/i);
});

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------

test("describeSyncError returns null for no error", () => {
  assert.equal(describeSyncError(null), null);
  assert.equal(describeSyncError(""), null);
});

test("describeSyncError explains the codes the server and queue actually emit", () => {
  assert.match(describeSyncError("forbidden:cohort_access_denied") ?? "", /permission/i);
  assert.match(describeSyncError("http_401") ?? "", /sign in again/i);
  assert.match(describeSyncError("http_503") ?? "", /retried/i);
  assert.match(describeSyncError("network_unreachable") ?? "", /retried automatically/i);
  assert.match(describeSyncError("session_cancelled") ?? "", /cancelled/i);
});

test("describeSyncError degrades to readable words rather than showing a raw code", () => {
  assert.equal(describeSyncError("some_unknown_reason"), "some unknown reason");
});
