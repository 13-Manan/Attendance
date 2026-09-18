import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCH_SIZE, MAX_MARKS_PER_SESSION, applySyncBatch } from "./service.ts";
import type { SyncDeps } from "./service.ts";
import { appliedOperations } from "./idempotency.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { SyncOperation } from "./types.ts";

/**
 * The claim under test is the one the whole phase rests on: *if the same
 * operation syncs twice, the database must not create duplicate attendance.*
 *
 * So these tests are not written against mock call-assertions. They run a
 * small in-memory stand-in for the attendance engine, replay real operations
 * against it, and compare the resulting **state** — records, corrections,
 * finalizations — between one pass and two. A test that only checked "the
 * ledger said DUPLICATE" would pass against an implementation that reported
 * duplicates while writing them.
 */

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

function makeUser(permissions: string[]): SessionUser {
  return {
    userId: "user-1",
    email: "teacher@example.com",
    name: "Teacher",
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

const TEACHER = makeUser(["attendanceSession.capture", "attendanceRecord.correct"]);
const ADMIN = makeUser([
  "attendanceSession.capture",
  "attendanceRecord.correct",
  "attendanceSession.finalize",
]);

// ---------------------------------------------------------------------------
// A fake attendance engine
// ---------------------------------------------------------------------------

interface FakeRecord {
  id: string;
  sessionId: string;
  studentId: string;
  aiResult: string;
  aiConfidence: number | null;
  finalResult: string;
  isManuallyCorrected: boolean;
}

interface FakeSession {
  id: string;
  status: "IN_PROGRESS" | "FINALIZED" | "CANCELLED";
  cohortId: string;
  cohortSubjectId: string | null;
  sessionDate: Date;
  metadata: unknown;
}

/**
 * Models exactly the invariants the real schema enforces, and nothing else:
 *
 * - one register per (cohort, subject, day) — `startOrResumeCaptureSession`
 * - one record per (session, student) — `@@unique([sessionId, studentId])`
 * - a correction whose result equals the current one writes nothing —
 *   `applyReviewDecision`
 *
 * If a replay produces a duplicate, it shows up here as a second correction
 * row or a second session, the same way it would in Postgres.
 */
function makeServer(roster: string[] = ["s1", "s2", "s3"]) {
  const sessions: FakeSession[] = [];
  const records: FakeRecord[] = [];
  const corrections: Array<{ recordId: string; newResult: string; reason?: string }> = [];
  const finalizations: string[] = [];
  let seq = 0;

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);

  const server = {
    sessions,
    records,
    corrections,
    finalizations,
    roster,
    /** A comparable fingerprint of everything that matters, for replay checks. */
    state() {
      return JSON.stringify({
        sessions: sessions.map((s) => ({ id: s.id, status: s.status })),
        records: records.map((r) => ({ studentId: r.studentId, finalResult: r.finalResult })),
        corrections,
        finalizations,
      });
    },
    deps(): SyncDeps {
      return {
        now: () => new Date("2026-09-16T12:00:00.000Z"),

        findSessionForDay: async (cohortId, cohortSubjectId, sessionDate) =>
          (sessions.find(
            (s) =>
              s.cohortId === cohortId &&
              s.cohortSubjectId === cohortSubjectId &&
              dayKey(s.sessionDate) === dayKey(sessionDate),
          ) ?? null) as never,

        getSessionById: async (id) => (sessions.find((s) => s.id === id) ?? null) as never,

        readSessionMetadata: async (sessionId) =>
          sessions.find((s) => s.id === sessionId)?.metadata ?? {},

        withLockedSessionMetadata: async (sessionId, apply) => {
          const session = sessions.find((s) => s.id === sessionId);
          if (!session) throw new Error("session_not_found");
          const { metadata, result } = await apply(session.metadata);
          session.metadata = metadata;
          return result;
        },

        listStudentNames: async (ids) =>
          new Map(ids.map((id) => [id, `Student ${id.toUpperCase()}`])),

        findRecordForStudent: async (sessionId, studentId) => {
          const found = records.find((r) => r.sessionId === sessionId && r.studentId === studentId);
          return found
            ? {
                id: found.id,
                finalResult: found.finalResult,
                isManuallyCorrected: found.isManuallyCorrected,
              }
            : null;
        },

        listAttendanceRecords: async (sessionId) =>
          records.filter((r) => r.sessionId === sessionId) as never,

        // The natural-key dedup the real capture service performs.
        startCaptureSession: (async (
          _actor: SessionUser,
          input: { cohortId: string; cohortSubjectId: string | null },
        ) => {
          const date = new Date("2026-09-16T09:00:00.000Z");
          const existing = sessions.find(
            (s) =>
              s.cohortId === input.cohortId &&
              s.cohortSubjectId === input.cohortSubjectId &&
              dayKey(s.sessionDate) === dayKey(date),
          );
          if (existing) return { session: existing };
          const session: FakeSession = {
            id: `sess-${(seq += 1)}`,
            status: "IN_PROGRESS",
            cohortId: input.cohortId,
            cohortSubjectId: input.cohortSubjectId,
            sessionDate: date,
            metadata: {},
          };
          sessions.push(session);
          return { session };
        }) as never,

        // Seeds the roster at NEEDS_REVIEW. Idempotent on (session, student).
        generateCandidates: (async (
          _actor: SessionUser,
          input: { sessionId: string },
        ) => {
          for (const studentId of roster) {
            if (records.some((r) => r.sessionId === input.sessionId && r.studentId === studentId)) {
              continue;
            }
            records.push({
              id: `rec-${input.sessionId}-${studentId}`,
              sessionId: input.sessionId,
              studentId,
              aiResult: "NEEDS_REVIEW",
              aiConfidence: null,
              finalResult: "NEEDS_REVIEW",
              isManuallyCorrected: false,
            });
          }
          return { candidates: [] };
        }) as never,

        // No-op when the result already matches — the real service's rule, and
        // the reason a replayed register writes no duplicate audit rows.
        applyDecision: (async (
          _actor: SessionUser,
          input: { attendanceRecordId: string; newResult: string; reason?: string },
        ) => {
          const record = records.find((r) => r.id === input.attendanceRecordId);
          if (!record) throw new Error("attendance_record_not_found");
          if (record.finalResult === input.newResult) return { record } as never;
          record.finalResult = input.newResult;
          record.isManuallyCorrected = true;
          corrections.push({
            recordId: record.id,
            newResult: input.newResult,
            reason: input.reason,
          });
          return { record } as never;
        }) as never,

        confirm: (async (_actor: SessionUser, sessionId: string) => {
          const session = sessions.find((s) => s.id === sessionId);
          if (!session) throw new Error("session_not_found");
          if (records.some((r) => r.sessionId === sessionId && r.finalResult === "NEEDS_REVIEW")) {
            throw new Error("unresolved_records");
          }
          session.status = "FINALIZED";
          finalizations.push(sessionId);
          return { session } as never;
        }) as never,
      };
    },
  };
  return server;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function sessionOp(overrides: Partial<{ operationId: string; marks: Array<{ studentId: string; result: "PRESENT" | "ABSENT" }>; finalizedLocally: boolean; cohortSubjectId: string | null }> = {}): SyncOperation {
  const marks = overrides.marks ?? [
    { studentId: "s1", result: "PRESENT" as const },
    { studentId: "s2", result: "ABSENT" as const },
    { studentId: "s3", result: "PRESENT" as const },
  ];
  return {
    kind: "attendance.session",
    operationId: overrides.operationId ?? "op-1",
    deviceId: "device-1",
    attendanceSessionId: null,
    payload: {
      cohortId: "cohort-1",
      cohortSubjectId: overrides.cohortSubjectId ?? null,
      sessionDate: "2026-09-16T09:00:00.000Z",
      marks: marks.map((m) => ({ ...m, markedAt: "2026-09-16T09:05:00.000Z" })),
      finalizedLocally: overrides.finalizedLocally ?? true,
      finalizedAt: "2026-09-16T09:30:00.000Z",
      markSource: "MANUAL",
      captureImageCount: 2,
    },
  };
}

function correctionOp(
  attendanceSessionId: string,
  overrides: Partial<{ operationId: string; studentId: string; result: "PRESENT" | "ABSENT" }> = {},
): SyncOperation {
  return {
    kind: "attendance.correction",
    operationId: overrides.operationId ?? "op-c1",
    deviceId: "device-1",
    attendanceSessionId,
    payload: {
      attendanceSessionId,
      studentId: overrides.studentId ?? "s2",
      result: overrides.result ?? "PRESENT",
      reason: "Arrived late, I saw them",
      correctedAt: "2026-09-16T10:00:00.000Z",
    },
  };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a finalized offline register syncs into a finalized server register", async () => {
  const server = makeServer();
  const result = await applySyncBatch(TEACHER, [sessionOp()], server.deps());

  assert.equal(result.outcomes.length, 1);
  const [outcome] = result.outcomes;
  assert.equal(outcome.status, "APPLIED");
  assert.equal(outcome.applied, 3);
  assert.deepEqual(outcome.conflicts, []);
  assert.equal(outcome.error, null);

  assert.equal(server.sessions.length, 1);
  assert.equal(server.sessions[0].status, "FINALIZED");
  assert.deepEqual(
    server.records.map((r) => [r.studentId, r.finalResult]),
    [
      ["s1", "PRESENT"],
      ["s2", "ABSENT"],
      ["s3", "PRESENT"],
    ],
  );
  assert.equal(server.finalizations.length, 1);
});

test("the roster is seeded unresolved, so a student nobody marked never becomes Present", async () => {
  const server = makeServer(["s1", "s2", "s3"]);
  // The device only marked two of the three students.
  const op = sessionOp({
    marks: [
      { studentId: "s1", result: "PRESENT" },
      { studentId: "s2", result: "ABSENT" },
    ],
  });
  const result = await applySyncBatch(TEACHER, [op], server.deps());

  // Finalization is refused by the engine because s3 is still unresolved. The
  // operation is rejected and retryable — nothing is lost, and crucially s3 is
  // not sitting in the database as PRESENT.
  assert.equal(result.outcomes[0].status, "REJECTED");
  const s3 = server.records.find((r) => r.studentId === "s3");
  assert.equal(s3?.finalResult, "NEEDS_REVIEW");
  assert.equal(server.finalizations.length, 0);
});

// ---------------------------------------------------------------------------
// Replay — the central claim
// ---------------------------------------------------------------------------

test("replaying the same operation is reported DUPLICATE and changes nothing", async () => {
  const server = makeServer();
  const op = sessionOp();

  const first = await applySyncBatch(TEACHER, [op], server.deps());
  const afterFirst = server.state();

  const second = await applySyncBatch(TEACHER, [op], server.deps());

  assert.equal(first.outcomes[0].status, "APPLIED");
  assert.equal(second.outcomes[0].status, "DUPLICATE");
  assert.equal(second.outcomes[0].applied, 0);
  assert.equal(second.outcomes[0].attendanceSessionId, first.outcomes[0].attendanceSessionId);
  assert.equal(server.state(), afterFirst, "a replay must not change server state");
  assert.equal(server.sessions.length, 1, "no duplicate register");
  assert.equal(server.corrections.length, 3, "no duplicate correction rows");
});

test("replaying ten times is identical to applying once", async () => {
  const server = makeServer();
  const op = sessionOp();
  await applySyncBatch(TEACHER, [op], server.deps());
  const afterFirst = server.state();

  for (let i = 0; i < 10; i += 1) {
    const result = await applySyncBatch(TEACHER, [op], server.deps());
    assert.equal(result.outcomes[0].status, "DUPLICATE");
  }

  assert.equal(server.state(), afterFirst);
  assert.equal(server.sessions.length, 1);
  assert.equal(server.corrections.length, 3);
  assert.equal(server.finalizations.length, 1);
});

test("the same operation twice in one batch is deduplicated within that batch", async () => {
  // The client should not send this, but a queue that retried without clearing
  // a claim could. The second copy must see the first's ledger entry.
  const server = makeServer();
  const op = sessionOp();
  const result = await applySyncBatch(TEACHER, [op, op], server.deps());

  assert.equal(result.outcomes[0].status, "APPLIED");
  assert.equal(result.outcomes[1].status, "DUPLICATE");
  assert.equal(server.sessions.length, 1);
  assert.equal(server.corrections.length, 3);
});

test("a replay whose ledger write was lost still writes no duplicate attendance", async () => {
  // The gap the design is honest about: apply succeeds, the ledger write is
  // lost to a crash. The operation is re-applied — and because every write is
  // an upsert or a no-op, the state is unchanged anyway.
  const server = makeServer();
  const deps = server.deps();
  const op = sessionOp();

  await applySyncBatch(TEACHER, [op], { ...deps, withLockedSessionMetadata: async () => null as never });
  const afterFirst = server.state();
  assert.equal(server.corrections.length, 3);

  const second = await applySyncBatch(TEACHER, [op], deps);

  // Not reported as a duplicate, because the ledger never recorded it — but
  // the state is untouched, which is the guarantee that actually matters.
  assert.equal(second.outcomes[0].status, "APPLIED");
  assert.equal(second.outcomes[0].applied, 0, "every mark already agreed, so nothing was written");
  assert.equal(server.state(), afterFirst);
  assert.equal(server.corrections.length, 3);
  assert.equal(server.sessions.length, 1);
});

test("a distinct operation for the same class and day resumes the register rather than duplicating it", async () => {
  const server = makeServer();
  await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-1", finalizedLocally: false })], server.deps());
  await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-2", finalizedLocally: false })],
    server.deps(),
  );

  assert.equal(server.sessions.length, 1, "one register per class per day");
  assert.equal(server.records.length, 3, "one record per student");
  assert.equal(server.corrections.length, 3, "the second pass agreed and wrote nothing");
});

