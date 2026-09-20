import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { BlockedAddressError } from "./outbound-guard";
import { safeRequest, UnsafeRequestError } from "./safe-fetch";
import { openSecret } from "@/lib/secret-box";
import { redact } from "./redaction";
import {
  ATTEMPT_HEADER,
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  signatureHeader,
} from "./webhook-signature";
import {
  isDeliveryFailed,
  newDelivery,
  nextDeliveryState,
  selectEndpoints,
  type AttemptOutcome,
} from "./webhook-delivery";
import type { WebhookDelivery, WebhookEvent, WebhookEventEnvelope } from "./types";

/**
 * Webhook delivery: the part that touches the network.
 *
 * ## The interface is what callers depend on
 *
 * `WebhookDispatcher` has one method. Everything in the application that
 * emits an event — attendance finalization, a student record changing — calls
 * `publish` and nothing else, so moving delivery to a real job queue (BullMQ,
 * pg-boss, SQS) later is a new class in this file and a one-line swap of the
 * exported singleton. No service that emits an event knows how delivery
 * works, or that it can fail.
 *
 * ## What the in-process implementation does and does not guarantee
 *
 * Stated plainly, because the difference matters to anyone depending on these
 * events:
 *
 * - **At-least-once, best effort.** A delivery that gets a retryable failure
 *   is retried on an in-process timer with exponential backoff and jitter.
 * - **Retries do not survive a restart.** The retry schedule lives in a
 *   `setTimeout`, not in a table — the schema is frozen and there is no
 *   queue. If the process restarts with retries in flight, those retries are
 *   lost. What is *not* lost is the record of them: every attempt writes an
 *   `AuditLog` row, so the Integration Center can show an administrator
 *   exactly which deliveries were left unfinished, and "Redeliver" replays
 *   them.
 * - **Single instance.** Same caveat as ADR-0004's realtime publisher: behind
 *   two app instances, the instance that handled the write is the one that
 *   delivers. That is correct (no duplicate delivery), but a restart of that
 *   instance specifically is what loses its retries.
 *
 * The honest summary for an integrator is in docs/INTEGRATIONS.md: treat
 * webhooks as a low-latency notification, and reconcile with `GET
 * /api/v1/attendance` for anything you must not miss. A webhook that is
 * merely *usually* delivered is a fine notification and a terrible system of
 * record, and nothing in this codebase pretends otherwise.
 */

export interface WebhookDispatcher {
  /**
   * Emits an event to every subscribed endpoint of the institution.
   *
   * Returns void and never rejects. This is not laziness — it is the
   * boundary. The call sites are inside attendance finalization and student
   * creation, and a webhook receiver being down must not fail a register a
   * teacher just confirmed. Failures are logged and audited, never thrown.
   */
  publish(envelope: WebhookEventEnvelope): void;
}

/** How long a single delivery attempt may take before it is abandoned. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Bound on the body we keep from a failed delivery, for the error message. */
const ERROR_BODY_LIMIT = 300;

export interface WebhookEndpointRow {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  isActive: boolean;
}

export interface WebhookDispatcherDeps {
  listEndpoints: (institutionId: string, event: WebhookEvent) => Promise<WebhookEndpointRow[]>;
  send: (url: string, body: string, headers: Record<string, string>) => Promise<AttemptOutcome>;
  recordAttempt: (
    institutionId: string,
    delivery: WebhookDelivery,
    endpointUrl: string,
  ) => Promise<void>;
  schedule: (fn: () => void, delayMs: number) => void;
  now: () => Date;
  random: () => number;
}

/**
 * One HTTP attempt.
 *
 * Note what is *not* sent: no `Authorization`, no API key, nothing that
 * authenticates us to the receiver beyond the signature. A webhook goes to a
 * URL an administrator typed, and a credential in that request would be a
 * credential handed to whoever controls that URL — including, after a typo,
 * someone else entirely.
 */
