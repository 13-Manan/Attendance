import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { PostgresAttendanceEventPublisher } from "./publisher-postgres.ts";
import type { AttendanceRealtimeEvent, StudentAttendanceUpdatedEvent } from "./types.ts";

/**
 * Phase 15 — an event published by one replica reaches subscribers on another.
 *
 * Each `PostgresAttendanceEventPublisher` here owns its own listener socket
 * and its own in-process subscriber table, which is exactly what two replicas
 * are. Publishing through one and asserting on the other is therefore the real
 * property, not a simulation of it: nothing in this file shares memory between
 * "A" and "B" except the database.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

let A: PostgresAttendanceEventPublisher;
let B: PostgresAttendanceEventPublisher;

const url = () => process.env.DATABASE_URL as string;

/** Waits for a listener socket to be established, so a publish cannot race the
 * LISTEN that is supposed to receive it. */
async function ready(...publishers: PostgresAttendanceEventPublisher[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (publishers.every((p) => p.listening)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("listener did not connect within 5s");
}

/** Resolves with the first event on `subscribe`, or null if none arrives. */
function nextEvent<T>(
  register: (listener: (event: T) => void) => () => void,
  timeoutMs = 2_000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const off = register((event) => {
      clearTimeout(timer);
      off();
      resolve(event);
    });
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
  });
}

function recordEvent(sessionId: string): AttendanceRealtimeEvent {
  return {
    type: "attendance-record-updated",
    sessionId,
    record: {
      id: "rec-1",
      sessionId,
      studentId: "stu-1",
      aiResult: "PRESENT",
      aiConfidence: 0.9,
      finalResult: "PRESENT",
      isManuallyCorrected: true,
    },
    counts: { present: 1, absent: 0, needsReview: 0, notEvaluated: 0, total: 1 },
    occurredAt: new Date().toISOString(),
  } as AttendanceRealtimeEvent;
}

function studentEvent(sessionId: string, studentId: string): StudentAttendanceUpdatedEvent {
  return {
    type: "student-attendance-updated",
    sessionId,
    studentId,
    finalResult: "PRESENT",
    isFinalized: false,
    occurredAt: new Date().toISOString(),
  } as StudentAttendanceUpdatedEvent;
}

before(async () => {
  if (SKIP) return;
  A = new PostgresAttendanceEventPublisher(url());
  B = new PostgresAttendanceEventPublisher(url());
});

after(async () => {
  if (SKIP) return;
  await A?.close();
  await B?.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Cross-instance delivery — the blocker this phase exists to clear
// ---------------------------------------------------------------------------

test("an event published on A reaches a subscriber on B", { skip: SKIP }, async () => {
  const sessionId = "xinst-session-1";
  const received = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(sessionId, l));
  await ready(B);

  A.publish(recordEvent(sessionId));

  const event = await received;
  assert.ok(event, "B never received the event published by A");
  assert.equal(event.type, "attendance-record-updated");
  assert.equal(event.sessionId, sessionId);
});

test("and the reverse: published on B, received on A", { skip: SKIP }, async () => {
  const sessionId = "xinst-session-2";
  const received = nextEvent<AttendanceRealtimeEvent>((l) => A.subscribe(sessionId, l));
  await ready(A);

  B.publish(recordEvent(sessionId));

  const event = await received;
  assert.ok(event, "A never received the event published by B");
  assert.equal(event.sessionId, sessionId);
});

test("a publisher's own subscribers still receive its events", { skip: SKIP }, async () => {
  // Delivery goes out to Postgres and back on every instance, including the
  // one that published. Uniform, and it is why nothing is delivered twice.
  const sessionId = "xinst-session-3";
  const received = nextEvent<AttendanceRealtimeEvent>((l) => A.subscribe(sessionId, l));
  await ready(A);

  A.publish(recordEvent(sessionId));
  assert.ok(await received);
});

test("three clients across two instances all receive one event", { skip: SKIP }, async () => {
  const sessionId = "xinst-session-4";
  const onA1 = nextEvent<AttendanceRealtimeEvent>((l) => A.subscribe(sessionId, l));
  const onA2 = nextEvent<AttendanceRealtimeEvent>((l) => A.subscribe(sessionId, l));
  const onB1 = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(sessionId, l));
  await ready(A, B);

  B.publish(recordEvent(sessionId));

  const all = await Promise.all([onA1, onA2, onB1]);
  assert.ok(all.every(Boolean), "every subscriber should have been reached");
});

// ---------------------------------------------------------------------------
// Scoping — the transport must not become a broadcast
// ---------------------------------------------------------------------------

test("a subscriber to one session never sees another session's event", { skip: SKIP }, async () => {
  const mine = "xinst-mine";
  const theirs = "xinst-theirs";

  const leaked = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(mine, l), 1_000);
  const expected = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(theirs, l), 1_000);
  await ready(B);

  A.publish(recordEvent(theirs));

  assert.equal(await leaked, null, "an event crossed into another session's channel");
  assert.ok(await expected, "and the intended subscriber still got it");
});

