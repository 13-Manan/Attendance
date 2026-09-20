import { EventEmitter } from "node:events";
import { Client } from "pg";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  AttendanceEventPublisher,
  AttendanceRealtimeEvent,
  StudentAttendanceUpdatedEvent,
} from "./types";

/**
 * Cross-instance realtime over Postgres `LISTEN`/`NOTIFY` (Phase 15).
 *
 * ADR-0004 shipped an `EventEmitter` and recorded the consequence: "an event
 * published on one Next.js server process will not reach a client connected to
 * a different process". With `maxReplicas: 5` in the production Bicep, a
 * teacher's correction reached roughly one in five of the student portals
 * watching for it. This is the replacement the ADR names, behind the same
 * interface.
 *
 * ## One channel, not one per session
 *
 * Everything rides a single Postgres channel and is filtered in process. The
 * alternative — `LISTEN "session:<id>"` per subscriber — means issuing DDL-ish
 * statements on every SSE connect and disconnect, and Postgres channel names
 * are limited to 63 bytes. A single channel makes the listener's state
 * constant and its failure modes boring.
 *
 * The consequence is that every replica sees every event before discarding the
 * ones it has no subscriber for. That is the same property Redis pub/sub has,
 * and it is why **authorization stays in the application**: the transport is a
 * delivery mechanism, and a subscriber only ever receives the channel it asked
 * for. `api/realtime/**` decides whether it may ask. Nothing about who may
 * subscribe moved into this file.
 *
 * ## Delivery guarantee: at-most-once, unchanged
 *
 * `NOTIFY` delivers to sessions listening *at that moment* and nothing is
 * retained. That is exactly what the `EventEmitter` did, so no guarantee has
 * been strengthened or weakened, and no replay was invented. A client that is
 * disconnected during a publish does not get that event — which is safe
 * because realtime here is a nudge, not a source of truth: every screen reads
 * its state from Postgres on load, and the database remains authoritative for
 * all attendance state.
 *
 * ## Ordering
 *
 * Postgres delivers notifications to a given listener in the order they were
 * committed, so events reach one subscriber in publish order. Across two
 * publishers there is no global order and none is claimed. Nothing here
 * depends on it: each event carries the full record and the recomputed counts,
 * so a screen that applies them in any order converges on the same state, and
 * a duplicate is idempotent for the same reason — applying it twice writes the
 * same values. Realtime never writes to the database.
 */

const CHANNEL = "attendance_realtime";

/** Postgres refuses a payload over 8000 bytes; refuse earlier and say so. */
const MAX_PAYLOAD_BYTES = 7_500;

interface Envelope {
  /** `session:<id>` or `student:<id>` — the in-process fan-out key. */
  channel: string;
  event: AttendanceRealtimeEvent | StudentAttendanceUpdatedEvent;
}

const sessionChannel = (sessionId: string) => `session:${sessionId}`;
const studentChannel = (studentId: string) => `student:${studentId}`;

export class PostgresAttendanceEventPublisher implements AttendanceEventPublisher {
  readonly #emitter = new EventEmitter().setMaxListeners(0);
  readonly #connectionString: string;
  #client: Client | null = null;
  #connecting: Promise<void> | null = null;
  #closed = false;
  /** Local subscriber count. The listener connection is opened on the first
   * subscribe and kept for the process lifetime; a replica serving no SSE
   * client never opens one. */
  #subscribers = 0;

