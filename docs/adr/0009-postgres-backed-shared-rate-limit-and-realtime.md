# ADR-0009: Postgres-backed shared rate limiting and realtime

## Status

Accepted (Phase 15). Supersedes the single-instance halves of
[ADR-0004](0004-realtime-sse-in-memory-pubsub.md) and
[ADR-0007](0007-in-process-webhooks-and-in-memory-rate-limiting.md). The
webhook half of ADR-0007 is untouched and remains in-process.

## Context

Two components held their state in process memory:

1. `MemoryRateLimiter` — a token bucket in a `Map`.
2. `InMemoryAttendanceEventPublisher` — an `EventEmitter`.

Both ADRs recorded this as a known limitation to be fixed "before scaling
beyond one instance". `infra/azure/modules/app.bicep` already declares
`minReplicas: 1, maxReplicas: 5` for the web app, so the limitation was not
hypothetical — it was a live defect waiting on traffic:

- An API key's real ceiling was up to `replicas × limit`, and every restart or
  scale event handed back a full bucket.
- A correction published on one replica reached only the SSE clients connected
  to that replica. With five, roughly four in five student portals never got
  the update.

Both ADRs named the same two candidate replacements: Postgres `LISTEN/NOTIFY`
or Redis.

## Decision

**Use the PostgreSQL instance the application already depends on.**

- **Rate limiting**: a `RateLimitBucket` table and one statement per decision —
  `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`. The refill, the
  comparison and the charge are all evaluated inside the `DO UPDATE`, against
  the existing row, while Postgres holds its lock.
- **Realtime**: `pg_notify` on a single channel, `LISTEN` on one dedicated
  connection per replica, fanned out in process to the subscribers that asked
  for that channel.

Both are selected by `RATE_LIMIT_BACKEND` and `REALTIME_BACKEND`, which default
to `postgres`. The in-memory implementations remain, selected by `memory`.

### Why not Redis

Redis is the better-fitting primitive in the abstract — purpose-built atomics,
native pub/sub, no write amplification on a relational store. It was rejected
for this phase on three specific grounds:

1. **It needs an Azure resource that does not exist.** Azure Cache for Redis
   would have to be provisioned, networked and key-rotated before any of this
   could ship. Postgres needs nothing: the connection string is already in the
   container's environment.
2. **It adds a failure mode without removing one.** Every request behind the
   limiter goes on to read the institution's data from Postgres. A second
   network dependency can fail independently; Postgres failing is already fatal
   to the request.
3. **Local development would regress.** There is no `docker-compose.yml` in
   this repository. A Redis-backed limiter would mean either a new service for
   every developer, or a local adapter divergent from production — which is the
   arrangement that hides concurrency bugs.

The cost is one database round-trip on the hot path of the public API.
Measured on the development machine: mean 0.126 ms, p95 0.201 ms, p99 0.323 ms
per decision, against a request that already takes single-digit milliseconds.
If that ever becomes the bottleneck, the `RateLimiter` interface is still the
seam a Redis implementation drops into.

## Consequences

### Guarantees, stated exactly

- **Delivery is at-most-once**, unchanged. `NOTIFY` reaches sessions listening
  at that moment and retains nothing. A client disconnected during a publish
  misses that event, exactly as it did with the `EventEmitter`. **No replay or
  resume was invented.**
- **Ordering** is per-listener: Postgres delivers to one connection in commit
  order. There is no global order across publishers and none is claimed.
- **Nothing depends on either property.** Both SSE clients treat the event as a
  hint and re-read from the server —
  `portal/attendance/attendance-client.tsx` calls `refetch()`, and
  `review/[sessionId]/review-client.tsx` applies the counts for immediacy and
  then calls `refresh()`. No realtime event writes to the database. A duplicate
  is therefore idempotent and an out-of-order pair converges.
- **PostgreSQL remains authoritative for all attendance state.**

### Security

Authorization did not move. The transport carries every event to every replica,
so a replica sees envelopes for channels it has no subscriber for and discards
them — the same property Redis pub/sub has. Who may subscribe is still decided
in `app/api/realtime/**`, which was not modified in this phase. The channel
split (`session:` / `student:`) remains an authorization boundary.

No new credential exists: both backends reuse `DATABASE_URL`. Nothing is
`NEXT_PUBLIC_`, and the browser reaches realtime only through the authorized
SSE routes.

### Failure behaviour

A shared-store outage is **not** caught and **does not fail open**. The error
propagates to the existing handler, producing `internal_error` (500) and an
`api.v1.unhandled` log line. Failing open would silently delete the
protection; failing closed with a 429 would blame a well-behaved client for our
fault. Measured against an instance pointed at a dead database: the app still
boots, and API requests return 500 — never 200.

The listener connection reconnects on its own after a socket error while any
subscriber remains, and `close()` releases it for a rolling deploy.

### Known limitation, carried forward

Neither SSE client implements reconnect or backoff — both are a bare
`new EventSource(...)`. When the instance serving a stream is replaced, the
browser can end up with a `CLOSED` stream and a screen that is stale until the
next navigation. This is **pre-existing and unchanged**: Phase 15 modified
neither the routes nor the clients. It is safe because the database is
authoritative and every screen re-reads on load, but it is a real gap and the
natural next piece of work.

### Azure — required later, not created here

Phase 15 created and modified **no Azure resource**. What eventually needs to be
true in production:

| Requirement | Value |
| --- | --- |
| Service | The existing Azure Database for PostgreSQL. No new resource. |
| Networking | Unchanged. Replicas already reach it. |
| Authentication | Existing `DATABASE_URL` secret. No new secret. |
| TLS | Unchanged; the same connection string and `sslmode`. |
| New env vars | `RATE_LIMIT_BACKEND`, `REALTIME_BACKEND` — optional, both default to `postgres`. |
| Connections | One extra long-lived connection per replica, and only on a replica that has an SSE subscriber. At `maxReplicas: 5`, at most 5 above today. |
| Migration | `20260920181329_rate_limit_bucket`, additive, one table, no foreign keys. |
| Scaling | Bucket contention is per API key; unrelated keys never touch the same row. |
| Failure | See above: visible 500s, no silent loss of rate limiting. |

The only judgement call for whoever deploys this is connection headroom for the
listener sockets. Nothing else changes.
