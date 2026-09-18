import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_MAX_MS,
  EVENT_DESCRIPTIONS,
  MAX_DELIVERY_ATTEMPTS,
  buildEnvelope,
  deliveryBackoffMs,
  deliveryId,
  eventId,
  isDeliveryDue,
  isDeliveryFailed,
  isRetryable,
  isSuccess,
  isWebhookEvent,
  newDelivery,
  nextDeliveryState,
  selectEndpoints,
} from "./webhook-delivery.ts";
import { WEBHOOK_EVENTS, type WebhookDelivery } from "./types.ts";

const NOW = new Date("2026-09-16T10:00:00.000Z");

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: "whd_1",
    eventId: "evt_1",
    eventType: "attendance.finalized",
    endpointId: "ep-1",
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** Deterministic "random" so backoff is an assertion, not a guess. */
const noJitter = () => 1;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test("every event the brief names is supported and described", () => {
  for (const event of [
    "student.created",
    "student.updated",
    "student.deactivated",
    "attendance.created",
    "attendance.updated",
    "attendance.finalized",
    "attendance.corrected",
  ]) {
    assert.equal(isWebhookEvent(event), true, `${event} should be an event`);
  }
  for (const event of WEBHOOK_EVENTS) {
    assert.ok(EVENT_DESCRIPTIONS[event]?.length > 0);
  }
});

test("an invented event type is not an event", () => {
  for (const value of ["attendance.deleted", "student", "", null, 42]) {
    assert.equal(isWebhookEvent(value), false);
  }
});

// ---------------------------------------------------------------------------
// Endpoint selection
// ---------------------------------------------------------------------------

test("only active endpoints subscribed to the event are selected", () => {
  const endpoints = [
    { id: "a", isActive: true, eventTypes: ["attendance.finalized"] },
    { id: "b", isActive: true, eventTypes: ["student.created"] },
    { id: "c", isActive: false, eventTypes: ["attendance.finalized"] },
  ];
  assert.deepEqual(
    selectEndpoints(endpoints, "attendance.finalized").map((e) => e.id),
    ["a"],
  );
});

test("an endpoint with no event types receives nothing, not everything", () => {
  // The dangerous reading of "no filter" is "all events": that quietly ships
  // attendance data to a system that asked for student records.
  const endpoints = [{ id: "a", isActive: true, eventTypes: [] as string[] }];
  assert.deepEqual(selectEndpoints(endpoints, "attendance.finalized"), []);
});

// ---------------------------------------------------------------------------
// Idempotency ids
// ---------------------------------------------------------------------------

test("the same event produces the same id, so a replay after a restart is recognisable", () => {
  const a = eventId("inst-1", "attendance.finalized", "sess-1", "2026-09-16T10:00:00.000Z");
  const b = eventId("inst-1", "attendance.finalized", "sess-1", "2026-09-16T10:00:00.000Z");
  assert.equal(a, b);
  assert.match(a, /^evt_[A-Za-z0-9_-]{32}$/);
});

test("changing any component of the event changes the id", () => {
  const base = eventId("inst-1", "attendance.finalized", "sess-1", "2026-09-16T10:00:00.000Z");
  assert.notEqual(base, eventId("inst-2", "attendance.finalized", "sess-1", "2026-09-16T10:00:00.000Z"));
  assert.notEqual(base, eventId("inst-1", "attendance.updated", "sess-1", "2026-09-16T10:00:00.000Z"));
  assert.notEqual(base, eventId("inst-1", "attendance.finalized", "sess-2", "2026-09-16T10:00:00.000Z"));
  assert.notEqual(base, eventId("inst-1", "attendance.finalized", "sess-1", "2026-09-16T10:00:01.000Z"));
});

test("two corrections to the same record at different times are two events", () => {
  assert.notEqual(
    eventId("inst-1", "attendance.corrected", "rec-1", "2026-09-16T10:00:00.000Z"),
    eventId("inst-1", "attendance.corrected", "rec-1", "2026-09-16T11:30:00.000Z"),
  );
});