  constructor(connectionString: string) {
    this.#connectionString = connectionString;
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  /**
   * Fire-and-forget, exactly as before.
   *
   * The interface is synchronous and both callers are on the attendance write
   * path, immediately after the row has been committed. Making this block
   * would mean a slow notification could fail a correction that already
   * happened — so the promise is deliberately not returned and not awaited,
   * and a failure is logged rather than thrown. The register is already
   * correct in Postgres; the worst case is a screen that refreshes a moment
   * later instead of instantly.
   */
  publish(event: AttendanceRealtimeEvent): void {
    void this.#notify({ channel: sessionChannel(event.sessionId), event });
  }

  publishToStudent(studentId: string, event: StudentAttendanceUpdatedEvent): void {
    void this.#notify({ channel: studentChannel(studentId), event });
  }

  async #notify(envelope: Envelope): Promise<void> {
    try {
      const payload = JSON.stringify(envelope);
      if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
        console.error(
          JSON.stringify({
            log: "realtime.payload_too_large",
            channel: envelope.channel,
            bytes: Buffer.byteLength(payload, "utf8"),
          }),
        );
        return;
      }
      // Published through the ordinary pool rather than the listener
      // connection: publishing is request-scoped work and has no reason to
      // contend with the long-lived socket that receives.
      await prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${CHANNEL}, ${payload})`);
    } catch (error) {
      console.error(
        JSON.stringify({
          log: "realtime.publish_failed",
          channel: envelope.channel,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Subscribe
  // -------------------------------------------------------------------------

  subscribe(sessionId: string, listener: (event: AttendanceRealtimeEvent) => void): () => void {
    return this.#on(sessionChannel(sessionId), listener as (event: unknown) => void);
  }

  subscribeToStudent(
    studentId: string,
    listener: (event: StudentAttendanceUpdatedEvent) => void,
  ): () => void {
    return this.#on(studentChannel(studentId), listener as (event: unknown) => void);
  }

  #on(channel: string, listener: (event: unknown) => void): () => void {
    this.#emitter.on(channel, listener);
    this.#subscribers += 1;
    void this.#ensureListening();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#emitter.off(channel, listener);
      this.#subscribers -= 1;
    };
  }

  // -------------------------------------------------------------------------
  // The listener connection
  // -------------------------------------------------------------------------

  /**
   * One dedicated connection, created on demand and reused.
   *
   * It cannot come from Prisma's pool: `LISTEN` binds to a session, and a
   * pooled connection is handed to the next caller the moment the query ends.
   * `#connecting` collapses a burst of simultaneous subscribes into a single
   * connect rather than opening one socket per SSE client.
   */
  async #ensureListening(): Promise<void> {
    if (this.#closed || this.#client) return;
    if (this.#connecting) return this.#connecting;

    this.#connecting = (async () => {
      const client = new Client({ connectionString: this.#connectionString });

      client.on("notification", (message) => {
        if (message.channel !== CHANNEL || !message.payload) return;
        try {
          const envelope = JSON.parse(message.payload) as Envelope;
          // Emit only to the exact channel. A subscriber registered for
          // `student:A` cannot be reached by an envelope addressed to
          // `student:B`, which is what keeps one tenant's events away from
          // another's now that they share a transport.
          this.#emitter.emit(envelope.channel, envelope.event);
        } catch (error) {
          console.error(
            JSON.stringify({
              log: "realtime.bad_payload",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });

      // A dropped socket must not leave the replica permanently deaf. Clear
      // the handle so the next subscribe reconnects; an SSE client that is
      // still attached keeps its local listener, so it resumes receiving
      // without reconnecting itself.
      client.on("error", (error) => {
        console.error(
          JSON.stringify({
            log: "realtime.listener_error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        this.#client = null;
        if (!this.#closed && this.#subscribers > 0) {
          setTimeout(() => void this.#ensureListening(), 1_000).unref?.();
        }
      });

      await client.connect();
      await client.query(`LISTEN ${escapeIdentifier(CHANNEL)}`);

      // Do not let this socket alone hold the event loop open. A server is
      // kept alive by its HTTP listener, so unref costs nothing there; without
      // it, any process that ever subscribed — a script, a test runner — hangs
      // on exit waiting for a connection that is only ever waiting for news.
      const socket = (client as unknown as { connection?: { stream?: { unref?: () => void } } })
        .connection?.stream;
      socket?.unref?.();

      this.#client = client;
    })().catch((error) => {
      console.error(
        JSON.stringify({
          log: "realtime.listen_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      this.#client = null;
      // Retry while anything is still listening, so a replica that started
      // during a database blip recovers on its own.
      if (!this.#closed && this.#subscribers > 0) {
        setTimeout(() => void this.#ensureListening(), 1_000).unref?.();
      }
    }).finally(() => {
      this.#connecting = null;
    });

    return this.#connecting;
  }

  /** Graceful shutdown: release the socket so a rolling deploy does not leave
   * a connection parked on the database until it times out. */
  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = null;
    if (client) await client.end().catch(() => undefined);
  }

  /** Test affordance: has the listener socket been established? */
  get listening(): boolean {
    return this.#client !== null;
  }
}

/** Channel names are identifiers. This one is a constant, but quoting it keeps
 * the statement correct if it is ever made configurable. */
function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
