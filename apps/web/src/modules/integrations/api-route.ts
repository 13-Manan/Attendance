import { randomUUID } from "node:crypto";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import {
  DEFAULT_RATE_LIMIT,
  WRITE_RATE_LIMIT,
  rateLimitHeaders,
  rateLimitKey,
  rateLimiter as defaultRateLimiter,
  type RateLimiter,
  type RateLimitRule,
} from "./rate-limit";
import { keyFingerprint, redact, redactHeaders, redactQuery } from "./redaction";
import { missingScopes, type ApiScope } from "./scopes";
import type { ApiErrorCode, ApiErrorResponse, ApiKeyContext } from "./types";

/**
 * The single front door for every `/api/v1/*` endpoint.
 *
 * ## Why a wrapper rather than a middleware
 *
 * Next middleware runs on the edge runtime, before a route's own runtime is
 * chosen, and cannot reach Prisma to look a key up. More importantly, a
 * middleware that guesses the required scope from the URL is a scope check
 * that lives somewhere other than the endpoint it protects — so adding a
 * route means remembering to add a pattern, and forgetting means shipping an
 * unprotected endpoint that looks protected. Here the scope requirement is an
 * argument to the handler's own declaration: a route that does not name its
 * scopes does not compile.
 *
 * ## The order of operations, and why it is this order
 *
 * 1. **Request id** — first, so every later step including a crash can be
 *    correlated.
 * 2. **Authenticate** — before rate limiting, because the bucket is keyed by
 *    API key. (The cost: an unauthenticated flood is not rate limited by this
 *    layer. It is also not *doing* anything — one indexed hash lookup and a
 *    401 — and limiting by IP is the gateway's job, not the application's.
 *    Recorded here so the tradeoff is a decision rather than an oversight.)
 * 3. **Scope** — before rate limiting, so a wrongly-scoped client gets a
 *    stable, immediate 403 instead of an intermittent one that looks like a
 *    server problem.
 * 4. **Rate limit** — before the handler, so the limit actually protects the
 *    database rather than merely reporting on it.
 * 5. **Handler**.
 * 6. **Audit + access log** — always, on every path, including the throw.
 *
 * ## Never logs
 *
 * Everything written from here goes through `redact()` or `redactHeaders()`.
 * No request body is logged in full: only its byte length and, for a
 * validation failure, the *field paths* that failed. Passwords, secrets,
 * biometric embeddings and tokens are named in redaction.ts and cannot reach
 * a log line or an audit row through this path.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  insufficient_scope: 403,
  rate_limited: 429,
  invalid_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  conflict: 409,
  not_implemented: 501,
  internal_error: 500,
};

/**
 * The only error a handler should throw on purpose.
 *
 * Anything else that escapes becomes a 500 with a generic message, on the
 * principle that an unplanned exception's text is written for a developer
 * reading a stack trace, not for a third party — a Prisma error string names
 * columns, constraints, and sometimes values.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;
  readonly requiredScopes?: ApiScope[];

  constructor(code: ApiErrorCode, message: string, options: { details?: unknown; requiredScopes?: ApiScope[] } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = options.details;
    this.requiredScopes = options.requiredScopes;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function notFound(what: string): ApiError {
  return new ApiError("not_found", `${what} not found.`);
}

export function invalidRequest(message: string, details?: unknown): ApiError {
  return new ApiError("invalid_request", message, { details });
}

// ---------------------------------------------------------------------------
// Context and options
// ---------------------------------------------------------------------------

export interface ApiContext {
  request: Request;
  url: URL;
  requestId: string;
  apiKey: ApiKeyContext;
  institutionId: string;
  /** `X-Idempotency-Key`, when the caller sent one. Handlers may ignore it. */
  idempotencyKey: string | null;
  /** Resolved dynamic segments, e.g. `{ id }` for `/students/[id]`. */
  params: Record<string, string>;
  now: Date;
}

/**
 * The second argument Next hands a route handler for a dynamic segment.
 *
 * Awaited by the wrapper rather than by each handler: in this version of Next
 * `params` is a promise, and a handler that forgets the `await` reads
 * `undefined` off a `Promise` object and 404s in a way that looks like a
 * database problem.
 */
export interface RouteSegment {
  params: Promise<Record<string, string>> | Record<string, string>;
}

export type ApiHandler = (ctx: ApiContext) => Promise<Response>;