test("the ledger records who synced and keeps one entry per operation", async () => {
  const server = makeServer();
  await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-1" })], server.deps());
  await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-1" })], server.deps());

  const ledger = appliedOperations(server.sessions[0].metadata);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].operationId, "op-1");
  assert.equal(ledger[0].deviceId, "device-1");
  assert.equal(ledger[0].kind, "attendance.session");
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

test("a mark that disagrees with a server-side human correction is a conflict, not an overwrite", async () => {
  const server = makeServer();
  // Somebody corrected s1 to ABSENT on the server while the device was away.
  await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-seed", finalizedLocally: false, marks: [] })],
    server.deps(),
  );
  const s1 = server.records.find((r) => r.studentId === "s1")!;
  s1.finalResult = "ABSENT";
  s1.isManuallyCorrected = true;
  const correctionsBefore = server.corrections.length;

  const result = await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-1" })],
    server.deps(),
  );

  const [outcome] = result.outcomes;
  assert.equal(outcome.status, "CONFLICT");
  assert.equal(outcome.conflicts.length, 1);
  assert.equal(outcome.conflicts[0].studentId, "s1");
  assert.equal(outcome.conflicts[0].localResult, "PRESENT");
  assert.equal(outcome.conflicts[0].serverResult, "ABSENT");
  assert.equal(outcome.conflicts[0].reason, "server_manually_corrected");
  // Named, so the teacher resolving it sees a person and not an id.
  assert.equal(outcome.conflicts[0].studentName, "Student S1");

  // The human's answer stands.
  assert.equal(s1.finalResult, "ABSENT");
  // The other two marks were still applied — a conflict over one student does
  // not discard the rest of the register.
  assert.equal(server.records.find((r) => r.studentId === "s2")?.finalResult, "ABSENT");
  assert.equal(server.records.find((r) => r.studentId === "s3")?.finalResult, "PRESENT");
  assert.ok(server.corrections.length > correctionsBefore);
});

