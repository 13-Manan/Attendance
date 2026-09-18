# ADR-0004: Realtime via SSE + in-memory pub/sub (dev-scale)

## Status

Accepted (foundation phase). Explicitly not production-scale — see
Consequences.

## Context

Student and teacher portals need instant attendance updates. App Router
Route Handlers cannot upgrade a raw WebSocket connection without a custom
server; adding Socket.io/ws would be a new dependency for a feature whose
real publish-side wiring is deferred anyway this phase.

## Decision

Use Server-Sent Events (native `ReadableStream` in a Route Handler) for the
realtime transport, backed by an `AttendanceEventPublisher` interface
(`modules/realtime/publisher.ts`) whose only implementation this phase is an
in-memory `EventEmitter`.

## Rationale

- SSE needs zero new dependencies and is one-directional (server→client),
  which is exactly what attendance-update push needs — no client-to-server
  realtime channel is required.
- It works over plain HTTP, which plays well with the PWA/offline direction
  (`EventSource`'s built-in reconnect semantics).
- The publisher is defined behind an interface specifically so the
  in-memory implementation can be swapped without touching the Route
  Handler or any caller.

## Consequences

- **Single-instance only.** An event published on one Next.js server
  process will not reach a client connected to a different process/instance.
  This is fine for local dev and a single-instance deployment, but is a
  correctness bug the moment the app runs behind more than one instance.
- **Upgrade path**: replace `InMemoryAttendanceEventPublisher` with a
  Postgres `LISTEN/NOTIFY`-backed or Redis-backed implementation of the same
  `AttendanceEventPublisher` interface before scaling beyond one instance.
  Tracked as a known limitation, not solved in this phase.
- Nothing publishes a real event yet — `correctAttendanceRecord` does not
  call `publisher.publish(...)`. This phase only proves the transport
  (heartbeat) and the subscribe/unsubscribe plumbing.