async function sendOverHttp(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<AttemptOutcome> {
  try {
    // `safeRequest`, not `fetch`. It resolves the hostname once, refuses
    // loopback and link-local answers, and pins the connection to the address
    // it validated — so there is no second lookup between the check and the
    // socket for a hostile resolver to answer differently. It also bounds the
    // time, bounds the response body, and sends only these headers: nothing
    // ambient can ride along with a signed payload full of student data.
    const response = await safeRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      maxResponseBytes: ERROR_BODY_LIMIT * 4,
    });

    if (response.status >= 200 && response.status < 300) {
      return { statusCode: response.status };
    }
    // The receiver's error body is frequently the only clue an integrator
    // gets. Truncated, and redacted, because it is written to an audit row
    // and we do not control what a stranger's 500 page contains. A 3xx lands
    // here too: `safeRequest` never follows one, so a redirect is reported as
    // the failure it is rather than quietly chased to another host.
    const snippet = response.body.slice(0, ERROR_BODY_LIMIT);
    return {
      statusCode: response.status,
      error: String(redact(`HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`)),
    };
  } catch (error) {
    // No status code: DNS failure, refused connection, TLS error, timeout.
    // `isRetryable(null)` is true, which is what we want for all of those.
    const message = error instanceof Error ? error.message : String(error);
    return {
      statusCode: null,
      error: String(redact(message)),
      // …except a refusal the transport itself made. A blocked address, a
      // bad protocol or credentials in the URL resolve the same way on every
      // attempt; retrying is a scheduled, repeating attempt to post signed
      // student data somewhere it must not go.
      permanent:
        error instanceof BlockedAddressError ||
        (error instanceof UnsafeRequestError &&
          error.reason !== "timeout" &&
          error.reason !== "network_error"),
    };
  }
}

async function listEndpointsFromDb(
  institutionId: string,
  event: WebhookEvent,
): Promise<WebhookEndpointRow[]> {
  const rows = await prisma.webhookEndpoint.findMany({ where: { institutionId, isActive: true } });
  return selectEndpoints(rows, event).map((row) => ({
    id: row.id,
    url: row.url,
    // Opened here, once, on the way to signing. A legacy plaintext value
    // passes through unchanged, which is what lets encryption roll out
    // without a flag-day migration of every existing endpoint.
    secret: openSecret(row.secret),
    eventTypes: row.eventTypes,
    isActive: row.isActive,
  }));
}

/**
 * The durable delivery record: one `AuditLog` row per attempt.
 *
 * `entityType: "WebhookDelivery"` with `entityId` the delivery id puts every
 * attempt for one delivery behind the existing `[entityType, entityId]`
 * index, so the Integration Center's "show me this delivery's history" is a
 * single indexed read rather than a scan.
 *
 * The endpoint's **secret is never in this row** — only its id and URL. The
 * payload is summarised, not embedded: an attendance envelope names students,
 * and a full copy of every event in the audit table would duplicate student
 * data into a place with a different retention policy than the records
 * themselves.
 */
async function recordAttemptInAudit(
  institutionId: string,
  delivery: WebhookDelivery,
  endpointUrl: string,
): Promise<void> {
  await recordAuditLog({
    action: isDeliveryFailed(delivery.status) ? "webhook.delivery.failed" : "webhook.delivery.succeeded",
    entityType: "WebhookDelivery",
    entityId: delivery.id,
    institutionId,
    afterJson: redact({
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      endpointId: delivery.endpointId,
      endpointUrl,
      status: delivery.status,
      attempt: delivery.attemptCount,
      statusCode: delivery.lastStatusCode ?? null,
      failureReason: delivery.lastError ?? null,
      nextAttemptAt: delivery.nextAttemptAt,
    }),
  });
}

export const productionDispatcherDeps: WebhookDispatcherDeps = {
  listEndpoints: listEndpointsFromDb,
  send: sendOverHttp,
  recordAttempt: recordAttemptInAudit,
  schedule: (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    // A pending retry must not hold a process open at shutdown. The delivery
    // is best-effort by design, and an `unref`ed timer that never fires is
    // exactly the "retries do not survive a restart" caveat documented above
    // — made explicit rather than accidental.
    timer.unref?.();
  },
  now: () => new Date(),
  random: Math.random,
};

export class InProcessWebhookDispatcher implements WebhookDispatcher {
  readonly #deps: WebhookDispatcherDeps;

  constructor(deps: WebhookDispatcherDeps = productionDispatcherDeps) {
    this.#deps = deps;
  }