test("a register with an unresolved conflict is never finalized", async () => {
  const server = makeServer();
  await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-seed", finalizedLocally: false, marks: [] })],
    server.deps(),
  );
  const s1 = server.records.find((r) => r.studentId === "s1")!;
  s1.finalResult = "ABSENT";
  s1.isManuallyCorrected = true;

  const result = await applySyncBatch(TEACHER, [sessionOp({ finalizedLocally: true })], server.deps());

  assert.equal(result.outcomes[0].status, "CONFLICT");
  assert.equal(server.finalizations.length, 0, "an undecided row must not become official");
  assert.equal(server.sessions[0].status, "IN_PROGRESS");
});

test("a student unenrolled while the device was offline is reported, not forced", async () => {
  const server = makeServer(["s1", "s2"]);
  const result = await applySyncBatch(
    TEACHER,
    [
      sessionOp({
        marks: [
          { studentId: "s1", result: "PRESENT" },
          { studentId: "s2", result: "PRESENT" },
          { studentId: "ghost", result: "PRESENT" },
        ],
      }),
    ],
    server.deps(),
  );

  const [outcome] = result.outcomes;
  assert.equal(outcome.status, "CONFLICT");
  assert.equal(outcome.conflicts.length, 1);
  assert.equal(outcome.conflicts[0].studentId, "ghost");
  assert.equal(outcome.conflicts[0].serverResult, "NOT_EVALUATED");
  assert.equal(server.records.some((r) => r.studentId === "ghost"), false);
});

