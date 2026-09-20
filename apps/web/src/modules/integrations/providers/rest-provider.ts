import { redact } from "../redaction";
import { assertOutboundAddressAllowed } from "../outbound-guard";
import type { IntegrationConfig, IntegrationResource } from "../types";
import type {
  ConnectionTestResult,
  FetchOptions,
  FetchPage,
  IntegrationProvider,
  ProviderCapabilities,
} from "./provider";

/**
 * Pulls records from an external system's HTTP API.
 *
 * ## What it assumes, and what it deliberately does not
 *
 * It assumes: HTTP, a base URL, optional headers, and a response that is
 * either a JSON array or a JSON object with an array somewhere obvious in it.
 * That is close to the minimum that can be called "has an API", and it covers
 * the large majority of school ERP endpoints, which are almost always a
 * `GET /students` returning a list.
 *
 * It does **not** assume pagination style, field names, date formats, an
 * OpenAPI document, or that `since` is supported. Where it must guess — the
 * name of the array in a wrapped response, the name of a next-page token — it
 * tries a short list of conventional keys and then stops. Guessing more would
 * be encoding a particular vendor's API into the core, which is the one thing
 * this design exists to prevent; a system that needs more than this gets its
 * own provider file, which is a small thing to write.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

/** Response envelopes seen in the wild, in the order they are tried. */
const ARRAY_KEYS = ["data", "items", "results", "records", "rows", "content"] as const;

/** Continuation-token keys, same idea. */
const CURSOR_KEYS = ["nextCursor", "next_cursor", "nextPageToken", "next", "cursor"] as const;

const CAPABILITIES: ProviderCapabilities = {
  testConnection: true,
  pull: true,
  push: false,
  incremental: true,
  scheduled: true,
  resources: ["students", "classes", "sections", "programs", "subjects", "faculty", "enrollments", "attendance"],
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Rejects anything that is not an absolute http(s) URL.
 *
 * This is a server-side fetch driven by a string an administrator typed, which
 * makes it a server-side request forgery surface. `file://` would read the
 * container's filesystem and `http://169.254.169.254/` would read a cloud
 * instance's credentials. Blocking non-HTTP schemes closes the first;
 * blocking loopback and link-local hosts closes the second.
 *
 * A private-range host (10.x, 192.168.x) is *allowed*, and that is not an
 * oversight: an on-premises school ERP on the same LAN is exactly the case
 * this integration exists for, and refusing it would make the feature useless
 * for its primary user. The trust boundary being relied on is that only an
 * institution admin can configure a connection.
 */
export function validateBaseUrl(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return ["Base URL is required."];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ["Base URL must be a valid absolute URL, e.g. https://erp.example.edu/api."];
  }
  const problems: string[] = [];
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    problems.push("Base URL must use http:// or https://.");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    // AWS/GCP/Azure instance metadata. Never a legitimate ERP host, always
    // worth a credential to whoever can reach it.
    host === "169.254.169.254" ||
    host.startsWith("169.254.")
  ) {
    problems.push("Base URL must not point at this server or a link-local address.");
  }
  if (url.username || url.password) {
    problems.push("Put credentials in a header, not in the URL — a URL is logged, a header is not.");
  }
  return problems;
}

export class RestProvider implements IntegrationProvider {
  readonly kind = "rest" as const;
  readonly label = "REST API";
  readonly capabilities = CAPABILITIES;

  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  validateConfig(config: IntegrationConfig): string[] {
    const problems = validateBaseUrl(config.baseUrl);
    for (const name of Object.keys(config.headers ?? {})) {
      // A header name with CR/LF in it is header injection against the
      // external system, using our server as the vehicle.
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        problems.push(`\`${name}\` is not a valid HTTP header name.`);
      }
    }
    return problems;
  }

  async testConnection(config: IntegrationConfig): Promise<ConnectionTestResult> {
    const problems = this.validateConfig(config);
    if (problems.length > 0) return { ok: false, message: problems[0] };

    const url = joinUrl(config.baseUrl!, config.testPath ?? "/");
    const startedAt = Date.now();
    try {
      await assertOutboundAddressAllowed(url);
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...config.headers },
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "manual",
      });
      const latencyMs = Date.now() - startedAt;

      // A 401/403 is reported distinctly from a 500. "Reachable but rejected
      // the credential" and "unreachable" send an administrator to two
      // completely different places, and a single "connection failed" sends
      // them to the wrong one half the time.
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          statusCode: response.status,
          latencyMs,
          message: `Reached ${url} but the credential was rejected (HTTP ${response.status}). Check the headers on this connection.`,
        };
      }
      if (response.status >= 400) {
        return {
          ok: false,
          statusCode: response.status,
          latencyMs,
          message: `Reached ${url} but it returned HTTP ${response.status}. Check the test path.`,
        };
      }
      return { ok: true, statusCode: response.status, latencyMs, message: `Connected to ${url} in ${latencyMs}ms.` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: `Could not reach ${url}: ${String(redact(error instanceof Error ? error.message : error))}`,
      };
    }
  }

  async fetch(config: IntegrationConfig, options: FetchOptions): Promise<FetchPage> {
    const path = config.resourcePaths?.[options.resource] ?? `/${options.resource}`;
    const url = new URL(joinUrl(config.baseUrl!, path));
    url.searchParams.set("limit", String(options.limit));
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    // Two names for the same thing, because the systems that accept one
    // usually ignore the other, and sending both costs a query parameter.
    if (options.since) {
      url.searchParams.set("since", options.since.toISOString());
      url.searchParams.set("updated_after", options.since.toISOString());
    }

    const response = await this.#fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", ...config.headers },
      signal: options.signal ?? AbortSignal.timeout(this.#timeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`${options.resource}: external system returned HTTP ${response.status}`);
    }

    return parseFetchResponse(await response.json());
  }
}

/**
 * Normalises whatever came back into rows of strings.
 *
 * Every value is stringified, including numbers and booleans, and that is
 * intentional. A student code of `0012` arrives as the number 12 from a
 * system with a sloppy serialiser, and the moment it becomes a number the
 * leading zeros are gone and it no longer matches the code in our database.
 * Everything downstream — field mapping, validation, duplicate detection —
 * works on strings for this reason.
 *
 * Nested objects and arrays are dropped rather than JSON-stringified into a
 * cell. A mapping cannot target a nested field, so keeping it would put
 * `{"street":"…"}` into a student's name column on a mis-mapping.
 */
export function parseFetchResponse(payload: unknown): FetchPage {
  let list: unknown = payload;
  let nextCursor: string | null = null;

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ARRAY_KEYS) {
      if (Array.isArray(record[key])) {
        list = record[key];
        break;
      }
    }
    for (const key of CURSOR_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        nextCursor = value;
        break;
      }
    }
  }

  if (!Array.isArray(list)) {
    throw new Error(
      "External system did not return a list of records. Expected a JSON array, or an object with a `data`/`items`/`results` array.",
    );
  }

  const rows = list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)).map(
    (entry) => {
      const row: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "object") continue;
        row[key] = String(value);
      }
      return row;
    },
  );

  return { rows, nextCursor };
}

/** Resources this provider will carry. Narrowed per connection by config. */
export function restResources(): readonly IntegrationResource[] {
  return CAPABILITIES.resources;
}
