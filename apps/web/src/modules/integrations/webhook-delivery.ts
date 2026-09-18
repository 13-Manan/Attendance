import { createHash } from "node:crypto";
import {
  WEBHOOK_EVENTS,
  type DeliveryStatus,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookEventEnvelope,
} from "./types";

/**
 * Webhook delivery policy: what gets retried, when, and what "delivered"
 * means.
 *
 * Pure module — no `fetch`, no Prisma, no timers. Every decision here is a
 * function of (attempt, status code, clock), which is what makes the retry
 * behaviour testable without waiting eleven hours for a backoff to elapse.
 * The I/O lives in webhook-dispatcher.ts.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && EVENT_SET.has(value);
}

export const EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  "student.created": "A student record was created.",
  "student.updated": "A student's details changed.",
  "student.deactivated": "A student was set to a non-ACTIVE status.",
  "attendance.created": "A register was generated for a session.",
  "attendance.updated": "A record in an open register changed.",
  "attendance.finalized": "A faculty member confirmed a register. Results are now authoritative.",
  "attendance.corrected": "A finalized record was corrected.",
};

/**
 * Selects endpoints for an event.
 *
 * An endpoint with an empty `eventTypes` receives **nothing**, not everything.
 * The tempting reading of "no filter" is "all events", and it is the wrong
 * one here: a row that ends up with an empty array is far more likely to be a
 * configuration mistake than a deliberate firehose request, and the failure
 * modes are not symmetric. Sending nothing is noticed by the integrator and
 * fixed; sending everything quietly ships attendance data to a system that
 * asked for student records.
 */