test("marks against an already-finalized register conflict instead of reopening it", async () => {
  const server = makeServer();
  await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-1" })], server.deps());
  assert.equal(server.sessions[0].status, "FINALIZED");

  // A second device took the same class and finalized it differently.
  const result = await applySyncBatch(
    TEACHER,
    [
      sessionOp({
        operationId: "op-2",
        marks: [{ studentId: "s2", result: "PRESENT" }],
      }),
    ],
    server.deps(),
  );

  const [outcome] = result.outcomes;
  assert.equal(outcome.status, "CONFLICT");
  assert.equal(outcome.conflicts[0].reason, "session_already_finalized");
  assert.equal(server.records.find((r) => r.studentId === "s2")?.finalResult, "ABSENT");
  assert.equal(server.finalizations.length, 1);
});

test("a cancelled register is a permanent rejection, not an endless retry", async () => {
  const server = makeServer();
  await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-seed", finalizedLocally: false, marks: [] })], server.deps());
  server.sessions[0].status = "CANCELLED";

  const result = await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-1" })], server.deps());

  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.equal(result.outcomes[0].error, "session_cancelled");
  assert.equal(result.outcomes[0].retryable, false);
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

test("an offline correction applies once and replays as a duplicate", async () => {
  const server = makeServer();
  await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-1", finalizedLocally: false })],
    server.deps(),
  );
  const sessionId = server.sessions[0].id;
  const before = server.corrections.length;

  const op = correctionOp(sessionId, { studentId: "s2", result: "PRESENT" });
  const first = await applySyncBatch(TEACHER, [op], server.deps());
  const second = await applySyncBatch(TEACHER, [op], server.deps());

  assert.equal(first.outcomes[0].status, "APPLIED");
  assert.equal(first.outcomes[0].applied, 1);
  assert.equal(second.outcomes[0].status, "DUPLICATE");
  assert.equal(second.outcomes[0].applied, 0);
  assert.equal(server.corrections.length, before + 1, "exactly one correction row");
  assert.equal(server.records.find((r) => r.studentId === "s2")?.finalResult, "PRESENT");
  assert.equal(
    server.corrections.at(-1)?.reason,
    "Arrived late, I saw them",
    "the teacher's own reason reaches the audit trail",
  );
});

test("a correction to a finalized register needs the finalize permission", async () => {
  const server = makeServer();
  await applySyncBatch(TEACHER, [sessionOp({ operationId: "op-1" })], server.deps());
  const sessionId = server.sessions[0].id;
  const before = server.corrections.length;

  const op = correctionOp(sessionId, { operationId: "op-c1", studentId: "s2", result: "PRESENT" });

  const refused = await applySyncBatch(TEACHER, [op], server.deps());
  assert.equal(refused.outcomes[0].status, "REJECTED");
  assert.equal(refused.outcomes[0].error, "forbidden:attendance_finalized");
  assert.equal(refused.outcomes[0].retryable, false, "retrying will never help");
  assert.equal(server.corrections.length, before);

  const allowed = await applySyncBatch(
    ADMIN,
    [correctionOp(sessionId, { operationId: "op-c2", studentId: "s2", result: "PRESENT" })],
    server.deps(),
  );
  assert.equal(allowed.outcomes[0].status, "APPLIED");
  assert.equal(server.records.find((r) => r.studentId === "s2")?.finalResult, "PRESENT");
});

test("a correction that agrees with the server writes nothing but is still acknowledged", async () => {
  const server = makeServer();
  await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-1", finalizedLocally: false })],
    server.deps(),
  );
  const sessionId = server.sessions[0].id;
  const before = server.corrections.length;

  // s1 is already PRESENT on the server.
  const result = await applySyncBatch(
    TEACHER,
    [correctionOp(sessionId, { studentId: "s1", result: "PRESENT" })],
    server.deps(),
  );

  assert.equal(result.outcomes[0].status, "APPLIED");
  assert.equal(result.outcomes[0].applied, 0);
  assert.equal(server.corrections.length, before, "no audit row for a no-op");
});

