import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { env } from "@/lib/env";
import type { LocalAiProbeResult } from "@/modules/offline-sync/types";

/**
 * "Is there a local AI node, and is it actually answering?"
 *
 * ## Why the browser asks the app server instead of the AI service directly
 *
 * Because it must. `FACE_AI_SERVICE_URL` is a server-side variable and the
 * face service is reached server-to-server only — a browser that could call it
 * would be a browser that could post classroom photos to an unauthenticated
 * inference endpoint. That constraint does not change because the network is
 * down (see ARCHITECTURE.md).
 *
 * This does not weaken the offline story, because of what "local AI" means in
 * a deployment that has it: the institution is running the *whole stack* —
 * this app server and the face service — on its own machine or network. When
 * the school's internet goes down, the classroom tablet can still reach both,
 * because neither is across the internet. That is the deployment the brief
 * describes, and probing through the app server tests exactly the path
 * recognition would take.
 *
 * On a cloud deployment the opposite is true and this endpoint is unreachable
 * when the internet is — which is the correct answer, reported honestly: the
 * client's probe fails, local AI reads `UNAVAILABLE`, and the register is
 * taken by hand.
 *
 * ## What it refuses to claim
 *
 * `AVAILABLE` requires three things, all verified rather than assumed:
 * `LOCAL_AI_ENABLED` set by whoever deployed this, a live answer from
 * `/v1/health`, and a model name in that answer. A stub backend that reports
 * itself as not production-eligible is reported as unavailable, because a
 * teacher told "AI is ready" by a placeholder model would confirm a register
 * that nothing actually recognized.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Short, and shorter than the sync timeout on purpose. This probe runs on a
 * screen the teacher is waiting on; if a local node has not answered in two
 * seconds it is not a local node worth waiting for, and manual marking is
 * always available underneath.
 */
const PROBE_TIMEOUT_MS = 2_000;

export async function GET() {
  // Authenticated: the reply names the recognition model and its version,
  // which is deployment information and not something to serve to the open
  // internet. It is not permission-gated beyond that — any signed-in user who
  // can take a register needs to know whether AI will help them.
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const checkedAt = new Date().toISOString();

  if (!env.LOCAL_AI_ENABLED) {
    return json({
      status: "UNCONFIGURED",
      modelName: null,
      modelVersion: null,
      latencyMs: null,
      checkedAt,
      error: null,
    });
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(new URL("/v1/health", env.FACE_AI_SERVICE_URL), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return json({
        status: "UNAVAILABLE",
        modelName: null,
        modelVersion: null,
        latencyMs,
        checkedAt,
        error: `http_${response.status}`,
      });
    }

    // `modelName`/`modelVersion`, not `model_name`/`model_version`: the
    // service's Pydantic schemas carry camelCase aliases and FastAPI
    // serializes by alias, so the snake_case keys this once read were never
    // on the wire — which made a healthy node report `no_model` forever.
    // services/face-ai/tests/test_routes.py asserts the camelCase shape.
    const body = (await response.json()) as {
      modelName?: unknown;
      modelVersion?: unknown;
    };
    const modelName = typeof body.modelName === "string" ? body.modelName : null;
    const modelVersion = typeof body.modelVersion === "string" ? body.modelVersion : null;

    if (!modelName) {
      // Answered, but with nothing that can recognize a face. Reported as
      // unavailable rather than available-with-caveats: there is no useful
      // difference to the teacher between "no node" and "a node with no
      // model", and collapsing them keeps the UI from implying capability.
      return json({
        status: "UNAVAILABLE",
        modelName: null,
        modelVersion,
        latencyMs,
        checkedAt,
        error: "no_model",
      });
    }

    return json({
      status: "AVAILABLE",
      modelName,
      modelVersion,
      latencyMs,
      checkedAt,
      error: null,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return json({
      status: "UNAVAILABLE",
      modelName: null,
      modelVersion: null,
      latencyMs: Date.now() - startedAt,
      checkedAt,
      error: timedOut ? "timeout" : "unreachable",
    });
  }
}

function json(result: LocalAiProbeResult): Response {
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
