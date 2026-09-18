import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  handleApiRequest,
  invalidRequest,
  notFound,
  notImplementedRoute,
  okResponse,
  resolveRequestId,
  type ApiAccessLogEntry,
  type ApiRouteDeps,
  type ApiRouteOptions,
} from "./api-route.ts";
import { MemoryRateLimiter } from "./rate-limit.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import type { ApiKeyContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const KEY: ApiKeyContext = {
  apiKeyId: "key-1",
  institutionId: "inst-1",
  scopes: ["students:read", "students:write"],
  name: "School ERP",
  authMethod: "api_key",
};

function harness(overrides: Partial<ApiRouteDeps> = {}) {
  const logs: ApiAccessLogEntry[] = [];
  const audits: RecordAuditLogInput[] = [];
  let clock = 0;

  const deps: ApiRouteDeps = {
    authenticate: async () => KEY,
    limiter: new MemoryRateLimiter(() => 1_000_000),
    resolveRule: async () => ({ burst: 3, refillPerMinute: 60 }),
    recordAudit: async (input) => {
      audits.push(input);
    },
    log: (entry) => {
      logs.push(entry);
    },
    now: () => new Date("2026-09-16T10:00:00.000Z"),
    monotonic: () => (clock += 5),
    newRequestId: () => "generated-request-id",
    ...overrides,
  };

  return { deps, logs, audits };
}

const OPTIONS: ApiRouteOptions = { scopes: ["students:read"], resource: "Student" };

function get(url = "https://x.test/api/v1/students", init: RequestInit = {}) {
  return new Request(url, { headers: { authorization: "Bearer att_live_abcdef0123456789" }, ...init });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const OK = async () => okResponse({ data: [], requestId: "x" }, "x");

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("an authenticated, scoped, unthrottled request reaches the handler", async () => {
  const { deps, logs } = harness();
  let seenInstitution: string | null = null;

  const response = await handleApiRequest(
    get(),
    OPTIONS,
    async (ctx) => {
      seenInstitution = ctx.institutionId;
      return okResponse({ data: [{ id: "s1" }] }, ctx.requestId);
    },
    deps,
  );

  assert.equal(response.status, 200);
  assert.equal(seenInstitution, "inst-1");
  assert.equal(logs[0].outcome, "ok");
});

test("the wrapper owns the cross-cutting headers a handler could forget", async () => {
  const { deps } = harness();
  const response = await handleApiRequest(get(), OPTIONS, OK, deps);

  assert.equal(response.headers.get("X-Request-Id"), "generated-request-id");
  assert.equal(response.headers.get("Cache-Control"), "no-store, private");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("RateLimit-Limit"), "3");
});