test("a correction for a student who is not on the register is a permanent rejection", async () => {
  const server = makeServer();
  await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-1", finalizedLocally: false })],
    server.deps(),
  );

  const result = await applySyncBatch(
    TEACHER,
    [correctionOp(server.sessions[0].id, { studentId: "ghost" })],
    server.deps(),
  );

  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.equal(result.outcomes[0].error, "attendance_record_not_found");
  assert.equal(result.outcomes[0].retryable, false);
});

// ---------------------------------------------------------------------------
// Authorization and limits
// ---------------------------------------------------------------------------

test("a batch from a user who cannot capture is refused whole, before anything is written", async () => {
  const server = makeServer();
  const reader = makeUser(["attendanceRecord.read"]);

  await assert.rejects(
    () => applySyncBatch(reader, [sessionOp()], server.deps()),
    (error: unknown) => error instanceof ForbiddenError,
  );
  assert.equal(server.sessions.length, 0);
  assert.equal(server.records.length, 0);
});

test("capture without the correction permission is refused — an offline register is all corrections", async () => {
  const server = makeServer();
  const capturer = makeUser(["attendanceSession.capture"]);

  await assert.rejects(
    () => applySyncBatch(capturer, [sessionOp()], server.deps()),
    (error: unknown) => error instanceof ForbiddenError,
  );
  assert.equal(server.sessions.length, 0);
});

