import { EventEmitter } from "node:events";
import { env } from "@/lib/env";
import { PostgresAttendanceEventPublisher } from "./publisher-postgres";
import type {
  AttendanceEventPublisher,
  AttendanceRealtimeEvent,
  StudentAttendanceUpdatedEvent,
} from "./types";

/**
 * In-memory, single-instance pub/sub (ADR-0004).
 *
 * Correct only when exactly one process is running: an event published on
 * instance A never reaches a client connected to instance B. Phase 15 took
 * the upgrade path that ADR named — see `publisher-postgres.ts`, which carries
 * events over `LISTEN`/`NOTIFY` behind this same interface and is now the
 * default. This implementation is kept for `REALTIME_BACKEND=memory`: a single
 * dev process, and the unit tests, which have no reason to open a second
 * database connection to talk to themselves.
 */
const sessionChannel = (sessionId: string) => `session:${sessionId}`;
const studentChannel = (studentId: string) => `student:${studentId}`;

export class InMemoryAttendanceEventPublisher implements AttendanceEventPublisher {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(event: AttendanceRealtimeEvent): void {
    this.emitter.emit(sessionChannel(event.sessionId), event);
  }

  publishToStudent(studentId: string, event: StudentAttendanceUpdatedEvent): void {
    this.emitter.emit(studentChannel(studentId), event);
  }

  subscribe(sessionId: string, listener: (event: AttendanceRealtimeEvent) => void): () => void {
    const channel = sessionChannel(sessionId);
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  subscribeToStudent(
    studentId: string,
    listener: (event: StudentAttendanceUpdatedEvent) => void,
  ): () => void {
    const channel = studentChannel(studentId);
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}

/**
 * The transport this process uses.
 *
 * A module singleton: the listener socket and the local subscriber table only
 * mean anything if every SSE connection in the process shares them.
 *
 * `DATABASE_URL` is reused deliberately — the transport needs no credential of
 * its own, so there is no new secret to provision, rotate, or accidentally
 * expose. Nothing here is `NEXT_PUBLIC_`, and no part of it is reachable from
 * the browser: clients speak to `/api/realtime/**`, which authorizes them and
 * then subscribes on their behalf.
 */
export const attendanceEventPublisher: AttendanceEventPublisher =
  env.REALTIME_BACKEND === "memory"
    ? new InMemoryAttendanceEventPublisher()
    : new PostgresAttendanceEventPublisher(env.DATABASE_URL);
