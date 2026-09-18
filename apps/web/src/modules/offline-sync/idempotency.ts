import {
  OFFLINE_SYNC_METADATA_KEY,
  type AppliedOperation,
  type StoredOfflineSyncMetadata,
  type SyncOperationKind,
} from "./types";

/**
 * The replay guard, and the retry policy. Both pure.
 *
 * Everything in this file is a function of its arguments — no Prisma, no
 * `Date.now()`, no `Math.random()`. That is not stylistic: "the same operation
 * syncing twice must not create duplicate attendance" is the central claim of
 * this phase, and a claim worth making is a claim worth testing exhaustively
 * without a database.
 */

// ---------------------------------------------------------------------------
// The applied-operation ledger
// ---------------------------------------------------------------------------

/**
 * Reads the ledger out of an `AttendanceSession.metadata` blob.
 *
 * Total, and deliberately forgiving of shape: metadata is a JSON column that
 * other modules also write to, and a malformed or absent bucket must read as
 * "nothing applied yet" rather than throw. Returning `[]` is the safe
 * direction — it means an operation gets applied, and application is itself
 * idempotent at the database level via `AttendanceRecord @@unique([sessionId,
 * studentId])`. Throwing, or treating unknown shapes as "already applied",
 * would silently drop a register.
 */
export function appliedOperations(metadata: unknown): AppliedOperation[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const bucket = (metadata as Record<string, unknown>)[OFFLINE_SYNC_METADATA_KEY];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return [];
  const list = (bucket as Partial<StoredOfflineSyncMetadata>).appliedOperations;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is AppliedOperation =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as AppliedOperation).operationId === "string",
  );
}

/**
 * Has this exact operation already been applied to this session?
 *
 * Matched on `operationId` alone. The device id is stored alongside for the
 * audit trail, but two devices cannot share an operation id — it is generated
 * per operation with `crypto.randomUUID()` — and matching on the pair would
 * mean a device that regenerated its id could replay a register.
 */
export function hasApplied(metadata: unknown, operationId: string): AppliedOperation | null {
  return appliedOperations(metadata).find((op) => op.operationId === operationId) ?? null;
}

/** How many applied operations a session's ledger keeps before trimming. */
export const MAX_LEDGER_ENTRIES = 200;

/**
 * Returns the metadata patch that records an operation as applied.
 *
 * Merges rather than replaces: `AttendanceSession.metadata` also carries the
 * review module's `attendanceReview` bucket, and clobbering it would erase who
 * finalized a register.
 *
 * The ledger is trimmed to the most recent `MAX_LEDGER_ENTRIES`. A session is
 * synced by one or two devices a handful of times; a ledger that grows without
 * bound is a JSON column that eventually stops being readable. Trimming is
 * safe against the replay it guards — an operation old enough to fall off the
 * end has long since been acknowledged and deleted from its device's queue,
 * and re-applying it would in any case be an upsert to the same values.
 */
export function withAppliedOperation(
  metadata: unknown,
  entry: AppliedOperation,
  extra: Partial<StoredOfflineSyncMetadata> = {},
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const bucketRaw = base[OFFLINE_SYNC_METADATA_KEY];
  const bucket =
    bucketRaw && typeof bucketRaw === "object" && !Array.isArray(bucketRaw)
      ? (bucketRaw as Partial<StoredOfflineSyncMetadata>)
      : {};

  const existing = appliedOperations(metadata).filter((op) => op.operationId !== entry.operationId);
  const appended = [...existing, entry];
  const trimmed =
    appended.length > MAX_LEDGER_ENTRIES ? appended.slice(-MAX_LEDGER_ENTRIES) : appended;

  return {
    ...base,
    [OFFLINE_SYNC_METADATA_KEY]: {
      ...bucket,
      ...extra,
      appliedOperations: trimmed,
    } satisfies Partial<StoredOfflineSyncMetadata>,
  };
}

export function ledgerEntry(args: {
  operationId: string;
  deviceId: string;
  kind: SyncOperationKind;
  appliedAt: string;
  conflictCount?: number;
}): AppliedOperation {
  return {
    operationId: args.operationId,
    deviceId: args.deviceId,
    kind: args.kind,
    appliedAt: args.appliedAt,
    ...(args.conflictCount ? { conflictCount: args.conflictCount } : {}),
  };
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/** Base delay for the first retry. */
export const RETRY_BASE_MS = 1_000;
/** Ceiling, so a device offline overnight retries every five minutes, not every eight hours. */
export const RETRY_MAX_MS = 5 * 60_000;
/**
 * Attempts before an operation is parked in `FAILED`.
 *
 * Parked, not discarded: a `FAILED` item stays in IndexedDB, stays visible in
 * the sync panel, and has a "Retry" button. "Never silently lose attendance"
 * means the queue has no code path that deletes an item the server did not
 * acknowledge.
 */
export const MAX_ATTEMPTS = 8;

/**
 * Exponential backoff with full jitter.
 *
 * The jitter matters more than the exponent here. A school's classroom
 * devices all lose Wi-Fi together and all regain it together, so a
 * deterministic backoff would have thirty tablets retrying in lockstep at
 * t+1s, t+2s, t+4s — a thundering herd against a server that may itself have
 * just come back. Full jitter spreads them across the whole window.
 *
 * `random` is a parameter so the distribution can be tested rather than
 * hoped at.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  // Cap the exponent before shifting: 2 ** 1024 is Infinity, and Infinity
  // through Math.min is still Infinity on some paths.
  const uncapped = RETRY_BASE_MS * 2 ** Math.min(exponent, 20);
  const window = Math.min(uncapped, RETRY_MAX_MS);
  return Math.floor(random() * window);
}

/**
 * Whether an operation should be attempted now.
 *
 * Separate from the delay calculation so the queue can be driven by a clock in
 * tests instead of by `setTimeout`.
 */
export function isDue(
  item: { status: string; attemptCount: number; nextAttemptAt?: string | null },
  now: Date,
): boolean {
  if (item.status !== "PENDING") return false;
  if (item.attemptCount >= MAX_ATTEMPTS) return false;
  if (!item.nextAttemptAt) return true;
  return new Date(item.nextAttemptAt).getTime() <= now.getTime();
}
