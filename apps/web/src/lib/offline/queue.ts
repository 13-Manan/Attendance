"use client";

import { backoffDelayMs, isDue, MAX_ATTEMPTS } from "@/modules/offline-sync/idempotency";
import type {
  SyncBatchResult,
  SyncOperationOutcome,
  SyncStatus,
} from "@/modules/offline-sync/types";
import {
  claimDueItems,
  deleteQueueItem,
  enqueue,
  getDeviceId,
  listQueue,
  releaseStaleClaims,
  updateQueueItem,
  updateSession,
  type QueueRecord,
} from "./db";

/**
 * The client half of the sync engine: what to send, when to send it again,
 * and what to write down about the answer.
 *
 * ## The one rule
 *
 * **No path in this file deletes an item the server did not acknowledge.**
 * Not on error, not on timeout, not on attempt eight, not on sign-out. An
 * operation that fails permanently is *parked* — status `FAILED`, still in
 * IndexedDB, still listed in the sync panel with a Retry button and the
 * server's reason next to it. Attendance stops being a record the moment
 * software decides on its own that it can drop some.
 *
 * ## Why the drain is serialized
 *
 * One drain at a time, guarded by a module-level promise. Concurrent drains
 * would not corrupt anything — `claimDueItems` is atomic and the server is
 * idempotent — but they would double the requests a school's saturated uplink
 * has to carry at exactly the moment thirty devices reconnect together.
 */

const SYNC_ENDPOINT = "/api/sync/attendance";

/** Operations per request. Matches the server's `MAX_BATCH_SIZE`. */
const BATCH_SIZE = 25;

/**
 * How long one drain waits before giving up on the request.
 *
 * Short on purpose. The failure this guards is not a slow server, it is a
 * captive portal or a half-open connection that will never answer — the
 * normal state of a school Wi-Fi network that says "connected" and is not.
 * Failing in fifteen seconds and backing off is better than a request that
 * hangs until the tab closes and takes its claim with it.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export interface QueueSnapshot {
  pending: number;
  syncing: number;
  failed: number;
  conflicts: number;
  total: number;
  /** The soonest a parked-but-retryable item becomes due, if any. */
  nextAttemptAt: string | null;
  lastError: string | null;
}

