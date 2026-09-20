import { test } from "node:test";
import assert from "node:assert/strict";
import { applySyncBatch } from "./service.ts";
import { SYNC_SCHEMA_VERSION } from "./types.ts";
import type { SyncOperation } from "./types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 9 — whose register is this, and can this build read it.
 *
 * Both refusals here guard the same blind spot: a request that passes every
 * authorization check and still writes the wrong thing.
 *
 * A classroom tablet is shared. One teacher takes a register with no signal,
 * signs out, and the next teacher signs in — and the queue, which belongs to
 * the first, drains under the second's session. Permissions cannot catch
 * that: the second teacher may legitimately teach the same class, so the
 * server would accept the batch and put their name on somebody else's
 * attendance decisions. Measured before the fix: a teacher who taught only
 * Section B saw Section A's roster and an eight-mark draft that was not
 * theirs.
 *
 * The device therefore states whose work it is, and the server refuses a
 * mismatch. That claim is never used to *grant* anything — the actor is still
 * the cookie's — which is the distinction the first test pins.
 */

const ADMIN_LIKE = [
  "attendanceSession.capture",
  "attendanceRecord.correct",
  "attendanceSession.create",
  "attendanceRecord.read",
];

function makeUser(userId: string, permissions: string[] = ADMIN_LIKE): SessionUser {
  return {
    userId,
    email: `${userId}@example.com`,
    name: userId,
    institutionId: "inst-A",
    campusId: null,
    roles: [
      {
        key: "FACULTY",
        name: "Faculty",
        institutionId: "inst-A",
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function sessionOperation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    kind: "attendance.session",
    operationId: "op-1",
    deviceId: "device-1",
    attendanceSessionId: null,
    payload: {
      cohortId: "coh-1",
      cohortSubjectId: null,
      sessionDate: "2026-09-20T00:00:00.000Z",
      marks: [{ studentId: "stu-1", result: "PRESENT", markedAt: "2026-09-20T09:00:00.000Z" }],
      finalizedLocally: true,
      finalizedAt: "2026-09-20T09:30:00.000Z",
      markSource: "MANUAL",
      captureImageCount: 0,
    },
    ...overrides,
  } as SyncOperation;
}

/**
 * Fails loudly if any attendance work is attempted.
 *
 * `findSessionForDay` is the first thing `applySessionOperation` reaches for,
 * so a guard that runs afterwards would trip this instead of returning an
 * outcome.
 */
const NEVER_APPLY = {
  findSessionForDay: async () => {
    throw new Error("the operation should have been refused before any attendance work");
  },
} as never;

/** Records that the guard was passed, then stops before touching anything. */
function reachedProbe() {
  const seen = { reached: false };
  const deps = {
    findSessionForDay: async () => {
      seen.reached = true;
      throw new Error("stop-after-guard");
    },
  } as never;
  return { seen, deps };
}

// ---------------------------------------------------------------------------
// Owner mismatch
// ---------------------------------------------------------------------------

test("a queue drained by a different account is refused, permanently", async () => {
  const result = await applySyncBatch(
    makeUser("teacher-b"),
    [sessionOperation({ ownerUserId: "teacher-a" })],
    NEVER_APPLY,
  );

  const [outcome] = result.outcomes;
  assert.equal(outcome.status, "REJECTED");
  assert.equal(outcome.error, "owner_mismatch");
  assert.equal(
    outcome.retryable,
    false,
    "retrying under the same session would fail identically forever",
  );
  assert.equal(outcome.applied, 0, "and nothing was written");
});

test("the refusal precedes any attendance work at all", async () => {
  // `NEVER_APPLY` throws if reached. A rejection rather than a thrown error is
  // the proof that the guard runs first — and it matters: half-applying a
  // register and then noticing the owner is wrong would be worse than either.
  const result = await applySyncBatch(
    makeUser("teacher-b"),
    [sessionOperation({ ownerUserId: "teacher-a" })],
    NEVER_APPLY,
  );
  assert.equal(result.outcomes[0].error, "owner_mismatch");
});

test("the owner claim grants nothing — it can only refuse", async () => {
  // Claiming to be someone else does not become that person. The actor is the
  // cookie's, and a caller without the permissions is still refused by them.
  await assert.rejects(
    () =>
      applySyncBatch(
        makeUser("student-1", ["attendanceRecord.read.own"]),
        [sessionOperation({ ownerUserId: "student-1" })],
        NEVER_APPLY,
      ),
    /forbidden|permission/i,
    "a matching owner does not substitute for attendanceSession.capture",
  );
});

test("an operation with no owner recorded is still accepted", async () => {
  // Queued by a build that predates ownership tracking. Refusing these would
  // strand attendance that was already waiting when the app updated, which is
  // the loss this whole module exists to prevent.
  const { seen, deps } = reachedProbe();
  await applySyncBatch(makeUser("teacher-a"), [sessionOperation()], deps);
  assert.equal(seen.reached, true, "an unowned operation passes the guard and is processed");
});

test("a matching owner passes the guard", async () => {
  const { seen, deps } = reachedProbe();
  await applySyncBatch(makeUser("teacher-a"), [sessionOperation({ ownerUserId: "teacher-a" })], deps);
  assert.equal(seen.reached, true);
});

test("one mismatched operation does not poison the rest of the batch", async () => {
  const attempted: string[] = [];
  const result = await applySyncBatch(
    makeUser("teacher-a"),
    [
      sessionOperation({ operationId: "mine", ownerUserId: "teacher-a" }),
      sessionOperation({ operationId: "theirs", ownerUserId: "teacher-b" }),
    ],
    {
      findSessionForDay: async () => {
        attempted.push("applied");
        throw new Error("stop-after-guard");
      },
    } as never,
  );

  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[1].error, "owner_mismatch");
  assert.equal(attempted.length, 1, "only the caller's own operation was attempted");
});

// ---------------------------------------------------------------------------
// Payload versioning
// ---------------------------------------------------------------------------

test("a payload from a newer build is refused rather than guessed at", async () => {
  const result = await applySyncBatch(
    makeUser("teacher-a"),
    [sessionOperation({ ownerUserId: "teacher-a", schemaVersion: SYNC_SCHEMA_VERSION + 1 })],
    NEVER_APPLY,
  );

  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.equal(result.outcomes[0].error, "unsupported_schema_version");
  assert.equal(
    result.outcomes[0].retryable,
    false,
    "the device has to reload; retrying the same bytes cannot help",
  );
});

test("the current version and an absent version are both accepted", async () => {
  for (const schemaVersion of [SYNC_SCHEMA_VERSION, undefined]) {
    const { seen, deps } = reachedProbe();
    await applySyncBatch(
      makeUser("teacher-a"),
      [sessionOperation({ ownerUserId: "teacher-a", schemaVersion })],
      deps,
    );
    assert.equal(seen.reached, true, `schemaVersion=${String(schemaVersion)} should be readable`);
  }
});

test("an older payload version is still readable", async () => {
  // Only *newer* is refused. A device that has been offline across two
  // deploys must still be able to send what it holds.
  const { seen, deps } = reachedProbe();
  await applySyncBatch(
    makeUser("teacher-a"),
    [sessionOperation({ ownerUserId: "teacher-a", schemaVersion: 1 })],
    deps,
  );
  assert.equal(seen.reached, true);
});
