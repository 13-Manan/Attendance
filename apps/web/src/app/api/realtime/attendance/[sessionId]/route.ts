import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { attendanceEventPublisher } from "@/modules/realtime/publisher";
import type { AttendanceRealtimeEvent } from "@/modules/realtime/types";
import { getSessionById } from "@/modules/sessions/repository";

/**
 * Faculty review-board channel (ADR-0004 transport).
 *
 * This stream carries whole-class information — every correction and the
 * running counts — so it is authorized exactly like the review screen it
 * feeds: a live session, the caller's own institution, `attendanceRecord.read`,
 * and cohort ownership. A Route Handler answers non-browser callers too, so
 * failures are JSON status codes rather than redirects.
 *
 * Students do not subscribe here; they get their own narrowed channel at
 * /api/realtime/student/[studentId].
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(user, "attendanceRecord.read")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }
  try {
    requireSameInstitution(user, session.institutionId);
    await requireCohortAccess(user, session.cohortId);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    throw e;
  }

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: AttendanceRealtimeEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Flush headers and open the connection immediately rather than
      // waiting up to HEARTBEAT_INTERVAL_MS for the first byte — without
      // this, HTTP infrastructure between client and server has no signal
      // the stream is live until the first heartbeat.
      controller.enqueue(encoder.encode(": connected\n\n"));

      unsubscribe = attendanceEventPublisher.subscribe(sessionId, send);

      // A *named* event rather than a `: heartbeat` comment. Comments are
      // discarded by the EventSource parser, so the client could not observe
      // them — and a browser holding a stream whose server has been killed
      // reports `readyState: OPEN` with no error for tens of seconds. A signal
      // the client can see is what lets it time the connection out.
      //
      // `onmessage` does not fire for named events, so nothing that consumes
      // the attendance events is affected.
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