test("dynamic route params are awaited before the handler sees them", async () => {
  const { deps } = harness();
  let seen: Record<string, string> = {};

  await handleApiRequest(
    get("https://x.test/api/v1/students/s1"),
    OPTIONS,
    async (ctx) => {
      seen = ctx.params;
      return okResponse({}, ctx.requestId);
    },
    deps,
    { params: Promise.resolve({ id: "s1" }) },
  );

  assert.deepEqual(seen, { id: "s1" });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test("a request with no valid key is refused before the handler runs", async () => {
  const { deps, logs } = harness({ authenticate: async () => null });
  let handlerRan = false;

  const response = await handleApiRequest(
    get(),
    OPTIONS,
    async () => {
      handlerRan = true;
      return okResponse({}, "x");
    },
    deps,
  );

  assert.equal(response.status, 401);
  assert.equal(handlerRan, false);
  assert.equal((await body(response)).error, "unauthorized");
  assert.match(response.headers.get("WWW-Authenticate") ?? "", /^Bearer/);
  assert.equal(logs[0].outcome, "denied");
});

test("a rejected credential is logged by fingerprint only", async () => {
  const { deps, logs } = harness({ authenticate: async () => null });
  await handleApiRequest(get(), OPTIONS, OK, deps);

  const serialised = JSON.stringify(logs[0]);
  assert.match(logs[0].failureReason ?? "", /^invalid_credential:…6789$/);
  assert.equal(serialised.includes("att_live_abcdef"), false, "the key must never reach a log line");
});

test("an authentication backend failure is a 500, not an open door", async () => {
  const { deps, logs } = harness({
    authenticate: async () => {
      throw new Error("connection refused: postgres://user:pw@db:5432");
    },
  });
  let handlerRan = false;

  const response = await handleApiRequest(
    get(),
    OPTIONS,
    async () => {
      handlerRan = true;
      return okResponse({}, "x");
    },
    deps,
  );

  assert.equal(response.status, 500);
  assert.equal(handlerRan, false);
  assert.equal(logs[0].outcome, "error");
  assert.equal(
    JSON.stringify(await body(response)).includes("postgres://"),
    false,
    "an internal connection string must not reach the client",
  );
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("a key missing the required scope gets 403 and is told exactly what is missing", async () => {
  const { deps } = harness();
  const response = await handleApiRequest(
    get(),
    { scopes: ["attendance:write"], resource: "AttendanceRecord" },
    OK,
    deps,
  );

  const payload = await body(response);
  assert.equal(response.status, 403);
  assert.equal(payload.error, "insufficient_scope");
  assert.match(String(payload.message), /attendance:write/);
  assert.deepEqual(payload.requiredScopes, ["attendance:write"]);
});

test("an endpoint requiring two scopes refuses a key holding only one", async () => {
  const { deps } = harness();
  const response = await handleApiRequest(
    get(),
    { scopes: ["students:read", "attendance:read"], resource: "Student" },
    OK,
    deps,
  );
  assert.equal(response.status, 403);
});

test("the scope check runs before the rate limiter, so a wrong scope is a stable 403", async () => {
  const { deps } = harness();
  const options: ApiRouteOptions = { scopes: ["reports:read"], resource: "Report" };
  const statuses: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push((await handleApiRequest(get(), options, OK, deps)).status);
  }
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 403], "never an intermittent 429");
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test("the burst is enforced and the handler stops being called", async () => {
  const { deps } = harness();
  let handlerCalls = 0;
  const handler = async () => {
    handlerCalls += 1;
    return okResponse({}, "x");
  };

  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    statuses.push((await handleApiRequest(get(), OPTIONS, handler, deps)).status);
  }

  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal(handlerCalls, 3, "the limit protects the database, it does not merely report");
});

test("a 429 carries Retry-After and the standard rate-limit headers", async () => {
  const { deps } = harness();
  for (let i = 0; i < 3; i += 1) await handleApiRequest(get(), OPTIONS, OK, deps);

  const response = await handleApiRequest(get(), OPTIONS, OK, deps);
  assert.equal(response.status, 429);
  assert.equal((await body(response)).error, "rate_limited");
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
  assert.equal(response.headers.get("RateLimit-Remaining"), "0");
});

test("exhausting the write allowance leaves reads working", async () => {
  const { deps } = harness();
  const write = () =>
    handleApiRequest(
      get("https://x.test/api/v1/students", { method: "POST" }),
      { scopes: ["students:write"], resource: "Student" },
      OK,
      deps,
    );

  for (let i = 0; i < 3; i += 1) await write();
  assert.equal((await write()).status, 429);
  assert.equal((await handleApiRequest(get(), OPTIONS, OK, deps)).status, 200);
});

// ---------------------------------------------------------------------------
// Errors from the handler
// ---------------------------------------------------------------------------

test("a thrown ApiError becomes its declared status and message", async () => {
  const { deps } = harness();
  const response = await handleApiRequest(
    get(),
    OPTIONS,
    async () => {
      throw notFound("Student");
    },
    deps,
  );

  assert.equal(response.status, 404);
  const payload = await body(response);
  assert.equal(payload.error, "not_found");
  assert.equal(payload.message, "Student not found.");
});

test("invalidRequest carries structured details for the integrator to act on", async () => {
  const { deps } = harness();
  const response = await handleApiRequest(
    get(),
    OPTIONS,
    async () => {
      throw invalidRequest("`limit` must be a positive integer.", { field: "limit" });
    },
    deps,
  );

  assert.equal(response.status, 400);
  assert.deepEqual((await body(response)).details, { field: "limit" });
});

test("an unexpected throw is a 500 that leaks nothing but the request id", async () => {
  const { deps, logs } = harness();
  const response = await handleApiRequest(
    get(),
    OPTIONS,
    async () => {
      throw new Error('Unique constraint failed on the fields: ("studentCode") value "ADM-0042"');
    },
    deps,
  );

  const payload = await body(response);
  assert.equal(response.status, 500);
  assert.equal(payload.error, "internal_error");
  assert.match(String(payload.message), /generated-request-id/);
  assert.equal(JSON.stringify(payload).includes("ADM-0042"), false);
  assert.equal(JSON.stringify(payload).includes("studentCode"), false);
  assert.equal(logs[0].outcome, "error");
});

test("every error response still carries the request id header", async () => {
  const { deps } = harness();
  for (const thrown of [notFound("Student"), new ApiError("conflict", "Already exists.")]) {
    const response = await handleApiRequest(
      get(),
      OPTIONS,
      async () => {
        throw thrown;
      },
      deps,
    );
    assert.equal(response.headers.get("X-Request-Id"), "generated-request-id");
  }
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("a successful read writes no audit row — that volume would bury the real events", async () => {
  const { deps, audits, logs } = harness();
  await handleApiRequest(get(), OPTIONS, OK, deps);
  assert.equal(audits.length, 0);
  assert.equal(logs.length, 1, "it is still recorded, in the access log");
});

test("a successful write always writes an audit row", async () => {
  const { deps, audits } = harness();
  await handleApiRequest(
    get("https://x.test/api/v1/students", { method: "POST" }),
    { scopes: ["students:write"], resource: "Student" },
    OK,
    deps,
  );

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "api.resource.written");
  assert.equal(audits[0].entityType, "Student");
  assert.equal(audits[0].institutionId, "inst-1");
  assert.equal(audits[0].actorApiKeyId, "key-1");
});

test("every denial writes an audit row, read or write", async () => {
  const { deps, audits } = harness({ authenticate: async () => null });
  await handleApiRequest(get(), OPTIONS, OK, deps);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "api.request.denied");
});

test("audit: 'always' records successful reads for a sensitive endpoint", async () => {
  const { deps, audits } = harness();
  await handleApiRequest(get(), { ...OPTIONS, audit: "always" }, OK, deps);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "api.resource.read");
});

test("an audit-write failure never turns a successful call into a 500", async () => {
  const { deps } = harness({
    recordAudit: async () => {
      throw new Error("audit table unavailable");
    },
  });

  const response = await handleApiRequest(
    get("https://x.test/api/v1/students", { method: "POST" }),
    { scopes: ["students:write"], resource: "Student" },
    OK,
    deps,
  );
  assert.equal(response.status, 200, "the row matters; it does not matter more than the register");
});

test("nothing sensitive reaches the audit row", async () => {
  const { deps, audits } = harness();
  await handleApiRequest(
    get("https://x.test/api/v1/students?api_key=att_live_leaked&limit=10", { method: "POST" }),
    { scopes: ["students:write"], resource: "Student" },
    OK,
    deps,
  );

  const serialised = JSON.stringify(audits[0]);
  assert.equal(serialised.includes("att_live_leaked"), false);
  assert.equal(serialised.includes("Bearer"), false);
  assert.match(serialised, /"limit":"10"/, "harmless query parameters are still recorded");
});

// ---------------------------------------------------------------------------
// The access log
// ---------------------------------------------------------------------------

test("the access log carries who, what and how long without carrying the credential", async () => {
  const { deps, logs } = harness();
  await handleApiRequest(get("https://x.test/api/v1/students?limit=5"), OPTIONS, OK, deps);

  const entry = logs[0];
  assert.equal(entry.requestId, "generated-request-id");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/api/v1/students");
  assert.deepEqual(entry.query, { limit: "5" });
  assert.equal(entry.status, 200);
  assert.equal(entry.apiKeyId, "key-1");
  assert.equal(entry.apiKeyName, "School ERP");
  assert.equal(entry.institutionId, "inst-1");
  assert.equal(entry.resource, "Student");
  assert.equal(entry.headers.authorization, "[present]");
  assert.equal(typeof entry.durationMs, "number");
});

test("exactly one log line is emitted per request, on every path", async () => {
  for (const deps of [
    harness(),
    harness({ authenticate: async () => null }),
    harness({
      authenticate: async () => {
        throw new Error("down");
      },
    }),
  ]) {
    await handleApiRequest(get(), OPTIONS, OK, deps.deps);
    assert.equal(deps.logs.length, 1);
  }
});

// ---------------------------------------------------------------------------
// Request id
// ---------------------------------------------------------------------------

test("a plausible caller-supplied request id is adopted so the trace survives the hop", () => {
  const request = new Request("https://x.test/", { headers: { "x-request-id": "erp-sync-20260916-0001" } });
  assert.equal(resolveRequestId(request, () => "generated"), "erp-sync-20260916-0001");
});

test("a request id that is log injection or a flood is replaced silently", () => {
  for (const value of ["short", "has space", '"quoted"', "x".repeat(9000), "<script>", "id;drop"]) {
    const request = new Request("https://x.test/", { headers: { "x-request-id": value } });
    assert.equal(resolveRequestId(request, () => "generated"), "generated", `${value.slice(0, 12)} rejected`);
  }
});

test("a newline in the header cannot even be constructed, and the pattern is the second line of defence", () => {
  // The runtime's own Headers refuses it, which is worth knowing: the regex is
  // not the only thing standing between a proxy-supplied value and a log line.
  assert.throws(() => new Request("https://x.test/", { headers: { "x-request-id": "line\nbreak" } }));
});

test("an idempotency key is exposed to the handler only when it is well-formed", async () => {
  const { deps } = harness();
  const seen: Array<string | null> = [];
  const capture = async (ctx: { idempotencyKey: string | null; requestId: string }) => {
    seen.push(ctx.idempotencyKey);
    return okResponse({}, ctx.requestId);
  };

  await handleApiRequest(
    get("https://x.test/api/v1/students", { headers: { "x-idempotency-key": "sync-batch-2026-09-16" } }),
    OPTIONS,
    capture,
    deps,
  );
  await handleApiRequest(
    get("https://x.test/api/v1/students", { headers: { "x-idempotency-key": "bad key!" } }),
    OPTIONS,
    capture,
    deps,
  );

  assert.deepEqual(seen, ["sync-batch-2026-09-16", null]);
});

// ---------------------------------------------------------------------------
// Reserved routes
// ---------------------------------------------------------------------------

test("a reserved route answers 501, not 404 — the URL is ours and is not ready", async () => {
  const handler = notImplementedRoute("OAuth2 client credentials are not yet available.");
  const response = await handler(new Request("https://x.test/api/v1/oauth/token", { method: "POST" }));

  assert.equal(response.status, 501);
  const payload = await body(response);
  assert.equal(payload.error, "not_implemented");
  assert.match(String(payload.message), /OAuth2/);
});
