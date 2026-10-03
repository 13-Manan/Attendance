import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, getCurrentUser } from "@/modules/auth-tenancy/session";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { attendanceEventPublisher } from "@/modules/realtime/publisher";
import { STREAM_REAUTHORIZE_INTERVAL_MS, mayWatchRegister } from "@/modules/realtime/stream-access";
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
 * Those checks are asked again while the stream is open (stream-access.ts):
 * a revoked permission or a switched-off account ends it within a minute
 * rather than whenever the tab is closed.
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

  // The same cookie the checks above resolved, kept to ask them again.
  const rawToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const register = { institutionId: session.institutionId, cohortId: session.cohortId };

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let ended = false;

  const stream = new ReadableStream({
    start(controller) {
      /** Once, however it ends: the tab went away, or the access did. */
      const end = () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        clearInterval(recheck);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed from the other side.
        }
      };

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

      // A check that fails ends the stream, and so does one that cannot be
      // made: the client reconnects through the full checks above either way.
      recheck = setInterval(() => {
        mayWatchRegister(rawToken, register).then(
          (allowed) => {
            if (!allowed) end();
          },
          () => end(),
        );
      }, STREAM_REAUTHORIZE_INTERVAL_MS);

      request.signal.addEventListener("abort", end);
    },
    cancel() {
      ended = true;
      clearInterval(heartbeat);
      clearInterval(recheck);
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