test("the id cannot be confused across field boundaries", () => {
  // A naive concatenation would make ("a", "b|c") and ("a|b", "c") collide.
  assert.notEqual(
    eventId("inst", "student.created", "a\nb", "2026-09-16T10:00:00.000Z"),
    eventId("inst\nstudent.created", "student.created", "b", "2026-09-16T10:00:00.000Z"),
  );
});

test("one event fanning out to two endpoints yields two distinct delivery ids", () => {
  assert.notEqual(deliveryId("evt_1", "ep-1"), deliveryId("evt_1", "ep-2"));
  assert.equal(deliveryId("evt_1", "ep-1"), deliveryId("evt_1", "ep-1"));
  assert.match(deliveryId("evt_1", "ep-1"), /^whd_[A-Za-z0-9_-]{32}$/);
});

test("the envelope carries the version and the derived id", () => {
  const envelope = buildEnvelope("inst-1", "student.created", "stu-1", "2026-09-16T10:00:00.000Z", {
    id: "stu-1",
  });
  assert.equal(envelope.apiVersion, "v1");
  assert.equal(envelope.type, "student.created");
  assert.equal(envelope.institutionId, "inst-1");
  assert.equal(envelope.id, eventId("inst-1", "student.created", "stu-1", "2026-09-16T10:00:00.000Z"));
  assert.deepEqual(envelope.data, { id: "stu-1" });
});

// ---------------------------------------------------------------------------
// Retryability
// ---------------------------------------------------------------------------

test("server errors and network failures retry", () => {
  for (const status of [500, 502, 503, 504, null]) {
    assert.equal(isRetryable(status), true, `${status} should retry`);
  }
});

test("permanent client errors do not retry", () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    assert.equal(isRetryable(status), false, `${status} should not retry`);
  }
});

test("408 and 429 retry — a receiver asking us to slow down is not a broken endpoint", () => {
  assert.equal(isRetryable(408), true);
  assert.equal(isRetryable(429), true);
});

