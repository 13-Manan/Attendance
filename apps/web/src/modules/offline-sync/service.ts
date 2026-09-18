import type { SessionUser } from "@/modules/auth-tenancy/types";
import { ForbiddenError } from "@/modules/authorization/types";
import { hasPermission, requirePermission } from "@/modules/authorization/service";
import { startOrResumeCaptureSession } from "@/modules/attendance-capture/service";
import {
  applyReviewDecision,
  confirmAttendance,
  generateAttendanceCandidates,
} from "@/modules/attendance-review/service";
import { listAttendanceRecordRowsForSession } from "@/modules/attendance-review/repository";
import * as repo from "./repository";
import { hasApplied, ledgerEntry, withAppliedOperation } from "./idempotency";
import type {
  CorrectionSyncPayload,
  SessionSyncPayload,
  StoredOfflineSyncMetadata,
  SyncBatchResult,
  SyncConflict,
  SyncOperation,
  SyncOperationOutcome,
} from "./types";

/**
 * The server half of offline attendance.
 *
 * ## What this module promises
 *
 * 1. **Nothing is lost.** An operation the server cannot apply comes back with
 *    a reason and a `retryable` flag; it is never acknowledged as done.
 * 2. **Nothing is duplicated.** Replaying an operation produces the same
 *    database state as applying it once.
 * 3. **Nothing is silently overwritten.** Where this device and the server
 *    disagree about a student, both answers are returned and a human decides.
 *
 * ## How (2) is actually achieved — three layers, not one
 *
 * The explicit idempotency key is the visible mechanism, but it is the
 * *outermost* of three, and the inner two are what make the design safe even
 * if a ledger write is lost to a crash:
 *
 * - **The schema's natural keys.** A register is already unique per (cohort,
 *   day) for a school and per (cohort, subject, day) for a college, so
 *   replaying "open the class" resolves to the same row. `AttendanceRecord` is
 *   unique on `(sessionId, studentId)`, so replaying a mark is an upsert.
 * - **No-op correction writes.** `applyReviewDecision` refuses to write an
 *   `AttendanceCorrection` when the new result equals the current one, so a
 *   replayed register writes no audit rows the first pass did not write.
 * - **The operation ledger.** `(deviceId, operationId, attendanceSessionId)`
 *   recorded in `AttendanceSession.metadata` under a row lock. This is what
 *   lets the server *report* `DUPLICATE` rather than silently redoing
 *   harmless work, and what stops a genuinely non-idempotent replay — a
 *   correction that toggles a value back and forth — from being applied twice.
 *
 * Stated plainly because it matters for the schema question: the exactly-once
 * guarantee here does **not** depend on a unique index that this phase is
 * forbidden from adding. It depends on unique indexes the schema already has.
 * The ledger improves reporting and covers the toggle case; a dedicated
 * `SyncedOperation(deviceId, operationId)` table with a unique constraint is
 * the upgrade when a migration is in scope, and it would replace exactly two
 * functions in `idempotency.ts`.
 *
 * ## Authorization
 *
 * Every operation runs through the same services the online workflow uses —
 * `startOrResumeCaptureSession`, `generateAttendanceCandidates`,
 * `applyReviewDecision`, `confirmAttendance` — so a synced register is subject
 * to exactly the permission and cohort-ownership checks a register taken on a
 * desk would be. There is no "sync" bypass, and an offline device cannot
 * assert an institution: the tenant comes from the session cookie on the
 * request that carries the batch.
 */

type AsDep<F> = F extends (...args: infer A) => PromiseLike<infer R>
  ? (...args: A) => Promise<R>
  : never;

export interface SyncDeps {
  findSessionForDay?: AsDep<typeof repo.findSessionForDay>;
  getSessionById?: AsDep<typeof repo.getSessionById>;
  readSessionMetadata?: typeof repo.readSessionMetadata;
  withLockedSessionMetadata?: typeof repo.withLockedSessionMetadata;
  listStudentNames?: typeof repo.listStudentNames;
  findRecordForStudent?: AsDep<typeof repo.findRecordForStudent>;
  listAttendanceRecords?: AsDep<typeof listAttendanceRecordRowsForSession>;
  startCaptureSession?: typeof startOrResumeCaptureSession;
  generateCandidates?: typeof generateAttendanceCandidates;
  applyDecision?: typeof applyReviewDecision;
  confirm?: typeof confirmAttendance;
  now?: () => Date;
}

