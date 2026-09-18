import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { applySyncBatch, MAX_BATCH_SIZE } from "@/modules/offline-sync/service";
import type { SyncOperation } from "@/modules/offline-sync/types";

/**
 * Where the offline queue drains.
 *
 * ## Why a route handler and not a Server Action
 *
 * A Server Action is a call made *by a React tree that is currently rendered*.
 * The queue drains from a background context — a `visibilitychange`, an
 * `online` event, a timer that fires while the teacher is on a different page —
 * and it needs things a Server Action does not give it cleanly:
 *
 * - **A status code it can branch on.** Retry policy is the whole job here. A
 *   503 means "back off and try again"; a 403 means "stop, and tell the
 *   teacher". A thrown Server Action error is one shape for both.
 * - **A response it can read without a rendered tree.** The queue must mark
 *   each item `SYNCED` / `CONFLICT` / `FAILED` in IndexedDB from the outcome
 *   array, with no component mounted.
 * - **An abortable request.** `AbortSignal` with a timeout, so a drain against
 *   a half-open connection on flaky school Wi-Fi fails in seconds instead of
 *   hanging until the tab is closed.
 *
 * ## The contract
 *
 * POST a batch of operations, each carrying its own idempotency key. Get back
 * one outcome per operation, in order, each independently `APPLIED`,
 * `DUPLICATE`, `CONFLICT`, or `REJECTED`. **A 200 does not mean everything
 * worked** — it means the server processed the batch and is telling you,
 * per operation, what happened. That distinction is what keeps a partial
 * failure from either being lost or forcing a whole batch to replay.
 *
 * A non-200 means *nothing* was durably decided for any operation, and the
 * whole batch stays `PENDING` on the device. Replaying it is safe by
 * construction: that is what the idempotency keys are for.
 *
 * ## Authorization
 *
 * From the session cookie, exactly as every other write path. The batch body
 * carries no institution, no user, and no role, and the device cannot assert
 * any: `deviceId` is an audit label, never a credential. A tablet that syncs
 * while signed in as someone else writes as that someone else, with their
 * permissions and their cohorts — which is correct, and is why the sync
 * service calls the same capture/review services the online UI does rather
 * than writing to Prisma itself.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Roughly 500 students × 2 short strings, plus slack. */
const MAX_BODY_BYTES = 512 * 1024;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    // 401 and not 403: the queue treats this as "sign in again", keeps every
    // item PENDING, and shows the teacher a sign-in prompt. Attendance sitting
    // in IndexedDB behind an expired cookie is not lost attendance.
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (
    !hasPermission(user, "attendanceSession.capture") ||
    !hasPermission(user, "attendanceRecord.correct")
  ) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "batch_too_large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const operations = parseOperations(body);
  if (!operations) {
    return Response.json({ error: "invalid_batch" }, { status: 400 });
  }
  if (operations.length > MAX_BATCH_SIZE) {
    return Response.json({ error: "batch_too_large" }, { status: 413 });
  }
  if (operations.length === 0) {
    return Response.json({ outcomes: [], serverTime: new Date().toISOString() });
  }

  try {
    const result = await applySyncBatch(user, operations);
    return Response.json(result, {
      // Nothing about a sync response is cacheable, and a proxy that decided
      // otherwise would serve a stale "APPLIED" for an operation that never
      // ran.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return Response.json({ error: `forbidden:${error.reason}` }, { status: 403 });
    }
    // 503, not 500. The queue's rule is "retry 5xx with backoff, surface 4xx",
    // and an unexpected server fault is exactly the case where retrying later
    // is the right behaviour — the register must not be dropped because the
    // database was restarting.
    console.error("[sync] batch failed", error);
    return Response.json({ error: "sync_failed" }, { status: 503 });
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Validates the batch shape.
 *
 * Structural only — it checks that the fields the service will read are
 * present and of the right primitive type, and nothing about whether a cohort
 * exists or a teacher may touch it. Those are authorization and business
 * questions, and they are answered by the services the sync engine calls, not
 * by a parser at the edge. The point of this function is narrower: a malformed
 * body must produce a clean 400 rather than a 503 that the device then retries
 * forever.
 *
 * Returns `null` for "not a valid batch" rather than throwing, because the
 * caller's response to that is a status code, not a stack trace.
 */
function parseOperations(body: unknown): SyncOperation[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { operations?: unknown }).operations;
  if (!Array.isArray(raw)) return null;

  const operations: SyncOperation[] = [];
  for (const entry of raw) {
    const op = parseOperation(entry);
    if (!op) return null;
    operations.push(op);
  }
  return operations;
}

function parseOperation(entry: unknown): SyncOperation | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (!isNonEmptyString(e.operationId) || !isNonEmptyString(e.deviceId)) return null;
  if (e.attendanceSessionId !== null && !isNonEmptyString(e.attendanceSessionId)) return null;
  const key = {
    operationId: e.operationId,
    deviceId: e.deviceId,
    attendanceSessionId: e.attendanceSessionId as string | null,
  };

  const payload = e.payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (e.kind === "attendance.session") {
    if (!isNonEmptyString(p.cohortId)) return null;
    if (p.cohortSubjectId !== null && !isNonEmptyString(p.cohortSubjectId)) return null;
    if (!isNonEmptyString(p.sessionDate)) return null;
    if (!Array.isArray(p.marks)) return null;
    const marks = p.marks.map(parseMark);
    if (marks.some((m) => m === null)) return null;
    return {
      kind: "attendance.session",
      ...key,
      payload: {
        cohortId: p.cohortId,
        cohortSubjectId: p.cohortSubjectId as string | null,
        sessionDate: p.sessionDate,
        marks: marks as NonNullable<(typeof marks)[number]>[],
        finalizedLocally: p.finalizedLocally === true,
        finalizedAt: isNonEmptyString(p.finalizedAt) ? p.finalizedAt : null,
        markSource: p.markSource === "LOCAL_AI_ASSISTED" ? "LOCAL_AI_ASSISTED" : "MANUAL",
        captureImageCount: typeof p.captureImageCount === "number" ? p.captureImageCount : 0,
      },
    };
  }

  if (e.kind === "attendance.correction") {
    if (!isNonEmptyString(p.attendanceSessionId)) return null;
    if (!isNonEmptyString(p.studentId)) return null;
    if (!isDecidedResult(p.result)) return null;
    return {
      kind: "attendance.correction",
      ...key,
      payload: {
        attendanceSessionId: p.attendanceSessionId,
        studentId: p.studentId,
        result: p.result,
        reason: isNonEmptyString(p.reason) ? p.reason : null,
        correctedAt: isNonEmptyString(p.correctedAt) ? p.correctedAt : new Date().toISOString(),
      },
    };
  }

  return null;
}

function parseMark(value: unknown): { studentId: string; result: "PRESENT" | "ABSENT"; markedAt: string } | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (!isNonEmptyString(m.studentId)) return null;
  // Only decided results cross the wire. NEEDS_REVIEW is not a queueable
  // answer: finalization refuses it, so accepting it here would mean storing a
  // register the server can never close — a silent loss wearing a sync badge.
  if (!isDecidedResult(m.result)) return null;
  return {
    studentId: m.studentId,
    result: m.result,
    markedAt: isNonEmptyString(m.markedAt) ? m.markedAt : new Date().toISOString(),
  };
}

function isDecidedResult(value: unknown): value is "PRESENT" | "ABSENT" {
  return value === "PRESENT" || value === "ABSENT";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