export interface ApiRouteOptions {
  /**
   * Every scope the endpoint needs. All must be present — an endpoint that
   * joins two resources requires both, because a key scoped only to students
   * must not read attendance through a `?include=` parameter.
   */
  scopes: ApiScope[];
  /**
   * Which rate-limit allowance this endpoint draws from. Separate buckets so
   * exhausting writes does not block reads.
   */
  bucket?: "read" | "write";
  /** The `AuditLog.entityType` for this endpoint, e.g. "Student". */
  resource: string;
  /**
   * Whether a *successful* call writes a durable audit row.
   *
   * `"mutations"` (the default) writes rows for writes, and for every denial
   * and server error regardless of method. Successful reads are recorded in
   * the structured access log only.
   *
   * This split is deliberate and is the one place this module departs from a
   * literal reading of "log every API call to the audit table". An ERP
   * polling a roster every minute would write half a million `AuditLog` rows
   * a year per institution and bury the rows that matter — a revoked key
   * still being used, an attendance write from an unexpected client. Both
   * facts are still captured; they are captured in the place suited to each.
   * `"always"` is available for an endpoint where reads themselves are
   * sensitive.
   */
  audit?: "always" | "mutations";
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ApiAccessLogEntry {
  requestId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  durationMs: number;
  apiKeyId: string | null;
  apiKeyName: string | null;
  institutionId: string | null;
  scopes: string[];
  resource: string;
  outcome: "ok" | "denied" | "error";
  failureReason?: string;
  headers: Record<string, string>;
  rateLimitRemaining?: number;
}

export interface ApiRouteDeps {
  authenticate: (request: Request) => Promise<ApiKeyContext | null>;
  limiter: RateLimiter;
  /** Resolves the rule for this key+bucket. Overridable per institution. */
  resolveRule: (apiKey: ApiKeyContext, bucket: "read" | "write") => Promise<RateLimitRule>;
  recordAudit: (input: RecordAuditLogInput) => Promise<void>;
  log: (entry: ApiAccessLogEntry) => void;
  now: () => Date;
  monotonic: () => number;
  newRequestId: () => string;
}

/**
 * One structured line per request, on stdout.
 *
 * JSON rather than prose because the consumer is a log aggregator, and
 * because a prose formatter is where a value that should have been redacted
 * gets concatenated in by accident. Everything in the entry has already
 * passed through the redactor.
 */
function defaultLog(entry: ApiAccessLogEntry): void {
  const line = JSON.stringify({ log: "api.v1", ...entry });
  if (entry.outcome === "error") console.error(line);
  else console.info(line);
}

/**
 * The two dependencies that reach a database are imported lazily.
 *
 * Not a style choice. `api-key-auth` reads `API_KEY_PEPPER` and the audit
 * service holds the Prisma client, and both validate the environment at module
 * load. A static import here would mean that merely importing this wrapper —
 * the piece with no I/O of its own, and the piece most worth proving correct —
 * requires a populated `.env` and a reachable database. Deferring to first call
 * keeps `handleApiRequest` testable against fakes and costs one resolved
 * promise on the first request of a process.
 */
export const productionDeps: ApiRouteDeps = {
  authenticate: async (request) => {
    const { authenticateApiKey } = await import("./api-key-auth");
    return authenticateApiKey(request);
  },
  limiter: defaultRateLimiter,
  resolveRule: async (_apiKey, bucket) => (bucket === "write" ? WRITE_RATE_LIMIT : DEFAULT_RATE_LIMIT),
  recordAudit: async (input) => {
    const { recordAuditLog } = await import("@/modules/audit/service");
    return recordAuditLog(input);
  },
  log: defaultLog,
  now: () => new Date(),
  monotonic: () => performance.now(),
  newRequestId: () => randomUUID(),
};

// ---------------------------------------------------------------------------
// Request id
// ---------------------------------------------------------------------------

/**
 * Accepts a caller-supplied `X-Request-Id` so a trace survives the hop from
 * the integrator's system into ours — but only if it is plausibly an id.
 *
 * The filter is not decoration. An unvalidated header lands in a JSON log
 * line and in an `AuditLog` row; a value containing a newline or a quote is
 * log injection, and one containing 8KB of text is a denial-of-service
 * against the log pipeline. Anything that fails is silently replaced with a
 * generated id rather than rejected, because a malformed trace header is not
 * a reason to refuse an attendance write.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function resolveRequestId(request: Request, generate: () => string): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && REQUEST_ID_PATTERN.test(supplied)) return supplied;
  return generate();
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Headers every `/api/v1` response carries, success or failure. */
function baseHeaders(requestId: string): Record<string, string> {
  return {
    "X-Request-Id": requestId,
    // Institution data, scoped to a credential. A shared cache holding one of
    // these would serve one school's roster to another's integration.
    "Cache-Control": "no-store, private",
    // The API returns JSON; a browser that sniffs it as HTML would be a
    // reflected-XSS vector through an echoed field.
    "X-Content-Type-Options": "nosniff",
  };
}

export function errorResponse(
  error: ApiError,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body: ApiErrorResponse = {
    // Top-level `error` stays a bare code string: that is the shape
    // docs/API_CONTRACTS.md already publishes for the scaffolded endpoints,
    // and integrators branch on it. `message` and `requestId` are additive.
    error: error.code,
    message: error.message,
    requestId,
  };
  if (error.details !== undefined) body.details = error.details;
  if (error.requiredScopes) body.requiredScopes = error.requiredScopes;

  return Response.json(body, {
    status: error.status,
    headers: { ...baseHeaders(requestId), ...extraHeaders },
  });
}

export function okResponse(body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { headers: { ...baseHeaders(requestId), ...extraHeaders } });
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/**
 * The testable core. `apiRoute` is this with production dependencies bound.
 *
 * Exported so the whole auth/scope/limit/audit pipeline can be exercised
 * against fakes — no database, no clock, no network. See api-route.test.ts.
 */
export async function handleApiRequest(
  request: Request,
  options: ApiRouteOptions,
  handler: ApiHandler,
  deps: ApiRouteDeps,
  segment?: RouteSegment,
): Promise<Response> {
  const startedAt = deps.monotonic();
  const requestId = resolveRequestId(request, deps.newRequestId);
  const url = new URL(request.url);
  const bucket = options.bucket ?? (request.method === "GET" ? "read" : "write");
  const isMutation = request.method !== "GET" && request.method !== "HEAD";

  let apiKey: ApiKeyContext | null = null;
  let rateHeaders: Record<string, string> = {};

  const finish = async (
    response: Response,
    outcome: ApiAccessLogEntry["outcome"],
    failureReason?: string,
  ): Promise<Response> => {
    deps.log({
      requestId,
      method: request.method,
      path: url.pathname,
      query: redactQuery(url),
      status: response.status,
      durationMs: Math.round(deps.monotonic() - startedAt),
      apiKeyId: apiKey?.apiKeyId ?? null,
      apiKeyName: apiKey?.name ?? null,
      institutionId: apiKey?.institutionId ?? null,
      scopes: apiKey?.scopes ?? [],
      resource: options.resource,
      outcome,
      failureReason,
      headers: redactHeaders(request.headers),
      rateLimitRemaining: rateHeaders["RateLimit-Remaining"]
        ? Number(rateHeaders["RateLimit-Remaining"])
        : undefined,
    });

    const wantsAuditRow =
      options.audit === "always" || outcome !== "ok" || (isMutation && outcome === "ok");
    if (wantsAuditRow) {
      // An audit write must never turn a successful attendance submission
      // into a 500. The row is important; it is not more important than the
      // register. A failure here is logged and the response stands.
      await deps
        .recordAudit({
          action: outcome === "ok" ? (isMutation ? "api.resource.written" : "api.resource.read") : "api.request.denied",
          entityType: options.resource,
          // No specific row is implicated for a denial or a list read, so the
          // endpoint itself is the entity. Keeps the [entityType, entityId]
          // index useful for "everything that happened on /v1/attendance".
          entityId: url.pathname,
          institutionId: apiKey?.institutionId ?? null,
          actorApiKeyId: apiKey?.apiKeyId ?? null,
          afterJson: redact({
            requestId,
            method: request.method,
            path: url.pathname,
            query: redactQuery(url),
            status: response.status,
            outcome,
            failureReason,
            apiKeyName: apiKey?.name ?? null,
            authMethod: apiKey?.authMethod ?? null,
          }),
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({ log: "api.v1.audit_failed", requestId, error: redact(error) }),
          );
        });
    }

    return response;
  };