export const EMPTY_SNAPSHOT: QueueSnapshot = {
  pending: 0,
  syncing: 0,
  failed: 0,
  conflicts: 0,
  total: 0,
  nextAttemptAt: null,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface QueueSessionInput {
  localSessionId: string;
  cohortId: string;
  cohortSubjectId: string | null;
  sessionDate: string;
  marks: Array<{ studentId: string; result: "PRESENT" | "ABSENT"; markedAt: string }>;
  finalizedLocally: boolean;
  finalizedAt: string | null;
  markSource: "MANUAL" | "LOCAL_AI_ASSISTED";
  captureImageCount: number;
}

/**
 * Queues a finalized offline register.
 *
 * The operation id is generated **here**, at queue time, and never again. That
 * is the entire duplicate-prevention story on this side: a retry after a
 * response that was lost in transit carries the same id as the attempt whose
 * reply never arrived, so the server recognizes it. Generating the id per
 * *attempt* instead — the obvious-looking mistake — would make every lost
 * response a duplicate register.
 */
export async function queueSession(input: QueueSessionInput): Promise<QueueRecord> {
  const deviceId = await getDeviceId();
  const now = new Date().toISOString();
  const record: QueueRecord = {
    id: crypto.randomUUID(),
    kind: "attendance.session",
    localSessionId: input.localSessionId,
    attendanceSessionId: null,
    payload: {
      cohortId: input.cohortId,
      cohortSubjectId: input.cohortSubjectId,
      sessionDate: input.sessionDate,
      marks: input.marks,
      finalizedLocally: input.finalizedLocally,
      finalizedAt: input.finalizedAt,
      markSource: input.markSource,
      captureImageCount: input.captureImageCount,
    },
    status: "PENDING",
    attemptCount: 0,
    createdAt: now,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastError: null,
    retryable: true,
    conflicts: [],
  };
  await enqueue(record);
  await updateSession(input.localSessionId, (s) => ({ ...s, syncStatus: "PENDING", updatedAt: now }));
  void deviceId; // read here so a failure to open IndexedDB surfaces before the write
  return record;
}

export interface QueueCorrectionInput {
  localSessionId: string | null;
  attendanceSessionId: string;
  studentId: string;
  result: "PRESENT" | "ABSENT";
  reason: string | null;
}

/** Queues a correction to a register the server already has. */
export async function queueCorrection(input: QueueCorrectionInput): Promise<QueueRecord> {
  const now = new Date().toISOString();
  const record: QueueRecord = {
    id: crypto.randomUUID(),
    kind: "attendance.correction",
    localSessionId: input.localSessionId,
    attendanceSessionId: input.attendanceSessionId,
    payload: {
      attendanceSessionId: input.attendanceSessionId,
      studentId: input.studentId,
      result: input.result,
      reason: input.reason,
      correctedAt: now,
    },
    status: "PENDING",
    attemptCount: 0,
    createdAt: now,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastError: null,
    retryable: true,
    conflicts: [],
  };
  await enqueue(record);
  return record;
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

let inFlight: Promise<QueueSnapshot> | null = null;

export interface DrainResult {
  snapshot: QueueSnapshot;
  attempted: number;
  applied: number;
  duplicates: number;
  conflicts: number;
  /** True when the request itself never reached the server. */
  offline: boolean;
}

/**
 * Sends one batch of due operations and records the answers.
 *
 * Returns rather than throws. Being unable to reach the server is the normal
 * state this module was built for, not an exception — a drain that throws
 * would have every caller wrapping it in a try/catch that does nothing.
 */
export async function drainQueue(): Promise<DrainResult> {
  if (inFlight) {
    const snapshot = await inFlight;
    return { snapshot, attempted: 0, applied: 0, duplicates: 0, conflicts: 0, offline: false };
  }

  let result: DrainResult = {
    snapshot: EMPTY_SNAPSHOT,
    attempted: 0,
    applied: 0,
    duplicates: 0,
    conflicts: 0,
    offline: false,
  };

  const run = (async () => {
    result = await drainOnce();
    return result.snapshot;
  })();

  inFlight = run;
  try {
    await run;
  } finally {
    inFlight = null;
  }
  return result;
}

async function drainOnce(): Promise<DrainResult> {
  const now = new Date();
  const claimed = await claimDueItems(now, BATCH_SIZE, isDue);
  if (claimed.length === 0) {
    return {
      snapshot: await snapshotQueue(),
      attempted: 0,
      applied: 0,
      duplicates: 0,
      conflicts: 0,
      offline: false,
    };
  }

  const deviceId = await getDeviceId();
  const operations = claimed.map((item) => ({
    kind: item.kind,
    operationId: item.id,
    deviceId,
    attendanceSessionId: item.attendanceSessionId,
    payload: item.payload,
  }));

  let response: Response;
  try {
    response = await fetch(SYNC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operations }),
      // The cookie is the credential; `same-origin` is the default but is
      // spelled out because this is the one request in the app whose auth
      // failing silently would look like a network problem.
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Offline, DNS failure, timeout, captive portal. Every claimed item goes
    // back to PENDING with a backoff — none is failed, because "the network
    // did not answer" says nothing about whether the register is valid.
    await Promise.all(claimed.map((item) => scheduleRetry(item, "network_unreachable")));
    return {
      snapshot: await snapshotQueue(),
      attempted: claimed.length,
      applied: 0,
      duplicates: 0,
      conflicts: 0,
      offline: true,
    };
  }

  if (!response.ok) {
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 408;
    const reason = `http_${response.status}`;
    await Promise.all(
      claimed.map((item) =>
        // A 401 is treated as retryable on purpose: the cookie expired, the
        // teacher signs in again, and the same register syncs. Failing it
        // would ask a human to re-enter attendance the device already holds.
        permanent && response.status !== 401
          ? failItem(item, reason, false)
          : scheduleRetry(item, reason),
      ),
    );
    return {
      snapshot: await snapshotQueue(),
      attempted: claimed.length,
      applied: 0,
      duplicates: 0,
      conflicts: 0,
      offline: false,
    };
  }

  let batch: SyncBatchResult;
  try {
    batch = (await response.json()) as SyncBatchResult;
  } catch {
    await Promise.all(claimed.map((item) => scheduleRetry(item, "malformed_response")));
    return {
      snapshot: await snapshotQueue(),
      attempted: claimed.length,
      applied: 0,
      duplicates: 0,
      conflicts: 0,
      offline: false,
    };
  }

  const byId = new Map(batch.outcomes.map((o) => [o.operationId, o]));
  let applied = 0;
  let duplicates = 0;
  let conflicts = 0;

  for (const item of claimed) {
    const outcome = byId.get(item.id);
    if (!outcome) {
      // The server answered but said nothing about this operation. Retry — an
      // unacknowledged operation is an unsent one.
      await scheduleRetry(item, "no_outcome");
      continue;
    }
    await recordOutcome(item, outcome);
    if (outcome.status === "APPLIED") applied += outcome.applied;
    if (outcome.status === "DUPLICATE") duplicates += 1;
    if (outcome.status === "CONFLICT") conflicts += outcome.conflicts.length;
  }

  return {
    snapshot: await snapshotQueue(),
    attempted: claimed.length,
    applied,
    duplicates,
    conflicts,
    offline: false,
  };
}

// ---------------------------------------------------------------------------
// Outcome handling
// ---------------------------------------------------------------------------

async function recordOutcome(item: QueueRecord, outcome: SyncOperationOutcome): Promise<void> {
  const sessionId = outcome.attendanceSessionId;

  switch (outcome.status) {
    case "APPLIED":
    case "DUPLICATE": {
      // `DUPLICATE` is success. It is the server saying "I already have this",
      // which is exactly what a retry after a lost response should hear, and
      // the observable proof that syncing twice created nothing twice.
      await markSession(item, "SYNCED", sessionId, []);
      await deleteQueueItem(item.id);
      return;
    }
    case "CONFLICT": {
      // Terminal, and needs a person. The operation was ledgered server-side,
      // so it must not be retried — retrying would return the same conflict
      // forever. The disagreement is surfaced on /dashboard/offline.
      await updateQueueItem(item.id, (q) => ({
        ...q,
        status: "CONFLICT" as SyncStatus,
        attendanceSessionId: sessionId,
        conflicts: outcome.conflicts,
        lastError: null,
        retryable: false,
      }));
      await markSession(item, "CONFLICT", sessionId, outcome.conflicts);
      return;
    }
    case "REJECTED": {
      if (outcome.retryable) {
        await scheduleRetry(item, outcome.error ?? "rejected");
        return;
      }
      await failItem(item, outcome.error ?? "rejected", false);
      return;
    }
  }
}

async function markSession(
  item: QueueRecord,
  status: SyncStatus,
  serverSessionId: string | null,
  conflicts: SyncConflictList,
): Promise<void> {
  if (!item.localSessionId) return;
  await updateSession(item.localSessionId, (s) => ({
    ...s,
    syncStatus: status,
    serverSessionId: serverSessionId ?? s.serverSessionId,
    conflicts,
    updatedAt: new Date().toISOString(),
  }));
}

type SyncConflictList = QueueRecord["conflicts"];

/**
 * Puts an item back in PENDING with the next attempt time filled in, or parks
 * it once the attempt budget is spent.
 */
async function scheduleRetry(item: QueueRecord, reason: string): Promise<void> {
  const attempt = item.attemptCount;
  if (attempt >= MAX_ATTEMPTS) {
    await failItem(item, reason, true);
    return;
  }
  const delay = backoffDelayMs(attempt);
  await updateQueueItem(item.id, (q) => ({
    ...q,
    status: "PENDING" as SyncStatus,
    nextAttemptAt: new Date(Date.now() + delay).toISOString(),
    lastError: reason,
    retryable: true,
  }));
  if (item.localSessionId) {
    await updateSession(item.localSessionId, (s) => ({ ...s, syncStatus: "PENDING" }));
  }
}

/** Parks an item in FAILED. Never deletes it. */
async function failItem(item: QueueRecord, reason: string, retryable: boolean): Promise<void> {
  await updateQueueItem(item.id, (q) => ({
    ...q,
    status: "FAILED" as SyncStatus,
    lastError: reason,
    retryable,
  }));
  if (item.localSessionId) {
    await updateSession(item.localSessionId, (s) => ({ ...s, syncStatus: "FAILED" }));
  }
}

/**
 * Manual "Retry now" from the sync panel.
 *
 * Clears the attempt counter, because a human pressing Retry usually knows
 * something the backoff does not — they have just walked into the staff room
 * and onto a working network.
 */
export async function retryItem(id: string): Promise<void> {
  await updateQueueItem(id, (q) => ({
    ...q,
    status: "PENDING" as SyncStatus,
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    retryable: true,
  }));
}

/**
 * Resolves a conflict by re-queueing this device's answer as an explicit
 * correction.
 *
 * Deliberately a *new* operation with a *new* id rather than a retry of the
 * conflicted one. The teacher is making a fresh decision — "I saw this
 * student, override the server" — and it should land in the audit trail as
 * one, with its own `AttendanceCorrection` row, not as a replay of a
 * register whose conflict has already been recorded.
 */
export async function resolveConflictWithLocal(
  queueItemId: string,
  attendanceSessionId: string,
  studentId: string,
  result: "PRESENT" | "ABSENT",
): Promise<void> {
  await queueCorrection({
    localSessionId: null,
    attendanceSessionId,
    studentId,
    result,
    reason: "Offline conflict resolved in favour of the device's record",
  });
  await updateQueueItem(queueItemId, (q) => ({
    ...q,
    conflicts: q.conflicts.filter((c) => c.studentId !== studentId),
  }));
}

/** Accepts the server's answer: drop the conflict, keep nothing queued. */
export async function resolveConflictWithServer(
  queueItemId: string,
  studentId: string,
): Promise<void> {
  const next = await updateQueueItem(queueItemId, (q) => ({
    ...q,
    conflicts: q.conflicts.filter((c) => c.studentId !== studentId),
  }));
  // Once every disagreement is settled the operation is genuinely done: it was
  // applied server-side, and the only thing holding it in the queue was the
  // unanswered question.
  if (next && next.conflicts.length === 0) {
    await deleteQueueItem(next.id);
    if (next.localSessionId) {
      await updateSession(next.localSessionId, (s) => ({ ...s, syncStatus: "SYNCED", conflicts: [] }));
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export async function snapshotQueue(): Promise<QueueSnapshot> {
  const items = await listQueue();
  const snapshot: QueueSnapshot = { ...EMPTY_SNAPSHOT, total: items.length };
  for (const item of items) {
    if (item.status === "PENDING") snapshot.pending += 1;
    if (item.status === "SYNCING") snapshot.syncing += 1;
    if (item.status === "FAILED") snapshot.failed += 1;
    if (item.status === "CONFLICT") snapshot.conflicts += item.conflicts.length || 1;
    if (item.lastError) snapshot.lastError = item.lastError;
    if (
      item.status === "PENDING" &&
      item.nextAttemptAt &&
      (!snapshot.nextAttemptAt || item.nextAttemptAt < snapshot.nextAttemptAt)
    ) {
      snapshot.nextAttemptAt = item.nextAttemptAt;
    }
  }
  return snapshot;
}

/** Called once on startup, before the first drain. */
export async function recoverQueue(): Promise<void> {
  await releaseStaleClaims();
}
