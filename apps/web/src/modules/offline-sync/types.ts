import type { AttendanceResult } from "@/modules/attendance/types";

/**
 * The offline attendance contract.
 *
 * Offline capture is a **first-class workflow**, not an error path. A teacher
 * in a classroom with no signal opens the class, takes the register, and
 * finalizes it. The device holds that register durably; the network's job is
 * only to carry it to the server, later, exactly once.
 *
 * Three things are kept deliberately separate, because conflating them is how
 * an offline feature ends up lying to the person using it:
 *
 * 1. **The offline web workflow** — always available. Needs no network and no
 *    AI. This is the guarantee.
 * 2. **Local AI availability** — probed, never assumed. See `LocalAiStatus`.
 *    When no local inference node answers, the register is taken by hand and
 *    the UI says so plainly.
 * 3. **Server synchronization** — the queue in this module. Independent of
 *    both: a register marked by hand syncs the same way one processed by a
 *    local AI node does.
 */

// ---------------------------------------------------------------------------
// Queue item state
// ---------------------------------------------------------------------------

/**
 * The lifecycle of one queued operation.
 *
 * `OFFLINE` is deliberately **not** in this union. Being offline is a property
 * of the device, not of an operation: a queued register is `PENDING` whether
 * the radio is off or the server is simply unreachable, and the UI composes
 * the two ("Offline · 2 pending") rather than overwriting one with the other.
 *
 * `CONFLICT` is terminal and needs a human. It means the server already holds
 * a different answer for the same register — typically because another device
 * finalized it — and this device's copy was neither discarded nor allowed to
 * overwrite it. See `SyncConflict`.
 */
export type SyncStatus = "PENDING" | "SYNCING" | "SYNCED" | "FAILED" | "CONFLICT";

/** Terminal states: nothing further will be attempted without a human. */
export const TERMINAL_SYNC_STATUSES: readonly SyncStatus[] = ["SYNCED", "CONFLICT"];

