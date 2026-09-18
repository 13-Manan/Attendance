import type { IntegrationConfig } from "../types";
import { validateBaseUrl } from "./rest-provider";
import type {
  ConnectionTestResult,
  FetchOptions,
  FetchPage,
  IntegrationProvider,
  ProviderCapabilities,
} from "./provider";

/**
 * Event-driven integration: we push, the external system listens.
 *
 * ## The inverse of the REST provider
 *
 * A REST connection answers "how do I read *their* data". A webhook
 * connection answers "how do they hear about *ours*". Both are integrations
 * in the Integration Center — they have a status, an error history and a last
 * activity time — but only one of them ever syncs, which is why
 * `pull: false` and `incremental: false` here are accurate rather than
 * limitations.
 *
 * ## Why this is a thin provider
 *
 * Nearly all of the behaviour lives in webhook-delivery.ts (retry policy,
 * idempotency, delivery state) and webhook-dispatcher.ts (the HTTP and the
 * audit trail), and it lives there because those are used by the
 * `WebhookEndpoint` rows an integrator registers through
 * `POST /api/v1/webhooks` — a path that has nothing to do with the
 * Integration Center. This class exists so that an administrator who
 * configures event delivery through the admin UI gets the same object model
 * as every other integration: one list, one status column, one place to look.
 */

const CAPABILITIES: ProviderCapabilities = {
  testConnection: true,
  pull: false,
  push: true,
  incremental: false,
  scheduled: false,
  resources: ["students", "attendance"],
};

export class WebhookProvider implements IntegrationProvider {
  readonly kind = "webhook" as const;
  readonly label = "Outbound webhooks";
  readonly capabilities = CAPABILITIES;

  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetch = fetchImpl;
  }

  validateConfig(config: IntegrationConfig): string[] {
    const problems = validateBaseUrl(config.deliveryUrl);
    // Same SSRF and credential rules as the REST provider — deliberately
    // reusing that function rather than writing a second, subtly different
    // validator that drifts from it.
    return problems.map((problem) => problem.replace("Base URL", "Delivery URL"));
  }

  /**
   * A ping, not a real event.
   *
   * Deliberately unsigned and carrying no data: it is sent before the
   * administrator has necessarily finished configuring the endpoint, possibly
   * to a URL with a typo in it, and a signed payload of real student data is
   * not the thing to send somewhere you are not yet sure about. All it
   * establishes is that something is listening and will accept a POST — which
   * is the question the button asks.
   */
  async testConnection(config: IntegrationConfig): Promise<ConnectionTestResult> {
    const problems = this.validateConfig(config);
    if (problems.length > 0) return { ok: false, message: problems[0] };

    const startedAt = Date.now();
    try {
      const response = await this.#fetch(config.deliveryUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Attendance-Event-Type": "ping" },
        body: JSON.stringify({ type: "ping", apiVersion: "v1" }),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      const latencyMs = Date.now() - startedAt;
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        statusCode: response.status,
        latencyMs,
        message: ok
          ? `Endpoint accepted a test POST in ${latencyMs}ms.`
          : `Endpoint returned HTTP ${response.status}. It must answer 2xx to a POST for deliveries to be considered successful.`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: `Could not reach the endpoint: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async fetch(_config: IntegrationConfig, options: FetchOptions): Promise<FetchPage> {
    throw new Error(
      `A webhook integration delivers events; it cannot pull ${options.resource}. Use a REST connection to read from an external system.`,
    );
  }
}