export function selectEndpoints<T extends { isActive: boolean; eventTypes: string[] }>(
  endpoints: readonly T[],
  event: WebhookEvent,
): T[] {
  return endpoints.filter((endpoint) => endpoint.isActive && endpoint.eventTypes.includes(event));
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * A stable event id derived from what the event *is*, not from when we
 * noticed it.
 *
 * This is the property that makes the receiver's job possible. If the app
 * restarts mid-dispatch and the same finalization is published again, a
 * random id would produce a second event the receiver cannot recognise as a
 * duplicate — and "attendance finalized" processed twice is a duplicate
 * notification to every parent in a class. Hashing (institution, type,
 * subject, occurredAt) means the retry carries the id the first attempt did.
 *
 * `occurredAt` is part of the hash on purpose: two genuinely distinct
 * corrections to the same record must be two events. It is the *event's* time
 * — the correction's timestamp, taken from the database row — never
 * `Date.now()` at dispatch, which would change on every replay and defeat the
 * whole mechanism.
 */
export function eventId(
  institutionId: string,
  type: WebhookEvent,
  subjectId: string,
  occurredAt: string,
): string {
  const digest = createHash("sha256")
    .update([institutionId, type, subjectId, occurredAt].join("\n"))
    .digest("base64url");
  return `evt_${digest.slice(0, 32)}`;
}

/**
 * A stable delivery id: one per (event, endpoint).
 *
 * Distinct from the event id because one event fans out to several endpoints
 * and each has its own retry state. Derived rather than random for the same
 * reason — a restart must resume the same delivery, not start a new one
 * beside it.
 */
export function deliveryId(eventIdValue: string, endpointId: string): string {
  const digest = createHash("sha256").update(`${eventIdValue}\n${endpointId}`).digest("base64url");
  return `whd_${digest.slice(0, 32)}`;
}

export function buildEnvelope<T>(
  institutionId: string,
  type: WebhookEvent,
  subjectId: string,
  occurredAt: string,
  data: T,
): WebhookEventEnvelope<T> {
  return {
    id: eventId(institutionId, type, subjectId, occurredAt),
    type,
    occurredAt,
    institutionId,
    apiVersion: "v1",
    data,
  };
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Eight attempts spanning roughly eleven hours.
 *
 * Sized against the outage this actually has to survive: a school's on-prem
 * ERP going down at 4pm and being restarted by someone the next morning. Five
 * attempts over fifteen minutes would give up during lunch; unlimited retries
 * would hammer a permanently-dead endpoint forever.
 */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** First retry after ~1s. */
export const DELIVERY_BASE_MS = 1_000;

/** Ceiling per attempt: 4 hours. Attempts 6, 7 and 8 all land here. */
export const DELIVERY_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters more than it looks. An institution typically registers one
 * endpoint per system, but a single finalization fans out to several
 * endpoints at once and a single outage fails all of them simultaneously —
 * without jitter every one of them retries in the same millisecond, forever,
 * and the recovering server is hit by a synchronised wave each time it comes
 * back up. `random` is injected so the spread is a testable property rather
 * than an article of faith.
 */
export function deliveryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  // Cap the exponent before `2 ** n` reaches Infinity; the Math.min below
  // would otherwise be comparing against a non-finite number.
  const exponent = Math.min(safeAttempt - 1, 32);
  const window = Math.min(DELIVERY_BASE_MS * 2 ** exponent, DELIVERY_MAX_MS);
  return Math.floor(random() * window);
}

/**
 * Whether a response means "try again later" or "stop".
 *
 * The distinction is the entire value of a retry policy. A 404 or a 401 will
 * be a 404 or a 401 in four hours too — retrying it eight times is pure noise
 * in the receiver's logs and ours. A 500 or a timeout is exactly what retries
 * are for.
 *
 * Two deliberate exceptions to "4xx is permanent":
 * - **408 Request Timeout** and **429 Too Many Requests** are explicitly
 *   temporary; 429 in particular is the receiver asking us to slow down, and
 *   treating it as permanent would disable an endpoint for being careful.
 * - A **network error** (no status at all) always retries. A DNS failure or a
 *   refused connection during a deploy is the textbook transient fault.
 */
export function isRetryable(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  if (statusCode === 408 || statusCode === 429) return true;
  return statusCode >= 500;
}

/** 2xx is success. Anything else is a failure, retryable or not. */
export function isSuccess(statusCode: number | null): boolean {
  return statusCode !== null && statusCode >= 200 && statusCode < 300;
}

export interface AttemptOutcome {
  statusCode: number | null;
  /** Already redacted. */
  error?: string;
}

/**
 * The state machine, as a pure function of (current delivery, outcome, now).
 *
 * Returns the *next* delivery record. Separated from the dispatcher so the
 * interesting questions — does a 500 on attempt 8 become FAILED or EXHAUSTED,
 * does a 404 stop immediately — are answered by a unit test rather than by
 * reading a `fetch` call's surroundings.
 *
 * `FAILED` and `EXHAUSTED` are distinct on purpose. `FAILED` means we stopped
 * because the endpoint told us something permanent, and the fix is the
 * integrator's configuration. `EXHAUSTED` means it kept timing out and we ran
 * out of attempts, and the fix is to redeliver once their system is up. The
 * Integration Center shows different advice for each, and collapsing them
 * into one status would mean showing the wrong advice half the time.
 */
export function nextDeliveryState(
  delivery: WebhookDelivery,
  outcome: AttemptOutcome,
  now: Date,
  random: () => number = Math.random,
): WebhookDelivery {
  const attemptCount = delivery.attemptCount + 1;
  const base: WebhookDelivery = {
    ...delivery,
    attemptCount,
    updatedAt: now.toISOString(),
    lastStatusCode: outcome.statusCode ?? undefined,
    lastError: outcome.error,
  };

  if (isSuccess(outcome.statusCode)) {
    return { ...base, status: "DELIVERED", nextAttemptAt: null, lastError: undefined };
  }
  if (!isRetryable(outcome.statusCode)) {
    return { ...base, status: "FAILED", nextAttemptAt: null };
  }
  if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    return { ...base, status: "EXHAUSTED", nextAttemptAt: null };
  }
  return {
    ...base,
    status: "PENDING",
    nextAttemptAt: new Date(now.getTime() + deliveryBackoffMs(attemptCount, random)).toISOString(),
  };
}

export function newDelivery(
  envelope: WebhookEventEnvelope,
  endpointId: string,
  now: Date,
): WebhookDelivery {
  return {
    id: deliveryId(envelope.id, endpointId),
    eventId: envelope.id,
    eventType: envelope.type,
    endpointId,
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function isDeliveryDue(delivery: WebhookDelivery, now: Date): boolean {
  if (delivery.status !== "PENDING") return false;
  if (delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS) return false;
  if (!delivery.nextAttemptAt) return true;
  return new Date(delivery.nextAttemptAt).getTime() <= now.getTime();
}

/** Statuses that need an administrator to look at them. */
export function isDeliveryFailed(status: DeliveryStatus): boolean {
  return status === "FAILED" || status === "EXHAUSTED";
}
