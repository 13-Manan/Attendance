import { EventEmitter } from "node:events";
import type {
  AttendanceEventPublisher,
  AttendanceRealtimeEvent,
  StudentAttendanceUpdatedEvent,
} from "./types";

/**
 * In-memory, single-instance pub/sub (ADR-0004). Sufficient for local dev
 * and a single Next.js server process. Once deployed behind more than one
 * instance, events published on instance A won't reach a client connected to
 * instance B — upgrade to Postgres LISTEN/NOTIFY or Redis pub/sub at that
 * point, behind this same AttendanceEventPublisher interface.
 */
const sessionChannel = (sessionId: string) => `session:${sessionId}`;
const studentChannel = (studentId: string) => `student:${studentId}`;

class InMemoryAttendanceEventPublisher implements AttendanceEventPublisher {
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

export const attendanceEventPublisher: AttendanceEventPublisher =
  new InMemoryAttendanceEventPublisher();
