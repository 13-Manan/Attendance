import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isBlockedAddress } from "./outbound-guard";

/**
 * The only way this application makes an outbound HTTP request.
 *
 * ## Why not `fetch`
 *
 * Because `fetch` gives no control over the address it dials. Phase 10's guard
 * resolved the hostname, checked the answer, and then called `fetch` — which
 * resolved it again. Between those two resolutions a hostile resolver can
 * answer differently, and the request lands on an address nobody validated.
 * That is DNS rebinding, and "resolve twice and hope" does not fix it.
 *
 * Node's own agents accept a `lookup` function, and whatever that function
 * returns is what the socket connects to. So the resolution and the validation
 * become the same act: resolve once, refuse the bad answers, and hand the
 * surviving address to the agent. There is no second resolution to be poisoned
 * because the real resolver is never consulted again.
 *
 * Verified rather than assumed — a request to a hostname that does not exist
 * in DNS reaches a local server through a pinned lookup, and arrives carrying
 * the original `Host` header.
 *
 * ## The trust model
 *
 * Private and on-premises addresses are **allowed**. A school's ERP on
 * `10.0.0.5` is the case these integrations exist for, and blocking RFC1918
 * would make the feature useless for its primary user. What is refused is
 * loopback, link-local (every cloud's instance-metadata service) and the
 * unspecified address — destinations that are never a legitimate ERP and
 * always worth a credential to whoever reaches them.
 *
 * The boundary being relied on is that only an institution administrator can
 * configure a connection or a webhook URL. This is a guard against a
 * *malicious destination*, not against a malicious administrator.
 *
 * ## What it enforces besides the address
 *
 * Bounded connect and total time, a bounded response body, no redirect
 * following, and only the headers the caller passed. Nothing about the
 * ambient process — no cookies, no environment, no internal tokens — can ride
 * along, because this function builds the request from its arguments alone.
 */

/** Long enough for a slow on-prem ERP, short enough to not pin a worker. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** A webhook receiver's error page is useful; its entire website is not. */
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

export class UnsafeRequestError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "UnsafeRequestError";
    this.reason = reason;
  }
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Injected in tests so the DNS answer can be chosen deterministically.
   * Production always uses the real resolver.
   */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  /**
   * The address policy, injected only so the transport can be exercised
   * against a local test server — which necessarily listens on loopback, the
   * one address the real policy exists to refuse.
   *
   * Production never passes this. The default is the real policy, and the
   * tests that matter for *security* are the ones that use the default and
   * assert a refusal; this override exists for the tests that are about
   * timeouts, body limits and headers instead.
   */
  isBlocked?: (address: string, family: number) => boolean;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Truncated at `maxResponseBytes`; `truncated` says whether that happened. */
  body: string;
  truncated: boolean;
}

/**
 * Rejects a URL on its syntax alone, before any network work.
 *
 * Kept separate from the address check because the two answer different
 * questions and fail at different times: this one can run in a form validator,
 * the other needs a resolver.
 */
export function assertSafeUrlSyntax(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeRequestError("invalid_url", "The URL is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // `file:` would read the container's filesystem; `gopher:` and friends are
    // request-smuggling primitives.
    throw new UnsafeRequestError("bad_protocol", "Only http:// and https:// are allowed.");
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs, in `Referer`, and in error
    // messages. A header is the place for them.
    throw new UnsafeRequestError(
      "credentials_in_url",
      "Put credentials in a header, not in the URL.",
    );
  }
  return url;
}

/**
 * Resolves a hostname to the addresses this server is willing to dial.
 *
 * Throws if *any* answer is blocked rather than filtering the bad ones out. A
 * name that answers with one routable address and one link-local address is a
 * name under someone else's control doing something deliberate, and picking
 * the "good" answer would be this code helping.
 */
async function resolveAllowedAddresses(
  hostname: string,
  resolver: (host: string) => Promise<LookupAddress[]>,
  isBlocked: (address: string, family: number) => boolean,
): Promise<LookupAddress[]> {
  const literal = hostname.replace(/^\[|\]$/g, "");

  let answers: LookupAddress[];
  try {
    answers = await resolver(literal);
  } catch {
    throw new UnsafeRequestError("dns_failure", `${hostname} could not be resolved.`);
  }
  if (answers.length === 0) {
    throw new UnsafeRequestError("dns_failure", `${hostname} resolved to no addresses.`);
  }

  for (const answer of answers) {
    if (isBlocked(answer.address, answer.family)) {
      throw new UnsafeRequestError(
        "blocked_address",
        `${hostname} resolves to ${answer.address}, which this server will not call.`,
      );
    }
  }
  return answers;
}