  // --- 2. Authenticate -----------------------------------------------------
  try {
    apiKey = await deps.authenticate(request);
  } catch (error) {
    console.error(JSON.stringify({ log: "api.v1.auth_failed", requestId, error: redact(error) }));
    return finish(
      errorResponse(new ApiError("internal_error", "Authentication is temporarily unavailable."), requestId),
      "error",
      "auth_backend_unavailable",
    );
  }

  if (!apiKey) {
    // `WWW-Authenticate` per RFC 6750 §3 — it is how a generic HTTP client
    // learns this is a bearer-token API rather than guessing.
    return finish(
      errorResponse(
        new ApiError("unauthorized", "A valid API key is required. Send `Authorization: Bearer <key>`."),
        requestId,
        { "WWW-Authenticate": 'Bearer realm="api", error="invalid_token"' },
      ),
      "denied",
      // The fingerprint, never the key. Enough to answer "is the client
      // sending the key we revoked?" and useless to anyone reading the log.
      `invalid_credential:${keyFingerprint(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "")}`,
    );
  }

  // --- 3. Scope ------------------------------------------------------------
  const missing = missingScopes(apiKey.scopes, options.scopes);
  if (missing.length > 0) {
    return finish(
      errorResponse(
        new ApiError(
          "insufficient_scope",
          `This key is missing the required scope(s): ${missing.join(", ")}.`,
          { requiredScopes: options.scopes },
        ),
        requestId,
        { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${options.scopes.join(" ")}"` },
      ),
      "denied",
      `insufficient_scope:${missing.join(",")}`,
    );
  }

  // --- 4. Rate limit -------------------------------------------------------
  const nowMs = deps.now().getTime();
  const rule = await deps.resolveRule(apiKey, bucket);
  const decision = await deps.limiter.consume(rateLimitKey(apiKey.apiKeyId, bucket), rule);
  rateHeaders = rateLimitHeaders(decision, nowMs);

  if (!decision.allowed) {
    return finish(
      errorResponse(
        new ApiError("rate_limited", `Rate limit exceeded for this key's ${bucket} allowance. Retry after the interval in the Retry-After header.`),
        requestId,
        rateHeaders,
      ),
      "denied",
      `rate_limited:${bucket}`,
    );
  }

  // --- 5. Handler ----------------------------------------------------------
  const ctx: ApiContext = {
    request,
    url,
    requestId,
    apiKey,
    institutionId: apiKey.institutionId,
    idempotencyKey: readIdempotencyKey(request),
    params: segment ? await segment.params : {},
    now: deps.now(),
  };

  try {
    const response = await handler(ctx);
    // The handler builds its own body; the wrapper owns the cross-cutting
    // headers, so an endpoint cannot forget the request id or leak into a
    // shared cache by returning a bare `Response.json`.
    const merged = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const [name, value] of Object.entries({ ...baseHeaders(requestId), ...rateHeaders })) {
      merged.headers.set(name, value);
    }
    return finish(merged, merged.status < 400 ? "ok" : "denied", merged.status >= 400 ? `handler_status:${merged.status}` : undefined);
  } catch (error) {
    if (error instanceof ApiError) {
      return finish(
        errorResponse(error, requestId, rateHeaders),
        error.status >= 500 ? "error" : "denied",
        `${error.code}:${error.message}`,
      );
    }
    // Unexpected. The client gets a request id and nothing else; the detail
    // goes to the server log, redacted, where an operator can find it by that
    // id. This is the line that keeps a Prisma constraint message — which
    // names columns and can quote values — out of a third party's console.
    console.error(JSON.stringify({ log: "api.v1.unhandled", requestId, error: redact(error) }));
    return finish(
      errorResponse(
        new ApiError("internal_error", `Unexpected error. Quote request id ${requestId} when reporting this.`),
        requestId,
        rateHeaders,
      ),
      "error",
      "unhandled_exception",
    );
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get("x-idempotency-key");
  return value && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

/**
 * Declares a `/api/v1/*` route handler.
 *
 * ```ts
 * export const GET = apiRoute({ scopes: ["students:read"], resource: "Student" }, async (ctx) => { … });
 * ```
 */
export function apiRoute(
  options: ApiRouteOptions,
  handler: ApiHandler,
): (request: Request, segment?: RouteSegment) => Promise<Response> {
  return (request: Request, segment?: RouteSegment) =>
    handleApiRequest(request, options, handler, productionDeps, segment);
}

/**
 * A handler for a route that is reserved but not implemented — currently the
 * OAuth2 token endpoint.
 *
 * It exists as a real 501 with a real body rather than a 404 because the two
 * mean different things to an integrator: 404 says "you have the wrong URL"
 * and sends them hunting, 501 says "this URL is ours and is not ready yet".
 */
export function notImplementedRoute(message: string): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const requestId = resolveRequestId(request, () => randomUUID());
    return errorResponse(new ApiError("not_implemented", message), requestId);
  };
}