/**
 * The most operations one request may carry.
 *
 * A device that was offline for a week has a bounded queue anyway — one
 * register per class per day — but a cap keeps a single request from holding a
 * connection open for minutes. The client drains in batches; a partial drain
 * is not a failure, it is just the next batch.
 */
export const MAX_BATCH_SIZE = 25;

/** The most students one offline register may carry. */
export const MAX_MARKS_PER_SESSION = 500;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function applySyncBatch(
  actor: SessionUser,
  operations: SyncOperation[],
  deps: SyncDeps = {},
): Promise<SyncBatchResult> {
  // The same two permissions taking a register online requires. Checked once
  // here so a batch from a user who cannot capture is refused whole, rather
  // than per-operation after some have already been written.
  requirePermission(actor, "attendanceSession.capture");
  requirePermission(actor, "attendanceRecord.correct");

  const now = deps.now ?? (() => new Date());
  if (operations.length > MAX_BATCH_SIZE) {
    throw new Error(`batch_too_large:${operations.length}`);
  }

  const outcomes: SyncOperationOutcome[] = [];
  for (const operation of operations) {
    // Sequential, not `Promise.all`. Two operations in one batch may target
    // the same register — a session followed by a correction to it — and
    // running them concurrently would race the second against the first's
    // roster. Batches are small; the ordering guarantee is worth more than
    // the parallelism.
    outcomes.push(await applyOne(actor, operation, deps));
  }

  return { outcomes, serverTime: now().toISOString() };
}

async function applyOne(
  actor: SessionUser,
  operation: SyncOperation,
  deps: SyncDeps,
): Promise<SyncOperationOutcome> {
  try {
    return operation.kind === "attendance.session"
      ? await applySessionOperation(actor, operation.operationId, operation.deviceId, operation.payload, deps)
      : await applyCorrectionOperation(actor, operation.operationId, operation.deviceId, operation.payload, deps);
  } catch (error) {
    return rejected(operation.operationId, error);
  }
}

/**
 * Turns a thrown error into an outcome the client can act on.
 *
 * The `retryable` flag is the important half. A network blip should be retried
 * forever; a cohort that was deleted, or a teacher whose access was revoked,
 * never will be — and a client that backs off against a permanent wall looks
 * identical to one that has lost the data. Permanent failures are surfaced to
 * the teacher immediately instead.
 */
function rejected(operationId: string, error: unknown): SyncOperationOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const permanent =
    error instanceof ForbiddenError ||
    PERMANENT_ERRORS.some((code) => message.startsWith(code));
  return {
    operationId,
    status: "REJECTED",
    attendanceSessionId: null,
    conflicts: [],
    applied: 0,
    error: error instanceof ForbiddenError ? `forbidden:${error.reason}` : message,
    retryable: !permanent,
  };
}

/**
 * Errors that mean "this operation can never succeed", as opposed to "not
 * right now". Matched by prefix because several carry a suffix (`session_
 * locked:FINALIZED`).
 */
const PERMANENT_ERRORS = [
  "cohort_not_found",
  "institution_not_found",
  "cohort_subject_not_found",
  "cohort_subject_mismatch",
  "daily_mode_forbids_subject",
  "subject_wise_mode_requires_subject",
  "session_not_found",
  "session_cancelled",
  "attendance_record_not_found",
  "student_not_in_roster",
  "too_many_marks",
  "invalid_session_status",
];

// ---------------------------------------------------------------------------
// attendance.session — a whole offline register
// ---------------------------------------------------------------------------

