# API contracts

Three distinct API surfaces exist. See `ARCHITECTURE.md` for why they must
not be conflated.

## A. Internal Next.js ↔ Python face-AI contract

Base URL: `FACE_AI_SERVICE_URL` (private — localhost in dev, internal
network only later; never internet-facing).
Types: `packages/shared-types/src/face-ai-contract.ts` (TypeScript),
mirrored by hand in `services/face-ai/app/schemas.py` (Pydantic). Any shape
change must update both files together.

### Authentication

Every endpoint below except `GET /v1/health` requires a shared service token:

```
Authorization: Bearer <FACE_AI_AUTH_TOKEN>
```

apps/web sends it from `FACE_AI_SERVICE_TOKEN`; the two values must match.
An anonymous or wrong credential gets `401` with a `WWW-Authenticate: Bearer`
challenge, and the check runs *before* body validation, so a malformed
request from an unauthenticated caller is a 401 rather than a 422 — otherwise
the validation errors themselves become an unauthenticated API.

This is not a replacement for network isolation. It is the control that still
works when the isolation turns out to be imaginary: a process cannot tell
whether the port it bound is behind a firewall or published by a
`docker-compose` line somebody added in a hurry, and `POST /v1/enroll` turns a
photograph into the 128-float template that identifies that person. If
reachability were the only control, the first deployment mistake would also be
a biometric breach.

The token carries no identity, institution or scope — there is nothing here to
scope, because the service holds no data and can only act on what the caller
hands it (ADR-0002). It answers exactly one question: *is the caller apps/web?*

With `FACE_AI_AUTH_TOKEN` unset the service accepts anonymous callers and logs
a warning on every boot, so `uvicorn app.main:app` against an empty environment
still works for a local checkout. `FACE_AI_REQUIRE_AUTH=true` turns that
warning into a refusal to start, and any environment holding real faces is
expected to set it. See `docs/SECURITY.md`.

### `GET /v1/health`

```json
{ "status": "ok", "modelName": "mock", "modelVersion": "0.1.0+pp1", "embeddingDim": 128 }
```

### `POST /v1/detect-embed`

Request:

```json
{
  "sessionId": "sess_123",
  "images": [{ "sequenceNumber": 1, "imageBase64": "..." }]
}
```

Response:

```json
{
  "faces": [
    {
      "sequenceNumber": 1,
      "boundingBox": { "x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2 },
      "embedding": [0.0123, "... 128 floats total"],
      "detectionConfidence": 0.99,
      "qualityScore": 0.9
    }
  ],
  "modelName": "mock",
  "modelVersion": "0.1.0"
}
```

Consumed from `apps/web` via `src/lib/face-ai-client.ts`. Nothing else
should construct requests to `FACE_AI_SERVICE_URL` directly.

The Next.js side of this contract — `apps/web/src/app/api/internal/sessions/[sessionId]/process/route.ts` —
is a **Route Handler**, not a Server Action, because it is (eventually) a
multi-step orchestration endpoint that could be invoked by a queue/worker,
not a form-bound component mutation. In this phase it validates the request
shape and confirms the session exists, then returns `501` — orchestration
(calling face-ai, running the vector search, applying the confidence
engine, writing `AttendanceRecord` rows) is a later phase.

## B. Public integration REST API

Base path: `apps/web/src/app/api/v1/*`. Versioned, third-party-facing.
Full design notes in [docs/INTEGRATIONS.md](INTEGRATIONS.md).

**Auth**: `Authorization: Bearer <raw key>`. The raw key is HMAC-SHA256'd
with `API_KEY_PEPPER` and looked up against `ApiKey.hashedKey`
(`modules/integrations/api-key-auth.ts`). A missing/invalid/revoked key
returns `401 { "error": "unauthorized" }`. OAuth2 client-credentials is
reserved at `/api/v1/oauth/token`, which answers `501` naming the method that
works today — API keys are the only auth method that is implemented.

**Authorization**: scopes, not roles. Every route declares the scopes it needs
in its `apiRoute({ scopes: [...] })` options; the key's granted scopes are the
only input. `students:write` does **not** imply `students:read`, and there is
no wildcard — see `modules/integrations/scopes.ts` for why.

### Endpoints

Every route below is wrapped by `apiRoute()`
(`modules/integrations/api-route.ts`), which applies authentication, the scope
check, rate limiting and audit logging before the handler runs.

| Endpoint | Methods | Scope |
| --- | --- | --- |
| `/api/v1/students` | GET, POST | `students:read` / `students:write` |
| `/api/v1/students/{id}` | GET, PATCH | `students:read` / `students:write` |
| `/api/v1/classes`, `/classes/{id}` | GET | `classes:read` |
| `/api/v1/sections`, `/sections/{id}` | GET | `sections:read` |
| `/api/v1/programs`, `/programs/{id}` | GET | `programs:read` |
| `/api/v1/subjects`, `/subjects/{id}` | GET | `subjects:read` |
| `/api/v1/faculty`, `/faculty/{id}` | GET | `faculty:read` |
| `/api/v1/enrollments`, `/enrollments/{id}` | GET | `enrollments:read` |
| `/api/v1/attendance` | GET | `attendance:read` |
| `/api/v1/attendance/{id}` | GET, PATCH | `attendance:read` / `attendance:write` |
| `/api/v1/attendance/sessions`, `/sessions/{id}` | GET | `attendance:read` |
| `/api/v1/reports`, `/reports/attendance` | GET | `reports:read` |
| `/api/v1/institutions` | GET | `institutions:read` |
| `/api/v1/integrations` | GET | `integrations:read` |
| `/api/v1/webhooks` | GET, POST | `integrations:read` / `integrations:write` |
| `/api/v1/webhooks/{id}` | DELETE | `integrations:write` |
| `/api/v1/external-ids` | GET, POST, DELETE | `integrations:read` / `integrations:write` |
| `/api/v1/oauth/token` | POST | — (`501`, reserved) |