  publish(envelope: WebhookEventEnvelope): void {
    // Detached on purpose: `publish` is called from inside attendance
    // finalization, and awaiting a stranger's HTTP endpoint there would make
    // "Confirm Attendance" as slow as the slowest integration an institution
    // ever configured.
    void this.#fanOut(envelope).catch((error: unknown) => {
      console.error(
        JSON.stringify({ log: "webhook.fanout_failed", eventId: envelope.id, error: redact(error) }),
      );
    });
  }

  /** Exposed for tests and for the "Redeliver" action, which awaits it. */
  async deliverNow(envelope: WebhookEventEnvelope): Promise<WebhookDelivery[]> {
    return this.#fanOut(envelope);
  }

  async #fanOut(envelope: WebhookEventEnvelope): Promise<WebhookDelivery[]> {
    const endpoints = await this.#deps.listEndpoints(envelope.institutionId, envelope.type);
    // Sequential rather than `Promise.all`: an institution has a handful of
    // endpoints, and a slow one delaying a fast one by a few seconds costs
    // nothing, while a parallel fan-out to a hundred endpoints would open a
    // hundred sockets from a request thread.
    const results: WebhookDelivery[] = [];
    for (const endpoint of endpoints) {
      results.push(await this.#deliver(envelope, endpoint));
    }
    return results;
  }

  async #deliver(
    envelope: WebhookEventEnvelope,
    endpoint: WebhookEndpointRow,
  ): Promise<WebhookDelivery> {
    const now = this.#deps.now();
    let delivery = newDelivery(envelope, endpoint.id, now);
    // Serialised exactly once, and this exact string is what gets signed. Any
    // re-serialisation between signing and sending would change key order or
    // whitespace and invalidate the signature at the receiver.
    const body = JSON.stringify(envelope);

    delivery = await this.#attempt(envelope, endpoint, delivery, body);
    this.#scheduleRetry(envelope, endpoint, delivery, body);
    return delivery;
  }

  async #attempt(
    envelope: WebhookEventEnvelope,
    endpoint: WebhookEndpointRow,
    delivery: WebhookDelivery,
    body: string,
  ): Promise<WebhookDelivery> {
    const now = this.#deps.now();
    const timestamp = Math.floor(now.getTime() / 1000);
    const outcome = await this.#deps.send(endpoint.url, body, {
      [SIGNATURE_HEADER]: signatureHeader(endpoint.secret, timestamp, body),
      [EVENT_ID_HEADER]: envelope.id,
      [EVENT_TYPE_HEADER]: envelope.type,
      [DELIVERY_ID_HEADER]: delivery.id,
      [ATTEMPT_HEADER]: String(delivery.attemptCount + 1),
      "User-Agent": "AttendancePlatform-Webhooks/1.0",
    });

    const next = nextDeliveryState(delivery, outcome, this.#deps.now(), this.#deps.random);
    await this.#deps
      .recordAttempt(envelope.institutionId, next, endpoint.url)
      .catch((error: unknown) => {
        // An audit write failing must not stop the retry chain; the delivery
        // is the product requirement, the row is the record of it.
        console.error(
          JSON.stringify({ log: "webhook.audit_failed", deliveryId: next.id, error: redact(error) }),
        );
      });
    return next;
  }

  #scheduleRetry(
    envelope: WebhookEventEnvelope,
    endpoint: WebhookEndpointRow,
    delivery: WebhookDelivery,
    body: string,
  ): void {
    // `nextDeliveryState` has already decided: PENDING with a `nextAttemptAt`
    // is the only state that means "try again". DELIVERED, FAILED and
    // EXHAUSTED are terminal and must not be rescheduled — an EXHAUSTED
    // delivery that got a retry here would loop forever.
    if (delivery.status !== "PENDING" || !delivery.nextAttemptAt) return;

    const delayMs = Math.max(0, new Date(delivery.nextAttemptAt).getTime() - this.#deps.now().getTime());
    this.#deps.schedule(() => {
      void this.#attempt(envelope, endpoint, delivery, body)
        .then((next) => this.#scheduleRetry(envelope, endpoint, next, body))
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({ log: "webhook.retry_failed", deliveryId: delivery.id, error: redact(error) }),
          );
        });
    }, delayMs);
  }
}

/**
 * The process-wide dispatcher.
 *
 * A singleton for the same reason the realtime publisher is one: it holds the
 * in-flight retry timers, and one constructed per request would deliver the
 * first attempt and then be garbage collected with its retries.
 */
export const webhookDispatcher: WebhookDispatcher = new InProcessWebhookDispatcher();

/**
 * The call sites' entry point.
 *
 * A free function rather than reaching for the singleton directly, so every
 * emitting service imports one small thing, and so the try/catch that
 * guarantees "a webhook problem never breaks the operation that emitted it"
 * exists in exactly one place instead of being re-typed at each call site and
 * eventually forgotten at one of them.
 */
export function emitWebhookEvent(
  envelope: WebhookEventEnvelope,
  dispatcher: WebhookDispatcher = webhookDispatcher,
): void {
  try {
    dispatcher.publish(envelope);
  } catch (error) {
    console.error(
      JSON.stringify({ log: "webhook.emit_failed", eventId: envelope.id, error: redact(error) }),
    );
  }
}