test("only 2xx is success", () => {
  assert.equal(isSuccess(200), true);
  assert.equal(isSuccess(204), true);
  assert.equal(isSuccess(299), true);
  assert.equal(isSuccess(301), false);
  assert.equal(isSuccess(199), false);
  assert.equal(isSuccess(null), false);
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test("the backoff window grows exponentially and then stops at the ceiling", () => {
  const windows = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => deliveryBackoffMs(attempt, noJitter));
  assert.deepEqual(windows.slice(0, 4), [1_000, 2_000, 4_000, 8_000]);
  for (const window of windows) assert.ok(window <= DELIVERY_MAX_MS);
  assert.equal(deliveryBackoffMs(30, noJitter), DELIVERY_MAX_MS, "the ceiling holds");
});

test("an absurd attempt number does not produce Infinity or NaN", () => {
  for (const attempt of [0, -5, 1e9, Number.MAX_SAFE_INTEGER]) {
    const value = deliveryBackoffMs(attempt, noJitter);
    assert.equal(Number.isFinite(value), true, `attempt ${attempt}`);
    assert.ok(value >= 0);
  }
});

test("jitter spreads simultaneous retries instead of synchronising them", () => {
  const values = new Set(Array.from({ length: 200 }, () => deliveryBackoffMs(5)));
  assert.ok(values.size > 100, "a synchronised wave would collapse to one value");
  for (const value of values) assert.ok(value >= 0 && value <= 16_000);
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

test("a 200 delivers and stops, clearing the previous error", () => {
  const next = nextDeliveryState(delivery({ attemptCount: 2, lastError: "timeout" }), { statusCode: 200 }, NOW);
  assert.equal(next.status, "DELIVERED");
  assert.equal(next.nextAttemptAt, null);
  assert.equal(next.attemptCount, 3);
  assert.equal(next.lastError, undefined);
});

test("a 404 fails permanently on the first attempt rather than retrying eight times", () => {
  const next = nextDeliveryState(delivery(), { statusCode: 404, error: "Not Found" }, NOW);
  assert.equal(next.status, "FAILED");
  assert.equal(next.nextAttemptAt, null);
  assert.equal(next.lastStatusCode, 404);
});

test("a 500 schedules a retry in the future", () => {
  const next = nextDeliveryState(delivery(), { statusCode: 500 }, NOW, noJitter);
  assert.equal(next.status, "PENDING");
  assert.equal(next.nextAttemptAt, new Date(NOW.getTime() + 1_000).toISOString());
});

test("a network error with no status retries", () => {
  const next = nextDeliveryState(delivery(), { statusCode: null, error: "ECONNREFUSED" }, NOW, noJitter);
  assert.equal(next.status, "PENDING");
  assert.equal(next.lastStatusCode, undefined);
  assert.equal(next.lastError, "ECONNREFUSED");
});

test("the last transient failure exhausts rather than failing", () => {
  // EXHAUSTED and FAILED get different advice in the Integration Center:
  // redeliver once your system is up, versus fix your configuration.
  const next = nextDeliveryState(
    delivery({ attemptCount: MAX_DELIVERY_ATTEMPTS - 1 }),
    { statusCode: 503 },
    NOW,
  );
  assert.equal(next.status, "EXHAUSTED");
  assert.equal(next.nextAttemptAt, null);
  assert.equal(next.attemptCount, MAX_DELIVERY_ATTEMPTS);
});

test("a permanent error on the final attempt is FAILED, not EXHAUSTED", () => {
  const next = nextDeliveryState(delivery({ attemptCount: MAX_DELIVERY_ATTEMPTS - 1 }), { statusCode: 403 }, NOW);
  assert.equal(next.status, "FAILED");
});

test("a full run of outages terminates in exactly the allowed number of attempts", () => {
  let current = delivery();
  let attempts = 0;
  while (current.status === "PENDING" && attempts < 100) {
    current = nextDeliveryState(current, { statusCode: 503 }, NOW, noJitter);
    attempts += 1;
  }
  assert.equal(attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(current.status, "EXHAUSTED");
});

test("the state machine never mutates the delivery it was given", () => {
  const original = delivery();
  const snapshot = structuredClone(original);
  nextDeliveryState(original, { statusCode: 500 }, NOW);
  assert.deepEqual(original, snapshot);
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test("a new delivery starts pending and immediately due", () => {
  const envelope = buildEnvelope("inst-1", "student.created", "stu-1", NOW.toISOString(), {});
  const created = newDelivery(envelope, "ep-1", NOW);
  assert.equal(created.status, "PENDING");
  assert.equal(created.attemptCount, 0);
  assert.equal(created.id, deliveryId(envelope.id, "ep-1"));
  assert.equal(isDeliveryDue(created, NOW), true);
});

test("a delivery scheduled in the future is not due yet", () => {
  const scheduled = delivery({ nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString() });
  assert.equal(isDeliveryDue(scheduled, NOW), false);
  assert.equal(isDeliveryDue(scheduled, new Date(NOW.getTime() + 60_000)), true);
});

test("terminal deliveries are never due — an EXHAUSTED retry would loop forever", () => {
  for (const status of ["DELIVERED", "FAILED", "EXHAUSTED", "DELIVERING"] as const) {
    assert.equal(isDeliveryDue(delivery({ status, nextAttemptAt: null }), NOW), false, status);
  }
});

test("a pending delivery past the attempt ceiling is not due", () => {
  assert.equal(isDeliveryDue(delivery({ attemptCount: MAX_DELIVERY_ATTEMPTS }), NOW), false);
});

test("the statuses needing an administrator are exactly FAILED and EXHAUSTED", () => {
  assert.equal(isDeliveryFailed("FAILED"), true);
  assert.equal(isDeliveryFailed("EXHAUSTED"), true);
  assert.equal(isDeliveryFailed("DELIVERED"), false);
  assert.equal(isDeliveryFailed("PENDING"), false);
  assert.equal(isDeliveryFailed("DELIVERING"), false);
});