`/api/v1/attendance-records` is retained as a GET alias of `/api/v1/attendance`
because it is the path this document published in an earlier phase, and a
versioned API does not move a URL an integrator has already deployed against.

Integrations can only be **read** over the API. An API that let one integration
create another would let a compromised key establish persistent outbound
access to a server of its choosing; connections are created by an administrator
in the Integration Center.

### External identifiers

An ERP calls a student `STU-10092`; this platform calls them a cuid. Neither
is derivable from the other, so the mapping is explicit.

```http
POST /api/v1/external-ids
Authorization: Bearer att_live_…
Content-Type: application/json

{ "provider": "erp-x", "entityType": "STUDENT",
  "externalId": "STU-10092", "internalId": "cmu5dx…" }
```

`entityType` is one of `STUDENT`, `FACULTY`, `COHORT`, `SUBJECT`.

Once mapped, any student route accepts the external form in place of an id:

```http
GET /api/v1/students/external:erp-x:STU-10092
```

The `external:` prefix is a deliberate opt-in. Trying an id as internal and
falling back to external would make a request's meaning depend on what happens
to exist, and would let a caller learn which internal ids are real by watching
which lookups changed behaviour. An unmapped external id returns the same
`404` as a student who does not exist.

**Semantics**

- **Institution-scoped.** The institution comes from the API key. Two tenants
  using the same vendor both have a student `STU-10092` and they are different
  people; that is representable, not a collision.
- **Idempotent.** Re-posting an identical mapping returns the same row.
- **Re-pointable.** Pointing an existing `externalId` at a different
  `internalId` updates in place — students are merged and re-keyed in real
  school offices.
- **One id per provider per record.** Giving one student a second `erp-x` id is
  `409`: nothing here can tell which one the external system now means. Two
  *different* providers may both map the same record.
- `provider` is matched case-insensitively; `externalId` is **not**, because it
  is the other system's own string.

Deleting a mapping deletes only the mapping. Disconnecting an integration is
not a reason to delete a student, and this endpoint has no authority to.

### Envelopes

List responses:

```json
{
  "data": [ … ],
  "pagination": { "limit": 50, "nextCursor": "…", "hasMore": true },
  "requestId": "…"
}
```

Pagination is cursor-based (`?limit=`, `?cursor=`), default 50, max 200. A
`limit` that is absent, non-numeric or out of range is defaulted or clamped
rather than rejected — an integrator's templating bug should return a first
page, not stall their nightly sync — and the effective value is echoed back. A
malformed **cursor** does throw, because silently restarting from row one would
re-import the whole roster while reporting success.

Errors:

```json
{ "error": "insufficient_scope", "message": "…", "requestId": "…", "requiredScopes": ["students:read"] }
```

| `error` | Status |
| --- | --- |
| `invalid_request` | 400 |
| `unauthorized` | 401 |
| `insufficient_scope` | 403 (with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`) |
| `not_found` | 404 |
| `method_not_allowed` | 405 |
| `conflict` | 409 |
| `payload_too_large` | 413 |
| `rate_limited` | 429 (with `Retry-After`) |
| `internal_error` | 500 |
| `not_implemented` | 501 |

The top-level `error` stays a bare code string — that is the shape this
document published for the scaffolded endpoints and integrators branch on it.
`message`, `requestId`, `details` and `requiredScopes` are additive.

### Headers

Every response, success or failure, carries `X-Request-Id` (echoed from the
request when supplied, so a caller's id survives into our audit log),
`Cache-Control: no-store, private` — a shared cache holding one of these would
serve one school's roster to another's integration — and
`X-Content-Type-Options: nosniff`.

Rate-limited responses add the IETF draft `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset`; a `429` adds `Retry-After`.

### Audit

Every request writes one audit row: the API client, the endpoint, the
timestamp, the status, the request id, the resource touched, and the failure
reason when there is one (`api.request.denied`, `api.resource.read`,
`api.resource.written`). Payloads pass through
`modules/integrations/redaction.ts` first. Passwords, secrets, biometric
embeddings and tokens are never written.

## C. Server Actions vs Route Handlers

- **Server Actions** (`"use server"`) — in-app, session-authenticated UI
  mutations co-located with the domain module, e.g.
  `modules/attendance/actions.ts#correctAttendanceRecord`. Real
  session-derived `changedByUserId` lands with the auth phase
  (`modules/auth-tenancy`); this phase's action accepts it as an explicit
  argument and validates the rest of the payload with zod.
- **Route Handlers** — anything consumed by a non-React client,
  service-to-service, streaming, or public/webhook-facing: surfaces A and B
  above, plus the realtime SSE endpoint below.

## Realtime (SSE)

`GET /api/realtime/attendance/[sessionId]` — `Content-Type: text/event-stream`.
Subscribes to `modules/realtime/publisher.ts`'s in-memory publisher for the
given session and forwards any `AttendanceRealtimeEvent` as an SSE `data:`
line; also emits a `: heartbeat` comment every 15s. This phase proves the
transport works end-to-end — verify with:

```bash
curl -N localhost:3000/api/realtime/attendance/test-session
```

No code path publishes a real event yet (that wiring — e.g. from
`correctAttendanceRecord` — is deferred), so expect only heartbeats.