async function applySessionOperation(
  actor: SessionUser,
  operationId: string,
  deviceId: string,
  payload: SessionSyncPayload,
  deps: SyncDeps,
): Promise<SyncOperationOutcome> {
  if (payload.marks.length > MAX_MARKS_PER_SESSION) {
    throw new Error(`too_many_marks:${payload.marks.length}`);
  }

  const now = deps.now ?? (() => new Date());
  const findSession = deps.findSessionForDay ?? repo.findSessionForDay;
  const readMetadata = deps.readSessionMetadata ?? repo.readSessionMetadata;
  const sessionDate = new Date(payload.sessionDate);
  if (Number.isNaN(sessionDate.getTime())) throw new Error("invalid_session_date");

  // --- Duplicate pre-check -------------------------------------------------
  // Cheap, and it is the common case: a retry after a response that was lost
  // in transit finds its own entry and stops here, touching nothing.
  const existing = await findSession(payload.cohortId, payload.cohortSubjectId, sessionDate);
  if (existing) {
    const applied = hasApplied(await readMetadata(existing.id), operationId);
    if (applied) {
      return {
        operationId,
        status: "DUPLICATE",
        attendanceSessionId: existing.id,
        conflicts: [],
        applied: 0,
        error: null,
        retryable: false,
      };
    }
  }

  // --- Open (or resume) the register --------------------------------------
  // Idempotent by the attendance engine's own unique-per-day rule, and the
  // place every authorization check happens. A register the teacher may not
  // touch throws here, before anything is written.
  const start = deps.startCaptureSession ?? startOrResumeCaptureSession;
  const generate = deps.generateCandidates ?? generateAttendanceCandidates;

  let sessionId: string;
  let alreadyFinalized = false;
  if (existing && (existing.status === "FINALIZED" || existing.status === "CANCELLED")) {
    // `startOrResumeCaptureSession` refuses to reopen these, correctly — a
    // finalized register is closed. Take the id directly and let the conflict
    // policy below decide what to do with the marks.
    if (existing.status === "CANCELLED") throw new Error("session_cancelled");
    sessionId = existing.id;
    alreadyFinalized = true;
  } else {
    const started = await start(actor, {
      cohortId: payload.cohortId,
      cohortSubjectId: payload.cohortSubjectId,
    });
    sessionId = started.session.id;
    // Seed the roster. `recognition: null` is the manual roll call the review
    // module already models — every student starts NEEDS_REVIEW and the
    // teacher's offline marks resolve them below. This is also what keeps an
    // offline register honest: no student is marked present by default, and
    // "we never looked" never becomes "present".
    await generate(actor, { sessionId, recognition: null });
  }

  // --- Apply the marks -----------------------------------------------------
  const listRecords = deps.listAttendanceRecords ?? listAttendanceRecordRowsForSession;
  const decide = deps.applyDecision ?? applyReviewDecision;
  const records = await listRecords(sessionId);
  const byStudent = new Map(records.map((r) => [r.studentId, r]));

  const conflicts: SyncConflict[] = [];
  let applied = 0;

  for (const mark of payload.marks) {
    const record = byStudent.get(mark.studentId);
    if (!record) {
      // The student is not on the server's roster for this register — they
      // were unenrolled while the device was offline. Not a failure of the
      // batch, and not something to force: reported as a conflict so the
      // teacher sees the mark was not applied and why.
      conflicts.push({
        studentId: mark.studentId,
        localResult: mark.result,
        serverResult: "NOT_EVALUATED",
        reason: "server_manually_corrected",
      });
      continue;
    }

    if (record.finalResult === mark.result) {
      // Already agrees. Nothing to write — this is the idempotent path a
      // replay takes, and the reason a replayed register produces no
      // duplicate AttendanceCorrection rows.
      continue;
    }

    // Conflict policy. An offline mark is a human decision, but so is a
    // correction already made on the server, and the server's is the more
    // recent knowledge of the two in every case we can distinguish. Neither
    // is discarded: the disagreement is returned for a person to settle.
    if (alreadyFinalized) {
      conflicts.push({
        studentId: mark.studentId,
        localResult: mark.result,
        serverResult: record.finalResult,
        reason: "session_already_finalized",
      });
      continue;
    }
    if (record.isManuallyCorrected) {
      conflicts.push({
        studentId: mark.studentId,
        localResult: mark.result,
        serverResult: record.finalResult,
        reason: "server_manually_corrected",
      });
      continue;
    }

    await decide(actor, {
      attendanceRecordId: record.id,
      newResult: mark.result,
      reason: "Synced from offline capture",
    });
    applied++;
  }

  // --- Finalize ------------------------------------------------------------
  // Only when the teacher finalized on the device, the register is not already
  // closed, and nothing is in dispute. Finalizing over an unresolved conflict
  // would be the exact failure this whole module exists to prevent: an
  // undecided row becoming an official result by omission.
  const confirm = deps.confirm ?? confirmAttendance;
  if (payload.finalizedLocally && !alreadyFinalized && conflicts.length === 0) {
    await confirm(actor, sessionId);
  }

  // --- Ledger --------------------------------------------------------------
  const appliedAt = now().toISOString();
  const lock = deps.withLockedSessionMetadata ?? repo.withLockedSessionMetadata;
  await lock(sessionId, async (metadata) => ({
    metadata: withAppliedOperation(
      metadata,
      ledgerEntry({
        operationId,
        deviceId,
        kind: "attendance.session",
        appliedAt,
        conflictCount: conflicts.length,
      }),
      {
        capturedOffline: true,
        capturedByDeviceId: deviceId,
        markSource: payload.markSource,
        ...(payload.finalizedAt ? { locallyFinalizedAt: payload.finalizedAt } : {}),
      } satisfies Partial<StoredOfflineSyncMetadata>,
    ),
    result: null,
  }));

  return {
    operationId,
    status: conflicts.length > 0 ? "CONFLICT" : "APPLIED",
    attendanceSessionId: sessionId,
    conflicts: await nameConflicts(conflicts, deps),
    applied,
    error: null,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// attendance.correction — one post-hoc fix
// ---------------------------------------------------------------------------

async function applyCorrectionOperation(
  actor: SessionUser,
  operationId: string,
  deviceId: string,
  payload: CorrectionSyncPayload,
  deps: SyncDeps,
): Promise<SyncOperationOutcome> {
  const now = deps.now ?? (() => new Date());
  const readMetadata = deps.readSessionMetadata ?? repo.readSessionMetadata;
  const findRecord = deps.findRecordForStudent ?? repo.findRecordForStudent;
  const sessionId = payload.attendanceSessionId;

  const metadata = await readMetadata(sessionId);
  if (hasApplied(metadata, operationId)) {
    return {
      operationId,
      status: "DUPLICATE",
      attendanceSessionId: sessionId,
      conflicts: [],
      applied: 0,
      error: null,
      retryable: false,
    };
  }

  const record = await findRecord(sessionId, payload.studentId);
  if (!record) throw new Error("attendance_record_not_found");

  // A correction to an already-closed register needs the finalize permission,
  // which is what the review module calls an ADMIN_OVERRIDE. Checked here so
  // the failure is a clean, non-retryable rejection rather than an exception
  // from three layers down.
  const session = await (deps.getSessionById ?? repo.getSessionById)(sessionId);
  if (!session) throw new Error("session_not_found");
  if (session.status === "FINALIZED" && !hasPermission(actor, "attendanceSession.finalize")) {
    throw new ForbiddenError("attendance_finalized");
  }

  let applied = 0;
  if (record.finalResult !== payload.result) {
    const decide = deps.applyDecision ?? applyReviewDecision;
    await decide(actor, {
      attendanceRecordId: record.id,
      newResult: payload.result,
      reason: payload.reason ?? "Synced from offline correction",
    });
    applied = 1;
  }

  const lock = deps.withLockedSessionMetadata ?? repo.withLockedSessionMetadata;
  await lock(sessionId, async (current) => ({
    metadata: withAppliedOperation(
      current,
      ledgerEntry({
        operationId,
        deviceId,
        kind: "attendance.correction",
        appliedAt: now().toISOString(),
      }),
    ),
    result: null,
  }));

  return {
    operationId,
    status: "APPLIED",
    attendanceSessionId: sessionId,
    conflicts: [],
    applied,
    error: null,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------

/**
 * Attaches student names to conflicts.
 *
 * Only for conflicts, and only names — a teacher resolving a disagreement
 * needs to know *who*, and an id is not an answer they can act on. One query
 * for a handful of rows; the happy path does none.
 */
async function nameConflicts(
  conflicts: SyncConflict[],
  deps: SyncDeps,
): Promise<SyncConflict[]> {
  if (conflicts.length === 0) return conflicts;
  const names = await (deps.listStudentNames ?? repo.listStudentNames)(
    conflicts.map((c) => c.studentId),
  );
  return conflicts.map((c) => ({ ...c, studentName: names.get(c.studentId) ?? undefined }));
}
