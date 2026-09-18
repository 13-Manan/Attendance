import { test } from "node:test";
import assert from "node:assert/strict";
import { RestProvider, parseFetchResponse, restResources, validateBaseUrl } from "./rest-provider.ts";
import { CsvProvider } from "./csv-provider.ts";
import { WebhookProvider } from "./webhook-provider.ts";
import { getProvider, isIntegrationKind, listProviderSummaries, listProviders } from "./registry.ts";
import { UNSUPPORTED } from "./provider.ts";

/** A fetch that records what it was asked for and answers from a handler. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// The SSRF guard
// ---------------------------------------------------------------------------

test("a base URL is required and must be absolute", () => {
  assert.deepEqual(validateBaseUrl(undefined), ["Base URL is required."]);
  assert.deepEqual(validateBaseUrl("   "), ["Base URL is required."]);
  assert.match(validateBaseUrl("/api/students")[0], /valid absolute URL/);
  assert.match(validateBaseUrl("erp.example.edu")[0], /valid absolute URL/);
});

test("a non-HTTP scheme is refused, because this fetch runs on our server", () => {
  // `file:///etc/passwd` would read the container's filesystem through a text
  // box an administrator typed into.
  for (const url of ["file:///etc/passwd", "ftp://erp.example.edu", "gopher://erp.example.edu"]) {
    assert.ok(
      validateBaseUrl(url).some((p) => /http:\/\/ or https:\/\//.test(p)),
      `${url} should be refused`,
    );
  }
});

test("loopback and link-local hosts are refused", () => {
  // `169.254.169.254` is cloud instance metadata: never a legitimate ERP host,
  // always worth a credential to whoever can reach it.
  for (const url of [
    "http://localhost:3000/api",
    "http://LOCALHOST/api",
    "http://127.0.0.1/api",
    "http://127.1.2.3/api",
    "http://0.0.0.0/api",
    "http://[::1]/api",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.1.1/",
  ]) {
    assert.ok(
      validateBaseUrl(url).some((p) => /this server or a link-local address/.test(p)),
      `${url} should be refused`,
    );
  }
});

test("a private-LAN host is allowed, because an on-premises ERP is the point", () => {
  // Refusing 10.x/192.168.x would make this feature useless for exactly the
  // institutions it exists for. The trust boundary is that only an institution
  // admin can configure a connection.
  assert.deepEqual(validateBaseUrl("http://10.0.4.12:8080/api"), []);
  assert.deepEqual(validateBaseUrl("http://192.168.1.50/erp"), []);
  assert.deepEqual(validateBaseUrl("https://erp.internal/api"), []);
});

test("credentials in the URL are refused with the reason", () => {
  const problems = validateBaseUrl("https://admin:hunter2@erp.example.edu/api");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /header/);
});

test("a URL with several problems reports all of them at once", () => {
  // A form that reveals one error at a time is how a person makes five round
  // trips to configure four fields.
  const problems = validateBaseUrl("ftp://user:pw@127.0.0.1/api");
  assert.equal(problems.length, 3);
});

test("an ordinary https URL passes", () => {
  assert.deepEqual(validateBaseUrl("https://erp.example.edu/api/v2/"), []);
});

// ---------------------------------------------------------------------------
// REST provider: configuration
// ---------------------------------------------------------------------------

test("a header name carrying CRLF is refused, because it is injection through us", () => {
  const problems = new RestProvider().validateConfig({
    baseUrl: "https://erp.example.edu",
    headers: { "X-Api-Key\r\nX-Injected": "abc" },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a valid HTTP header name/);
});

test("ordinary header names pass", () => {
  assert.deepEqual(
    new RestProvider().validateConfig({
      baseUrl: "https://erp.example.edu",
      headers: { Authorization: "Bearer x", "X-Tenant-Id": "north", "X-A_b.c": "1" },
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// REST provider: testing a connection
// ---------------------------------------------------------------------------

test("a reachable endpoint reports success with its latency", async () => {
  const { impl, calls } = fakeFetch(() => json({ data: [] }));
  const result = await new RestProvider(impl, 50).testConnection({
    baseUrl: "https://erp.example.edu/api/",
    testPath: "/health",
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(calls[0].url, "https://erp.example.edu/api/health", "slashes are joined, not doubled");
});

test("a rejected credential is reported differently from an unreachable host", async () => {
  // "Reachable but rejected the credential" and "unreachable" send an
  // administrator to two completely different places.
  const rejected = await new RestProvider(fakeFetch(() => json({}, 401)).impl, 50).testConnection({
    baseUrl: "https://erp.example.edu",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.statusCode, 401);
  assert.match(rejected.message, /credential was rejected/);
  assert.match(rejected.message, /headers on this connection/);

  const broken = await new RestProvider(fakeFetch(() => json({}, 500)).impl, 50).testConnection({
    baseUrl: "https://erp.example.edu",
  });
  assert.match(broken.message, /HTTP 500/);
  assert.match(broken.message, /test path/);
});

test("a 403 is treated as a credential problem too", async () => {
  const result = await new RestProvider(fakeFetch(() => json({}, 403)).impl, 50).testConnection({
    baseUrl: "https://erp.example.edu",
  });
  assert.match(result.message, /credential was rejected/);
});

test("a network failure is a message, not an unhandled rejection", async () => {
  const { impl } = fakeFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND erp.example.edu");
  });
  const result = await new RestProvider(impl, 50).testConnection({ baseUrl: "https://erp.example.edu" });
  assert.equal(result.ok, false);
  assert.match(result.message, /Could not reach/);
  assert.equal(result.statusCode, undefined);
});

test("an invalid configuration is refused before a request is made", async () => {
  const { impl, calls } = fakeFetch(() => json({}));
  const result = await new RestProvider(impl, 50).testConnection({ baseUrl: "http://169.254.169.254/" });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "the SSRF guard runs before the fetch, not after it");
});

// ---------------------------------------------------------------------------
// REST provider: fetching
// ---------------------------------------------------------------------------

test("a fetch asks for the resource path, the page size and the cursor", async () => {
  const { impl, calls } = fakeFetch(() => json({ data: [{ id: "1" }] }));
  await new RestProvider(impl, 50).fetch(
    { baseUrl: "https://erp.example.edu/api", resourcePaths: { students: "/roster" } },
    { resource: "students", limit: 200, cursor: "page-4" },
  );

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/roster");
  assert.equal(url.searchParams.get("limit"), "200");
  assert.equal(url.searchParams.get("cursor"), "page-4");
});

test("a resource with no configured path falls back to its own name", async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  await new RestProvider(impl, 50).fetch(
    { baseUrl: "https://erp.example.edu/api" },
    { resource: "subjects", limit: 50 },
  );
  assert.equal(new URL(calls[0].url).pathname, "/api/subjects");
});

test("the incremental watermark is sent under both conventional names", async () => {
  // Systems that accept one usually ignore the other, and sending both costs
  // a query parameter.
  const { impl, calls } = fakeFetch(() => json([]));
  const since = new Date("2026-09-16T10:00:00.000Z");
  await new RestProvider(impl, 50).fetch(
    { baseUrl: "https://erp.example.edu" },
    { resource: "students", limit: 50, since },
  );

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("since"), since.toISOString());
  assert.equal(url.searchParams.get("updated_after"), since.toISOString());
});

test("a full sync sends no watermark at all", async () => {
  const { impl, calls } = fakeFetch(() => json([]));
  await new RestProvider(impl, 50).fetch(
    { baseUrl: "https://erp.example.edu" },
    { resource: "students", limit: 50 },
  );
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.has("since"), false);
  assert.equal(url.searchParams.has("cursor"), false);
});

test("configured headers are sent and a redirect is never followed", async () => {
  // A followed redirect is the SSRF guard undone in one hop: the validated
  // host answers with a Location pointing at the metadata service.
  const { impl, calls } = fakeFetch(() => json([]));
  await new RestProvider(impl, 50).fetch(
    { baseUrl: "https://erp.example.edu", headers: { "X-Api-Key": "abc" } },
    { resource: "students", limit: 50 },
  );

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Api-Key"], "abc");
  assert.equal(headers.Accept, "application/json");
  assert.equal(calls[0].init.redirect, "manual");
});

test("the caller's abort signal is used when it supplies one", async () => {
  const controller = new AbortController();
  const { impl, calls } = fakeFetch(() => json([]));
  await new RestProvider(impl, 50).fetch(
    { baseUrl: "https://erp.example.edu" },
    { resource: "students", limit: 50, signal: controller.signal },
  );
  assert.equal(calls[0].init.signal, controller.signal);
});

test("an error status names the resource, so a multi-resource run says which one broke", async () => {
  const { impl } = fakeFetch(() => json({ error: "nope" }, 503));
  await assert.rejects(
    () => new RestProvider(impl, 50).fetch({ baseUrl: "https://erp.example.edu" }, { resource: "students", limit: 50 }),
    /students: external system returned HTTP 503/,
  );
});

// ---------------------------------------------------------------------------
// Normalising whatever came back
// ---------------------------------------------------------------------------

test("a bare JSON array is a page", () => {
  const page = parseFetchResponse([{ student_id: "ADM-001" }]);
  assert.deepEqual(page.rows, [{ student_id: "ADM-001" }]);
  assert.equal(page.nextCursor, null);
});

test("the conventional envelope keys are unwrapped", () => {
  for (const key of ["data", "items", "results", "records", "rows", "content"]) {
    const page = parseFetchResponse({ [key]: [{ id: "1" }] });
    assert.deepEqual(page.rows, [{ id: "1" }], `${key} should be unwrapped`);
  }
});

test("the conventional cursor keys are read", () => {
  for (const key of ["nextCursor", "next_cursor", "nextPageToken", "next", "cursor"]) {
    assert.equal(parseFetchResponse({ data: [], [key]: "page-2" }).nextCursor, "page-2", key);
  }
});

test("an empty cursor is the end of the walk, not an empty page request", () => {
  assert.equal(parseFetchResponse({ data: [], nextCursor: "" }).nextCursor, null);
  assert.equal(parseFetchResponse({ data: [], nextCursor: 7 }).nextCursor, null);
});

test("every value becomes a string, so a leading-zero code survives", () => {
  // A student code of `0012` arriving as the number 12 stops matching the
  // code in our database, and nothing about the import looks wrong.
  const page = parseFetchResponse([{ code: "0012", roll: 12, active: true, marks: 93.5 }]);
  assert.deepEqual(page.rows[0], { code: "0012", roll: "12", active: "true", marks: "93.5" });
});

test("nulls are absent rather than the string 'null'", () => {
  // `String(null)` in an email column is a row that imports "null" as a
  // person's email address.
  const page = parseFetchResponse([{ code: "ADM-001", email: null, phone: undefined }]);
  assert.deepEqual(page.rows[0], { code: "ADM-001" });
});

test("a nested object is dropped rather than stringified into a cell", () => {
  // A mapping cannot target a nested field, so keeping it would put
  // `{"street":"…"}` into a student's name column on a mis-mapping.
  const page = parseFetchResponse([{ code: "ADM-001", address: { street: "12 Main St" }, tags: ["a"] }]);
  assert.deepEqual(page.rows[0], { code: "ADM-001" });
});

test("entries that are not objects are skipped rather than producing empty rows", () => {
  const page = parseFetchResponse([{ code: "ADM-001" }, null, "ADM-002", 7, ["nested"]]);
  assert.equal(page.rows.length, 1);
});

test("the first envelope key that holds an array wins", () => {
  const page = parseFetchResponse({ data: [{ id: "from-data" }], items: [{ id: "from-items" }] });
  assert.equal(page.rows[0].id, "from-data");
});

test("an envelope whose key holds something other than an array is skipped", () => {
  const page = parseFetchResponse({ data: { count: 0 }, results: [{ id: "1" }] });
  assert.deepEqual(page.rows, [{ id: "1" }]);
});

test("a response that is not a list at all fails with a sentence naming what was expected", () => {
  for (const payload of [{ message: "ok" }, "ok", 7, null]) {
    assert.throws(
      () => parseFetchResponse(payload),
      /Expected a JSON array, or an object with a `data`\/`items`\/`results` array/,
      JSON.stringify(payload),
    );
  }
});

test("an empty list is a valid empty page", () => {
  assert.deepEqual(parseFetchResponse([]), { rows: [], nextCursor: null });
  assert.deepEqual(parseFetchResponse({ data: [] }), { rows: [], nextCursor: null });
});

// ---------------------------------------------------------------------------
// CSV provider
// ---------------------------------------------------------------------------

test("a CSV connection declares what it cannot do instead of failing when asked", () => {
  // A "Test connection" button that is absent is honest; one that is present
  // and always fails is not.
  const capabilities = new CsvProvider().capabilities;
  assert.equal(capabilities.testConnection, false);
  assert.equal(capabilities.pull, false);
  assert.equal(capabilities.scheduled, false);
  assert.equal(capabilities.incremental, false);
  assert.equal(capabilities.push, true);
});

test("a multi-character delimiter is refused", () => {
  assert.deepEqual(new CsvProvider().validateConfig({ delimiter: "," }), []);
  assert.deepEqual(new CsvProvider().validateConfig({}), []);
  assert.match(new CsvProvider().validateConfig({ delimiter: "||" })[0], /single character/);
});

test("testing a CSV connection declines rather than throwing", async () => {
  assert.deepEqual(await new CsvProvider().testConnection(), UNSUPPORTED);
});

test("pulling from a CSV connection fails with an instruction, not a type error", async () => {
  await assert.rejects(
    () => new CsvProvider().fetch({}, { resource: "students", limit: 50 }),
    /cannot pull students: upload a file through the Integration Center/,
  );
});

test("a CSV connection reads an uploaded file with its configured delimiter", () => {
  const page = new CsvProvider().read({ delimiter: ";" }, "student_id;name\nADM-001;Ananya\n");
  assert.deepEqual(page.rows, [{ student_id: "ADM-001", name: "Ananya" }]);
  assert.equal(page.nextCursor, null, "a file is one page by definition");
});

// ---------------------------------------------------------------------------
// Webhook provider
// ---------------------------------------------------------------------------

test("the delivery URL is held to the same SSRF rules, worded for the field it is", () => {
  const problems = new WebhookProvider().validateConfig({ deliveryUrl: "http://169.254.169.254/" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Delivery URL/);
  assert.equal(problems[0].includes("Base URL"), false);
});

test("a missing delivery URL is reported", () => {
  assert.match(new WebhookProvider().validateConfig({})[0], /Delivery URL is required/);
});

test("the test POST carries no student data and is not signed", () => {
  // It is sent before the endpoint is necessarily configured, possibly to a
  // URL with a typo in it. A signed payload of real student data is not the
  // thing to send somewhere you are not yet sure about.
  const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  return new WebhookProvider(impl)
    .testConnection({ deliveryUrl: "https://sis.example.edu/hooks" })
    .then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.statusCode, 204);
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { type: "ping", apiVersion: "v1" });
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers["X-Attendance-Event-Type"], "ping");
      assert.equal("X-Attendance-Signature" in headers, false);
    });
});

test("an endpoint that does not answer 2xx is told what it must answer", async () => {
  const result = await new WebhookProvider(fakeFetch(() => new Response("", { status: 302 })).impl).testConnection({
    deliveryUrl: "https://sis.example.edu/hooks",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /must answer 2xx/);
});

test("an unreachable endpoint is a message, not an unhandled rejection", async () => {
  const { impl } = fakeFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const result = await new WebhookProvider(impl).testConnection({ deliveryUrl: "https://sis.example.edu/hooks" });
  assert.equal(result.ok, false);
  assert.match(result.message, /Could not reach the endpoint/);
});

test("an invalid delivery URL is refused before anything is posted", async () => {
  const { impl, calls } = fakeFetch(() => new Response("", { status: 200 }));
  await new WebhookProvider(impl).testConnection({ deliveryUrl: "file:///etc/passwd" });
  assert.equal(calls.length, 0);
});

test("a webhook connection cannot be used to pull", async () => {
  await assert.rejects(
    () => new WebhookProvider().fetch({}, { resource: "students", limit: 50 }),
    /Use a REST connection to read from an external system/,
  );
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("every registered kind resolves to a provider that agrees about its own kind", () => {
  // The map key and the provider's `kind` field drifting apart would make
  // `getProvider(connection.kind)` return the wrong adapter silently.
  for (const summary of listProviderSummaries()) {
    assert.equal(getProvider(summary.kind).kind, summary.kind);
  }
});

test("the brief's three adapter types are all registered", () => {
  assert.deepEqual(listProviderSummaries().map((p) => p.kind).sort(), ["csv", "rest", "webhook"]);
});

test("a kind from a future or rolled-back build fails loudly rather than returning nothing", () => {
  // Reachable: `kind` comes out of a settings blob another build wrote.
  assert.throws(
    () => getProvider("graphql" as never),
    /Unknown integration kind: graphql/,
  );
});

test("kind recognition does not trust an arbitrary string", () => {
  assert.equal(isIntegrationKind("rest"), true);
  for (const value of ["REST", "graphql", "", null, undefined, 7, {}, "toString", "constructor"]) {
    assert.equal(isIntegrationKind(value), false, `${String(value)} should not be a kind`);
  }
});

test("the picker has a label and capabilities for every kind", () => {
  for (const summary of listProviderSummaries()) {
    assert.ok(summary.label.length > 0, `${summary.kind} needs a label`);
    assert.ok(summary.capabilities.resources.length > 0, `${summary.kind} needs resources`);
  }
});

test("providers are singletons, since they hold no per-connection state", () => {
  assert.equal(getProvider("rest"), getProvider("rest"));
  assert.equal(listProviders().length, listProviderSummaries().length);
});

test("a provider only claims resources the platform actually has", () => {
  const known = new Set([
    "students",
    "classes",
    "sections",
    "programs",
    "subjects",
    "faculty",
    "enrollments",
    "attendance",
  ]);
  for (const provider of listProviders()) {
    for (const resource of provider.capabilities.resources) {
      assert.ok(known.has(resource), `${provider.kind} claims unknown resource ${resource}`);
    }
  }
  assert.ok(restResources().includes("students"));
});
