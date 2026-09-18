# ADR-0007: In-process webhook dispatch and in-memory rate limiting

## Status

Accepted (integration phase). Both components are deliberately single-process
and both are expected to be replaced before a multi-instance deployment — see
Consequences.

## Context

The Integration Hub needs two pieces of infrastructure that are normally
someone else's product:

1. **Outbound webhook delivery.** Seven event types, per-endpoint signing
   secrets, retries with backoff, and a durable record of what was delivered
   and what failed.
2. **Rate limiting** on the public `/api/v1` surface. *"Do not expose
   unrestricted APIs"* means an authenticated key still has a ceiling.

The textbook answers are a durable queue (Redis/SQS + a worker) and a shared
counter store (Redis). Both are correct. Both are also a broker, a worker
process, a deployment topology and an operational runbook — for a phase whose
own constraints are **zero new npm dependencies** and **no database schema
changes**, and which explicitly does not deploy.

## Decision

Ship both in-process, behind interfaces, and say so in writing.

- **Webhooks** fan out from `modules/integrations/webhook-dispatcher.ts` in the
  same Node process that handled the originating request. Retry policy and
  delivery state are computed by `webhook-delivery.ts`, a pure module.
  Delivery outcomes are written to `AuditLog` as
  `webhook.delivery.succeeded` / `webhook.delivery.failed`.
- **Rate limiting** is a token bucket in `modules/integrations/rate-limit.ts`
  behind a `RateLimiter` interface, with a `MemoryRateLimiter` as the only
  implementation and `rateLimiter` as the exported singleton.

## Rationale

The alternative that was actually tempting was not "add Redis" — it was "skip
the abstraction and inline the logic", which is the version that is genuinely
hard to replace later.

- **The interface is the deliverable.** `api-route.ts` calls `RateLimiter`; it
  does not know whether the counter lives in a `Map` or in Redis. Swapping
  backends is a new class and a changed export. The same is true of the
  dispatcher: the retry policy and the signing are pure functions with their
  own tests, so a queue-backed worker would reuse them unchanged rather than
  reimplement them.
- **The durable half is already durable.** Delivery results and sync runs go
  to `AuditLog`, a real table. A process restart loses in-flight retries; it
  does not lose the record of what happened. That is the half that matters for
  answering "did the ERP get Tuesday's attendance?".
- **Honest defaults beat impressive ones.** A token bucket that is correct
  per-process and documented as per-process is more useful than a distributed
  limiter that is subtly wrong because nobody ran it against a real cluster.
- **Zero new dependencies** was a hard constraint of this phase, and both
  components are small enough to own: the limiter is under 250 lines including
  its doc comments, and the signature and retry modules are pure.

## Consequences

### What is now true and must not be forgotten

- **The rate limit is per process.** On *n* instances the effective ceiling is
  *n × limit*. This is stated in `rate-limit.ts`'s module doc, not only here.
  `RATE_LIMIT_BACKEND` is named in that comment as the intended switch.
- **Webhook retries do not survive a restart.** A delivery in backoff when the
  process dies is not resumed. The `AuditLog` row showing a failure remains,
  so the loss is visible rather than silent — but it is a loss.
- **A slow receiver can hold a request handler.** Dispatch is in-process, so an
  endpoint that takes 30 seconds to answer occupies resources that a queue
  would have decoupled. Attempt bounds and timeouts limit the damage; they do
  not eliminate it.
- **No scheduler ships with this.** `SCHEDULED` and `INCREMENTAL` connections
  enforce their interval gate correctly but something external must call the
  sync. `runSync` already takes `trigger: "scheduled"` so the caller can be
  added without changing the service.

### What this buys

Replacing either component is a contained change:

| To replace | Implement | Change |
| --- | --- | --- |
| Rate limiter | `RateLimiter` against Redis | the `rateLimiter` export |
| Webhook delivery | a worker consuming a queue | `webhook-dispatcher.ts`'s fan-out; `webhook-delivery.ts` and `webhook-signature.ts` are reused as-is |

Neither touches `api-route.ts`, the route handlers, the scope model, or any
`/api/v1` contract.

### Related

- [ADR-0004](0004-realtime-sse-in-memory-pubsub.md) made the same trade for the
  realtime transport — in-memory behind an interface, documented as
  dev-scale. This ADR is consistent with it on purpose: the project has one
  rule for infrastructure it is not yet ready to operate, and applies it the
  same way each time.
- [docs/INTEGRATIONS.md](../INTEGRATIONS.md) §3 and §4.
