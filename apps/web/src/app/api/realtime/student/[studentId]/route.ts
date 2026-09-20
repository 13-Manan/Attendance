import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getStudentByUserId } from "@/modules/attendance-review/repository";
import { attendanceEventPublisher } from "@/modules/realtime/publisher";
import type { StudentAttendanceUpdatedEvent } from "@/modules/realtime/types";

/**
 * One student's own attendance channel.
 *
 * The narrow half of the two-channel split (see modules/realtime/types.ts):
 * events here carry a single student's own result and nothing about the rest
 * of the class. Access is "you are this student", resolved from the server
 * session — a `studentId` in the URL is never taken as a claim of identity,
 * so guessing another student's id gets a 403, not their attendance.
 *
 * Staff do not use this route; a faculty member watching a class subscribes
 * to /api/realtime/attendance/[sessionId] instead.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(user, "attendanceRecord.read.own")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const student = await getStudentByUserId(user.userId);
  if (!student || student.id !== studentId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: StudentAttendanceUpdatedEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      controller.enqueue(encoder.encode(": connected\n\n"));
      unsubscribe = attendanceEventPublisher.subscribeToStudent(studentId, send);

      // A *named* event rather than the `: heartbeat` comment this used to
      // send. Comments are discarded by the EventSource parser, so the client
      // had no way to observe them — and measured on this build, a browser
      // holding a stream whose server has been killed reports `readyState:
      // OPEN` with no error for tens of seconds, because nothing obliges it to
      // notice a socket that has simply gone quiet. A signal the client can
      // actually see is what lets it time the connection out and reconnect.
      //
      // `onmessage` does not fire for named events, so every existing consumer
      // is unaffected and no domain event contract changes.
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
      }, HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        controller.close();
      });
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
