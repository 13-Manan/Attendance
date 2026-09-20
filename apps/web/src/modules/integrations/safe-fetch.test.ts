import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { LookupAddress } from "node:dns";
import { safeRequest, assertSafeUrlSyntax, UnsafeRequestError } from "./safe-fetch.ts";

/**
 * Phase 11 — the outbound request path, tested adversarially.
 *
 * The property being defended is not "bad URLs are rejected" — Phase 10
 * already did that with string matching. It is that the socket goes to an
 * address this code validated, even when DNS says something different the
 * second time it is asked. That cannot be tested by inspecting a URL, so the
 * resolver is injected and the tests are about what the connection *did*.
 *
 * A real local server backs the success cases, so "the request worked" means
 * bytes actually moved rather than a mock returning what it was told to.
 */

let server: Server;
let port = 0;
/** Set per-test to control what the local server does. */
let handler: (req: unknown, res: import("node:http").ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
};

before(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A resolver that answers with exactly what a test dictates. */
function answering(...addresses: LookupAddress[]) {
  return async () => addresses;
}

/**
 * A resolver that answers safely the first time and hostilely afterwards.
 *
 * This is DNS rebinding. If the implementation resolved once to validate and
 * then let the socket resolve again, the second answer is what it would dial.
 */
function rebinding(safe: LookupAddress, hostile: LookupAddress) {
  let calls = 0;
  const resolve = async () => (calls++ === 0 ? [safe] : [hostile]);
  return { resolve, calls: () => calls };
}

/**
 * The options a *transport* test needs: dial the local server, and permit the
 * loopback address it necessarily listens on.
 *
 * The security tests below never use this — they run the real policy and
 * assert a refusal. This override exists so timeouts, body limits and header
 * handling can be exercised against real bytes on a real socket.
 */
const TO_LOCAL_SERVER = {
  resolve: async () => [{ address: "127.0.0.1", family: 4 }] as LookupAddress[],
  isBlocked: () => false,
};

const LOOPBACK: LookupAddress = { address: "127.0.0.1", family: 4 };
const METADATA: LookupAddress = { address: "169.254.169.254", family: 4 };
const PRIVATE: LookupAddress = { address: "10.1.2.3", family: 4 };
const V6_LOOPBACK: LookupAddress = { address: "::1", family: 6 };
const V6_LINK_LOCAL: LookupAddress = { address: "fe80::1", family: 6 };

// ---------------------------------------------------------------------------
// URL syntax
// ---------------------------------------------------------------------------

test("non-http protocols are refused", () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://host/f"]) {
    assert.throws(
      () => assertSafeUrlSyntax(url),
      (e: unknown) => e instanceof UnsafeRequestError && e.reason === "bad_protocol",
      url,
    );
  }
});

test("credentials in the URL are refused", () => {
  assert.throws(
    () => assertSafeUrlSyntax("https://user:pass@erp.example.edu/hook"),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "credentials_in_url",
  );
});

test("a malformed URL is refused before any network work", () => {
  assert.throws(
    () => assertSafeUrlSyntax("not-a-url"),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "invalid_url",
  );
});

// ---------------------------------------------------------------------------
// Address validation
// ---------------------------------------------------------------------------