test("a permission failure inside an operation is a non-retryable rejection, not a batch crash", async () => {
  // The teacher passed the batch-level check but does not own this cohort.
  const server = makeServer();
  const deps: SyncDeps = {
    ...server.deps(),
    startCaptureSession: (async () => {
      throw new ForbiddenError("cohort_access_denied");
    }) as never,
  };

  const result = await applySyncBatch(TEACHER, [sessionOp(), correctionOp("sess-x")], deps);

  assert.equal(result.outcomes.length, 2, "every operation gets an answer");
  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.equal(result.outcomes[0].error, "forbidden:cohort_access_denied");
  assert.equal(result.outcomes[0].retryable, false);
});

test("a transient failure stays retryable so the queue keeps trying", async () => {
  const server = makeServer();
  const deps: SyncDeps = {
    ...server.deps(),
    startCaptureSession: (async () => {
      throw new Error("Connection terminated unexpectedly");
    }) as never,
  };

  const result = await applySyncBatch(TEACHER, [sessionOp()], deps);
  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.equal(result.outcomes[0].retryable, true, "a database blip must not park the register");
});

test("an oversized batch is refused rather than half-applied", async () => {
  const server = makeServer();
  const operations = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) =>
    sessionOp({ operationId: `op-${i}` }),
  );

  await assert.rejects(
    () => applySyncBatch(TEACHER, operations, server.deps()),
    /batch_too_large/,
  );
  assert.equal(server.sessions.length, 0);
});

test("an oversized register is rejected for that operation alone", async () => {
  const server = makeServer();
  const marks = Array.from({ length: MAX_MARKS_PER_SESSION + 1 }, (_, i) => ({
    studentId: `s${i}`,
    result: "PRESENT" as const,
  }));

  const result = await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-big", marks }), sessionOp({ operationId: "op-ok" })],
    server.deps(),
  );

  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.match(result.outcomes[0].error ?? "", /too_many_marks/);
  assert.equal(result.outcomes[0].retryable, false);
  // The rest of the batch still went through.
  assert.equal(result.outcomes[1].status, "APPLIED");
});

test("a malformed session date is rejected rather than opening a register on the epoch", async () => {
  const server = makeServer();
  const op = sessionOp();
  const result = await applySyncBatch(
    TEACHER,
    [{ ...op, payload: { ...op.payload, sessionDate: "not a date" } } as SyncOperation],
    server.deps(),
  );

  assert.equal(result.outcomes[0].status, "REJECTED");
  assert.equal(result.outcomes[0].error, "invalid_session_date");
  assert.equal(server.sessions.length, 0);
});

test("every operation in a mixed batch gets exactly one outcome, in order", async () => {
  const server = makeServer();
  const first = await applySyncBatch(
    TEACHER,
    [sessionOp({ operationId: "op-1", finalizedLocally: false })],
    server.deps(),
  );
  const sessionId = first.outcomes[0].attendanceSessionId!;

  const result = await applySyncBatch(
    TEACHER,
    [
      correctionOp(sessionId, { operationId: "op-a", studentId: "s2", result: "PRESENT" }),
      correctionOp(sessionId, { operationId: "op-b", studentId: "s3", result: "ABSENT" }),
      correctionOp("missing-session", { operationId: "op-c" }),
    ],
    server.deps(),
  );

  assert.deepEqual(
    result.outcomes.map((o) => o.operationId),
    ["op-a", "op-b", "op-c"],
  );
  assert.deepEqual(
    result.outcomes.map((o) => o.status),
    ["APPLIED", "APPLIED", "REJECTED"],
  );
  assert.ok(result.serverTime, "the client needs a server clock it can trust");
});