/**
 * A `lookup` that answers only with addresses already validated.
 *
 * This is the pin. Node calls it instead of the system resolver, so the socket
 * connects to exactly what was checked above — there is no window between
 * validation and connection for an answer to change.
 */
function pinnedLookup(addresses: LookupAddress[]): http.AgentOptions["lookup"] {
  return ((
    _hostname: string,
    options: unknown,
    callback?: (err: Error | null, address?: unknown, family?: number) => void,
  ) => {
    const done = typeof options === "function" ? options : callback;
    if (!done) return;
    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      done(null, addresses as unknown as string);
      return;
    }
    done(null, addresses[0].address, addresses[0].family);
  }) as http.AgentOptions["lookup"];
}

/**
 * Makes one outbound request, safely.
 *
 * Redirects are **not** followed. A 3xx is returned to the caller as a
 * response like any other. Following one would mean dialling an address the
 * administrator never approved — and an open redirect on an otherwise
 * legitimate receiver would become an SSRF primitive on this server. Callers
 * that genuinely need to follow a redirect must re-enter this function with
 * the new URL, which re-validates it from scratch.
 */
export async function safeRequest(
  rawUrl: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const url = assertSafeUrlSyntax(rawUrl);
  const resolver =
    options.resolve ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const addresses = await resolveAllowedAddresses(
    url.hostname,
    resolver,
    options.isBlocked ?? isBlockedAddress,
  );

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  // A fresh agent per request: these are one-shot calls to third-party hosts,
  // and a pooled socket keyed by hostname could otherwise be reused for a
  // later request whose validated address differs.
  const agent = isHttps
    ? new https.Agent({ lookup: pinnedLookup(addresses), keepAlive: false })
    : new http.Agent({ lookup: pinnedLookup(addresses), keepAlive: false });

  return new Promise<SafeResponse>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        // Only what the caller passed. Nothing ambient — no cookie jar, no
        // process environment, no internal service token — can attach itself
        // to a request built this way.
        headers: options.headers ?? {},
        agent,
        // Covers the connect phase, which `setTimeout` below does not: a
        // request to an unreachable private address otherwise sat for 75
        // seconds on the OS default before anything noticed. Measured.
        signal: AbortSignal.timeout(timeoutMs),
        // TLS is still verified against the hostname, not the pinned address:
        // `servername` keeps SNI and certificate validation pointed at the
        // name the administrator configured. Pinning changes where we dial,
        // never who we are willing to believe we reached.
        ...(isHttps ? { servername: url.hostname } : {}),
      },
      (response) => {
        let received = 0;
        let truncated = false;
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - received;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, Math.max(room, 0)));
            received = maxBytes;
            truncated = true;
            // Stop reading. A receiver that answers an error with a hundred
            // megabytes should not be able to spend this process's memory.
            response.destroy();
            return;
          }
          chunks.push(chunk);
          received += chunk.length;
        });

        const finish = () => {
          agent.destroy();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated,
          });
        };
        response.on("end", finish);
        // `destroy()` above ends with `close`, not `end`.
        response.on("close", finish);
        response.on("error", () => finish());
      },
    );

    // Covers connect *and* response: a receiver that accepts a socket and then
    // says nothing is the shape of failure a connect-only timeout misses.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new UnsafeRequestError("timeout", `No response within ${timeoutMs}ms.`));
    });

    request.on("error", (error) => {
      agent.destroy();
      if (error instanceof UnsafeRequestError) {
        reject(error);
        return;
      }
      // An aborted request is this function's own timeout firing, not the
      // receiver's fault — reported as a timeout so retry policy can tell the
      // difference between "slow" and "refused".
      const timedOut =
        (error as NodeJS.ErrnoException).name === "AbortError" ||
        (error as NodeJS.ErrnoException).name === "TimeoutError";
      reject(
        timedOut
          ? new UnsafeRequestError("timeout", `No response within ${timeoutMs}ms.`)
          : new UnsafeRequestError("network_error", error.message),
      );
    });

    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