test("a student never receives another student's event", { skip: SKIP }, async () => {
  // Two students in different institutions. The transport is shared; the
  // channel is not.
  const leaked = nextEvent<StudentAttendanceUpdatedEvent>(
    (l) => B.subscribeToStudent("student-tenant-a", l),
    1_000,
  );
  const expected = nextEvent<StudentAttendanceUpdatedEvent>(
    (l) => B.subscribeToStudent("student-tenant-b", l),
    1_000,
  );
  await ready(B);

  A.publishToStudent("student-tenant-b", studentEvent("sess-x", "student-tenant-b"));

  assert.equal(await leaked, null, "one student received another student's attendance");
  const got = await expected;
  assert.ok(got);
  assert.equal(got.studentId, "student-tenant-b");
});

test("a session subscriber does not receive student-channel events", { skip: SKIP }, async () => {
  // The two channel families are an authorization boundary, not a naming
  // convention: a student's private event must not reach a session board and
  // vice versa.
  const sessionSide = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe("sess-y", l), 1_000);
  await ready(B);

  A.publishToStudent("some-student", studentEvent("sess-y", "some-student"));

  assert.equal(await sessionSide, null);
});

test("unsubscribing actually stops delivery", { skip: SKIP }, async () => {
  const sessionId = "xinst-unsub";
  let calls = 0;
  const off = B.subscribe(sessionId, () => {
    calls += 1;
  });
  await ready(B);
  off();

  A.publish(recordEvent(sessionId));
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(calls, 0, "a released subscriber kept receiving");
});

// ---------------------------------------------------------------------------
// Restart and reconnect
// ---------------------------------------------------------------------------

test("a restarted instance receives events again", { skip: SKIP }, async () => {
  const sessionId = "xinst-restart";

  // C is a third replica that goes away and comes back, as in a rolling deploy.
  let C = new PostgresAttendanceEventPublisher(url());
  const before = nextEvent<AttendanceRealtimeEvent>((l) => C.subscribe(sessionId, l));
  await ready(C);
  A.publish(recordEvent(sessionId));
  assert.ok(await before, "the pre-restart event should arrive");

  await C.close();

  C = new PostgresAttendanceEventPublisher(url());
  const after = nextEvent<AttendanceRealtimeEvent>((l) => C.subscribe(sessionId, l));
  await ready(C);
  A.publish(recordEvent(sessionId));
  assert.ok(await after, "the restarted instance never reconnected");

  await C.close();
});

test("the surviving instance keeps working while another is down", { skip: SKIP }, async () => {
  const sessionId = "xinst-rolling";
  const D = new PostgresAttendanceEventPublisher(url());
  const onD = nextEvent<AttendanceRealtimeEvent>((l) => D.subscribe(sessionId, l));
  await ready(D);
  await D.close();

  // D is gone. A and B must be unaffected.
  const onB = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(sessionId, l));
  await ready(B);
  A.publish(recordEvent(sessionId));

  assert.ok(await onB, "a departing replica disrupted the others");
  // D was closed before the publish; at-most-once means it simply missed it.
  assert.equal(await onD, null);
});

// ---------------------------------------------------------------------------
// Payload discipline
// ---------------------------------------------------------------------------

test("no biometric material can ride the transport", { skip: SKIP }, async () => {
  // The event contract carries a confidence score and a result, never a
  // template. Asserting on the delivered payload rather than on the type, so
  // this fails if a future field is added upstream.
  const sessionId = "xinst-privacy";
  const received = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(sessionId, l));
  await ready(B);
  A.publish(recordEvent(sessionId));

  const event = await received;
  assert.ok(event);
  const serialized = JSON.stringify(event).toLowerCase();
  for (const term of ["embedding", "descriptor", "vector", "landmark", "image", "base64"]) {
    assert.equal(serialized.includes(term), false, `realtime payload carried "${term}"`);
  }
});

test("an oversized payload is dropped rather than throwing", { skip: SKIP }, async () => {
  // Postgres refuses a NOTIFY payload over 8000 bytes. Publishing is
  // fire-and-forget on the attendance write path, so the failure mode has to
  // be a dropped notification and a log line, never an exception that could
  // unwind a correction that already committed.
  const sessionId = "xinst-oversize";
  const huge = recordEvent(sessionId) as unknown as { record: { filler?: string } };
  huge.record.filler = "x".repeat(9_000);

  assert.doesNotThrow(() => A.publish(huge as unknown as AttendanceRealtimeEvent));
  await new Promise((r) => setTimeout(r, 300));

  // And the transport still works afterwards.
  const received = nextEvent<AttendanceRealtimeEvent>((l) => B.subscribe(sessionId, l));
  await ready(B);
  A.publish(recordEvent(sessionId));
  assert.ok(await received, "the transport did not survive an oversized publish");
});