export interface OfflineQueueItem<TPayload = unknown> {
  id: string;
  kind: string;
  payload: TPayload;
  status: SyncStatus;
  createdAt: string;
  lastAttemptAt?: string;
  attemptCount: number;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * The key that makes replay safe.
 *
 * Every attendance operation carries all three parts. `operationId` alone
 * would be enough for uniqueness, but the other two make the ledger *legible*
 * — when a register syncs twice, the audit trail says which device sent it and
 * which session it belonged to, not just that some uuid was seen before.
 *
 * `operationId` is generated on the device when the operation is created, not
 * when it is sent. That is the whole point: a retry after a lost response
 * carries the *same* key as the attempt whose reply never arrived, which is
 * the only case where a duplicate could otherwise be written.
 */
export interface IdempotencyKey {
  /** Stable per browser profile, generated once and stored in IndexedDB. */
  deviceId: string;
  /**
   * Who was signed in when this operation was created, as a *claim of intent*
   * — never as authorization.
   *
   * The actor is still resolved from the session cookie, exactly as before.
   * This field exists so the server can refuse a mismatch rather than act on
   * it. A classroom tablet is shared: one teacher takes a register offline,
   * signs out, and the next signs in. Without this, that queue drains under
   * the second teacher's session and their name goes on the first teacher's
   * attendance decisions — which is not a permission failure the server could
   * otherwise detect, because the second teacher may legitimately teach that
   * class.
   *
   * Optional because a queue item created before this field existed has no
   * owner recorded. Those are treated as unowned and are the one case the
   * server still accepts, so an upgrade does not strand attendance that was
   * already queued.
   */
  ownerUserId?: string;
  /**
   * Payload format, so an app update can recognise an operation it does not
   * understand instead of misreading it.
   *
   * Absent means version 1 — everything queued before versioning existed.
   */
  schemaVersion?: number;
  /** Unique per operation, generated at queue time and never regenerated. */
  operationId: string;
  /**
   * The server-side session this operation targets, once known. Null while the
   * session exists only on the device — the server resolves it from
   * (cohort, subject, date), which is already unique.
   */
  attendanceSessionId: string | null;
}

/** One entry in a session's applied-operation ledger. */
export interface AppliedOperation {
  operationId: string;
  deviceId: string;
  kind: SyncOperationKind;
  appliedAt: string;
  /** Present when the operation was accepted but some marks conflicted. */
  conflictCount?: number;
}

/**
 * Where the ledger lives.
 *
 * `AttendanceSession.metadata` — the same JSON column the review module
 * already uses for `finalizedBy`/`finalizedAt`, and for the same reason: this
 * phase must not change the database schema. A dedicated
 * `SyncedOperation` table with a unique index on (deviceId, operationId) is
 * the migration to run when a schema change is in scope; the ledger is read
 * and written through `appliedOperations()` / `withAppliedOperation()` so that
 * swap touches two functions.
 *
 * Until then the guarantee is upheld by a row lock: the ledger is read and
 * written inside one `SELECT ... FOR UPDATE` transaction, so two devices
 * replaying the same operation concurrently cannot both see an empty ledger.
 */
export const OFFLINE_SYNC_METADATA_KEY = "offlineSync";

export interface StoredOfflineSyncMetadata {
  appliedOperations: AppliedOperation[];
  /** Set when this register was taken on a device with no connectivity. */
  capturedOffline?: boolean;
  /** Which device took it, for the audit trail. */
  capturedByDeviceId?: string;
  /** When the teacher finalized it locally — not when it reached the server. */
  locallyFinalizedAt?: string;
  /** What produced the marks. See `LocalAiStatus`. */
  markSource?: OfflineMarkSource;
}

/**
 * How an offline register's marks were produced.
 *
 * Recorded because "the teacher marked this by hand on a tablet with no
 * signal" and "a local AI node proposed it and the teacher confirmed" are
 * different provenance, and the second must never be claimed for the first.
 */
export type OfflineMarkSource = "MANUAL" | "LOCAL_AI_ASSISTED";

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * The payload format this build writes and understands.
 *
 * Bumped only for a change the server cannot read compatibly. An operation
 * arriving with a *higher* version came from a newer build than the one
 * processing it, which happens when a tab has been open across a deploy; it
 * is rejected as permanent rather than guessed at, and the device is told to
 * reload.
 */
export const SYNC_SCHEMA_VERSION = 1;

export type SyncOperationKind = "attendance.session" | "attendance.correction";

/** One student's result, as decided on the device. */
export interface OfflineMark {
  studentId: string;
  /**
   * Only a decided result. An offline register cannot queue `NEEDS_REVIEW` or
   * `NOT_EVALUATED` as a *final* answer — finalization refuses unresolved rows
   * on the server, and queueing something the server will refuse is a silent
   * loss dressed up as a sync.
   */
  result: Extract<AttendanceResult, "PRESENT" | "ABSENT">;
  /** Device clock. Advisory only — the server never trusts it for ordering. */
  markedAt: string;
}

/**
 * A whole offline register: open the class, seed the roster, apply the marks,
 * and (if the teacher finalized on the device) close it.
 *
 * Deliberately one operation rather than four. Attendance is taken as a unit,
 * and a partially-applied register — roster created, marks missing — is a
 * worse thing to leave on a server than one that has not arrived yet.
 */
export interface SessionSyncPayload {
  cohortId: string;
  cohortSubjectId: string | null;
  /** The date the class actually happened, from the device. */
  sessionDate: string;
  marks: OfflineMark[];
  /** True when the teacher pressed Confirm on the device. */
  finalizedLocally: boolean;
  finalizedAt: string | null;
  markSource: OfflineMarkSource;
  /** Images captured offline, if any reached the device's store. */
  captureImageCount: number;
}

/**
 * A correction made offline to a register that was already synced — typically
 * a post-finalization fix the teacher made on the bus home.
 *
 * Keyed by (sessionId, studentId) rather than by `attendanceRecordId`: the
 * device may never have seen the server's record id, and (sessionId,
 * studentId) is unique in the schema anyway.
 */
export interface CorrectionSyncPayload {
  attendanceSessionId: string;
  studentId: string;
  result: Extract<AttendanceResult, "PRESENT" | "ABSENT">;
  reason: string | null;
  correctedAt: string;
}

export type SyncOperation =
  | ({ kind: "attendance.session"; payload: SessionSyncPayload } & IdempotencyKey)
  | ({ kind: "attendance.correction"; payload: CorrectionSyncPayload } & IdempotencyKey);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * A disagreement the server refused to resolve on its own.
 *
 * Attendance is somebody's record. When this device says PRESENT and the
 * server already holds a human-made ABSENT, neither "last write wins" nor
 * "drop it" is acceptable — the first overwrites a decision a person made, the
 * second loses one. Both answers are reported back and a human picks.
 */
export interface SyncConflict {
  studentId: string;
  studentName?: string;
  /** What this device recorded. */
  localResult: AttendanceResult;
  /** What the server already held. */
  serverResult: AttendanceResult;
  reason: SyncConflictReason;
}

export type SyncConflictReason =
  /** The server's row was corrected by a human; an offline mark must not win. */
  | "server_manually_corrected"
  /** The register was already finalized, with a different answer. */
  | "session_already_finalized";

export type SyncOutcomeStatus = "APPLIED" | "DUPLICATE" | "CONFLICT" | "REJECTED";

export interface SyncOperationOutcome {
  operationId: string;
  status: SyncOutcomeStatus;
  /** Set once the server resolved or created the session. */
  attendanceSessionId: string | null;
  conflicts: SyncConflict[];
  /** How many marks were actually written. Zero for a duplicate. */
  applied: number;
  /**
   * Set only for `REJECTED`. A stable code, not a sentence — the client maps
   * it to a message and decides whether a retry could ever help.
   */
  error: string | null;
  /**
   * False when retrying could never succeed (the cohort was deleted, the
   * teacher lost access). The client stops retrying and surfaces it rather
   * than backing off forever against a wall.
   */
  retryable: boolean;
}

export interface SyncBatchResult {
  outcomes: SyncOperationOutcome[];
  /** Server clock, so a device with a wrong clock can show honest timestamps. */
  serverTime: string;
}

// ---------------------------------------------------------------------------
// Local AI
// ---------------------------------------------------------------------------

/**
 * Whether a local inference node is actually reachable — probed, never assumed.
 *
 * The brief's rule, and the right one: *do not pretend full offline AI works if
 * the local AI runtime is not actually available.* So this is a real network
 * probe with a short timeout, and every state below is rendered to the teacher
 * in words rather than collapsed into a spinner.
 *
 * - `UNCONFIGURED` — no local node address is set for this institution. The
 *   common case, and not an error: the register is taken by hand.
 * - `CHECKING` — a probe is in flight.
 * - `AVAILABLE` — a node answered `/v1/health` and reported a usable model.
 * - `UNAVAILABLE` — configured but nothing answered, or it answered without a
 *   usable model. Capture continues; marking is manual.
 *
 * Note what `AVAILABLE` does *not* mean: it does not mean faces can be matched
 * in the browser. Face templates are biometric data and never leave the
 * server — see ARCHITECTURE.md. A reachable local node means the institution
 * is running the stack on its own network, so recognition works over the LAN
 * with no internet; it does not mean the tablet can identify anyone by itself.
 */
export type LocalAiStatus = "UNCONFIGURED" | "CHECKING" | "AVAILABLE" | "UNAVAILABLE";

export interface LocalAiProbeResult {
  status: LocalAiStatus;
  /** Present when a node answered. */
  modelName: string | null;
  modelVersion: string | null;
  /** Round-trip of the probe, for the diagnostics panel. */
  latencyMs: number | null;
  checkedAt: string;
  /** A stable code when the probe failed: "timeout", "unreachable", "no_model". */
  error: string | null;
}