test("a hostname resolving to loopback is refused", async () => {
  await assert.rejects(
    () => safeRequest("http://erp.example.invalid/", { resolve: answering(LOOPBACK) }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "blocked_address",
  );
});

test("a hostname resolving to the metadata address is refused", async () => {
  await assert.rejects(
    () => safeRequest("http://erp.example.invalid/", { resolve: answering(METADATA) }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "blocked_address",
  );
});

test("IPv6 loopback and link-local are refused", async () => {
  for (const address of [V6_LOOPBACK, V6_LINK_LOCAL]) {
    await assert.rejects(
      () => safeRequest("http://erp.example.invalid/", { resolve: answering(address) }),
      (e: unknown) => e instanceof UnsafeRequestError && e.reason === "blocked_address",
      address.address,
    );
  }
});

test("one blocked answer among several refuses the whole request", async () => {
  // Which answer the stack would have dialled is not something this code
  // controls, so a name answering with both is a name it declines to call.
  await assert.rejects(
    () =>
      safeRequest("http://erp.example.invalid/", {
        resolve: answering({ address: "93.184.216.34", family: 4 }, METADATA),
      }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "blocked_address",
  );
});

test("a private address is allowed — on-prem ERPs are the point", async () => {
  // Not an oversight. Blocking RFC1918 would make the integration useless for
  // a school running its ERP on the same LAN, which is its primary user.
  // The request fails to *connect* (nothing is listening on 10.1.2.3 here),
  // and the distinction that matters is that it was not refused as unsafe.
  await assert.rejects(
    () =>
      safeRequest("http://erp.school.invalid/", {
        resolve: answering(PRIVATE),
        // The connect timeout this phase added. Before it, an unreachable
        // private address sat on the OS default for 75 seconds — measured.
        timeoutMs: 400,
      }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason !== "blocked_address",
  );
});

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

test("the request dials the validated address, not a later DNS answer", async () => {
  // The whole point of the phase, demonstrated positively.
  //
  // The resolver answers with the local server's address once, then with the
  // metadata address on every later call. A `fetch`-based implementation
  // validates the first answer and then lets the socket resolve again, landing
  // on the second. Here the first answer *is* what gets dialled — proven by
  // the local server's reply arriving — and the resolver is never asked twice.
  const dns = rebinding({ address: "127.0.0.1", family: 4 }, METADATA);
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("reached-the-validated-host");
  };

  const response = await safeRequest(`http://pinned.invalid:${port}/`, {
    resolve: dns.resolve,
    isBlocked: () => false,
  });

  assert.equal(response.body, "reached-the-validated-host");
  assert.equal(dns.calls(), 1, "resolved exactly once — there is no second lookup to poison");
});

test("a hostile second answer is never consulted, even under the real policy", async () => {
  // The same rebinding resolver, but with production's address policy: the
  // first answer is loopback and is refused outright. Either way the second
  // answer never reaches a socket.
  const dns = rebinding(LOOPBACK, METADATA);
  await assert.rejects(
    () => safeRequest(`http://pinned.invalid:${port}/`, { resolve: dns.resolve }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "blocked_address",
  );
  assert.equal(dns.calls(), 1);
});

test("the resolver is consulted exactly once per request", async () => {
  // No second lookup means no window in which a different answer could be
  // substituted — the structural reason rebinding cannot happen here.
  let calls = 0;
  handler = (_req, res) => {
    res.writeHead(200);
    res.end("ok");
  };
  const response = await safeRequest(`http://pinned.invalid:${port}/`, {
    ...TO_LOCAL_SERVER,
    resolve: async () => {
      calls++;
      return [{ address: "127.0.0.1", family: 4 }] as LookupAddress[];
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, "ok", "bytes actually moved over a real socket");
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// Transport limits
// ---------------------------------------------------------------------------

test("a redirect is returned, never followed", async () => {
  handler = (_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  };
  const response = await safeRequest(`http://redirect.invalid:${port}/`, TO_LOCAL_SERVER);
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.location,
    "http://169.254.169.254/latest/meta-data/",
    "the caller is told where it pointed; nothing here went there",
  );
});

test("an oversized response body is truncated rather than consumed", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("x".repeat(500_000));
  };
  const response = await safeRequest(`http://big.invalid:${port}/`, {
    ...TO_LOCAL_SERVER,
    maxResponseBytes: 1024,
  });
  assert.equal(response.truncated, true);
  assert.ok(response.body.length <= 1024, `body was ${response.body.length} bytes`);
});

test("a server that accepts the socket and says nothing times out", async () => {
  handler = () => {
    // Never responds. A connect-only timeout would miss this shape entirely.
  };
  await assert.rejects(
    () =>
      safeRequest(`http://silent.invalid:${port}/`, {
        ...TO_LOCAL_SERVER,
        timeoutMs: 300,
      }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "timeout",
  );
});

test("only the caller's headers are sent — nothing ambient rides along", async () => {
  let received: Record<string, unknown> = {};
  handler = (req, res) => {
    received = (req as { headers: Record<string, unknown> }).headers;
    res.writeHead(200);
    res.end("ok");
  };
  await safeRequest(`http://headers.invalid:${port}/`, {
    ...TO_LOCAL_SERVER,
    headers: { "X-Attendance-Signature": "sig", "Content-Type": "application/json" },
  });

  assert.equal(received["x-attendance-signature"], "sig");
  assert.equal(received.cookie, undefined, "no cookie jar");
  assert.equal(received.authorization, undefined, "no ambient credential");
  assert.equal(
    received.host,
    `headers.invalid:${port}`,
    "and the Host header names what the administrator configured, not the pinned IP",
  );
});

test("a request body is delivered", async () => {
  let body = "";
  handler = (req, res) => {
    const stream = req as unknown as NodeJS.ReadableStream;
    stream.on("data", (c: Buffer) => (body += c.toString()));
    stream.on("end", () => {
      res.writeHead(200);
      res.end("ok");
    });
  };
  const response = await safeRequest(`http://post.invalid:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "attendance.finalized" }),
    ...TO_LOCAL_SERVER,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(body), { event: "attendance.finalized" });
});

test("a resolution failure is reported as such, not as a block", async () => {
  await assert.rejects(
    () =>
      safeRequest("http://down.invalid/", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    (e: unknown) => e instanceof UnsafeRequestError && e.reason === "dns_failure",
  );
});
