import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryAttendanceEventPublisher } from "./publisher.ts";
import type { AttendanceRealtimeEvent, StudentAttendanceUpdatedEvent } from "./types.ts";

/**
 * The two realtime channels, and the wall between them.
 *
 * `modules/realtime/types.ts` calls the session/student split "an
 * authorization boundary, not a performance one". That claim is only worth
 * anything if it is enforced, and the enforcement is one line in each
 * publish method — `session:<id>` versus `student:<id>`. A refactor that
 * accidentally collapsed the two namespaces would hand every student the
 * whole class's roster over SSE, and nothing else in the suite would notice:
 * the SSE route's own check ("are you this student?") passes fine, because
 * the caller genuinely is a student — just one now receiving everybody's
 * results.
 *
 * So these tests are about who does *not* receive an event.
 *
 * Phase 15 note: this exercises `InMemoryAttendanceEventPublisher` by name
 * rather than the exported singleton, which is now the Postgres transport by
 * default. The channel split is a property of both implementations and is
 * asserted for the shared one in `publisher-postgres.integration.test.ts`;
 * what is unit-testable without a database is this one, and these assertions
 * rely on its synchronous delivery.
 */

const publisher = new InMemoryAttendanceEventPublisher();

function studentEvent(
  studentId: string,
  overrides: Partial<StudentAttendanceUpdatedEvent> = {},
): StudentAttendanceUpdatedEvent {
  return {
    type: "student-attendance-updated",
    sessionId: "sess-1",
    studentId,
    finalResult: "PRESENT",
    isFinalized: true,
    occurredAt: "2026-09-20T09:00:00.000Z",
    ...overrides,
  };
}

test("a student receives their own result", () => {
  const seen: StudentAttendanceUpdatedEvent[] = [];
  const off = publisher.subscribeToStudent("stu-1", (e) => seen.push(e));

  publisher.publishToStudent("stu-1", studentEvent("stu-1"));
  off();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].finalResult, "PRESENT");
});

test("one student's result never reaches another student's channel", () => {
  const mine: StudentAttendanceUpdatedEvent[] = [];
  const theirs: StudentAttendanceUpdatedEvent[] = [];
  const offMine = publisher.subscribeToStudent("stu-1", (e) => mine.push(e));
  const offTheirs = publisher.subscribeToStudent("stu-2", (e) => theirs.push(e));

  publisher.publishToStudent("stu-1", studentEvent("stu-1"));
  offMine();
  offTheirs();

  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 0, "a classmate's absence is not this student's business");
});

test("a session event does not leak onto a student channel with the same id", () => {
  // The namespaces are prefixed for exactly this reason: a session id and a
  // student id are both opaque cuids and could collide as bare channel keys.
  const student: StudentAttendanceUpdatedEvent[] = [];
  const off = publisher.subscribeToStudent("shared-id", (e) => student.push(e));

  const sessionEvent: AttendanceRealtimeEvent = {
    type: "attendance-session-finalized",
    sessionId: "shared-id",
    counts: { total: 30, present: 28, absent: 2, needsReview: 0, notEvaluated: 0 },
    finalizedByUserId: "user-1",
    finalizedAt: "2026-09-20T09:00:00.000Z",
    occurredAt: "2026-09-20T09:00:00.000Z",
  };
  publisher.publish(sessionEvent);
  off();

  assert.equal(
    student.length,
    0,
    "whole-class counts must never arrive on a student's private channel",
  );
});

test("a student channel does not receive another session's whole-class event", () => {
  const board: AttendanceRealtimeEvent[] = [];
  const off = publisher.subscribe("sess-1", (e) => board.push(e));

  publisher.publishToStudent("stu-1", studentEvent("stu-1"));
  off();

  assert.equal(board.length, 0, "the student fan-out is not an extra write to the board");
});

test("unsubscribing stops delivery, so a closed portal tab receives nothing", () => {
  const seen: StudentAttendanceUpdatedEvent[] = [];
  const off = publisher.subscribeToStudent("stu-1", (e) => seen.push(e));
  off();

  publisher.publishToStudent("stu-1", studentEvent("stu-1"));

  assert.equal(seen.length, 0);
});

test("two tabs of the same student both receive the update", () => {
  // A student with the portal open on a phone and a laptop. Reconnects work
  // the same way: the SSE route subscribes afresh on each connection, so this
  // is also what a resumed stream looks like.
  const tabA: StudentAttendanceUpdatedEvent[] = [];
  const tabB: StudentAttendanceUpdatedEvent[] = [];
  const offA = publisher.subscribeToStudent("stu-1", (e) => tabA.push(e));
  const offB = publisher.subscribeToStudent("stu-1", (e) => tabB.push(e));

  publisher.publishToStudent("stu-1", studentEvent("stu-1"));
  offA();
  offB();

  assert.equal(tabA.length, 1);
  assert.equal(tabB.length, 1);
});

test("publishing to a channel nobody is listening on is not an error", () => {
  // The ordinary case: attendance is finalized at 09:05 and nobody has the
  // portal open. Finalization must not depend on an audience.
  assert.doesNotThrow(() => {
    publisher.publishToStudent("nobody-here", studentEvent("nobody-here"));
  });
});

test("a correction carries the revised result, not the original", () => {
  const seen: StudentAttendanceUpdatedEvent[] = [];
  const off = publisher.subscribeToStudent("stu-1", (e) => seen.push(e));

  publisher.publishToStudent(
    "stu-1",
    studentEvent("stu-1", { finalResult: "ABSENT", isFinalized: true }),
  );
  off();

  assert.equal(seen[0].finalResult, "ABSENT");
  assert.equal(
    seen[0].isFinalized,
    true,
    "a portal must not show a provisional result as a decided one",
  );
});
