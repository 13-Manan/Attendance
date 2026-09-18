import type {
  DetectEmbedRequest,
  DetectEmbedResponse,
  DetectRequest,
  DetectResponse,
  EmbedRequest,
  EmbedResponse,
  EnrollRequest,
  EnrollResponse,
  FaceAiHealthResponse,
  MatchRequest,
  MatchResponse,
  ModelInfoResponse,
  QualityRequest,
  QualityResponse,
} from "@attendance/shared-types";
import { env } from "./env";

// Typed boundary around the internal Next<->Python contract (ADR-0002).
// Nothing outside this file should construct FACE_AI_SERVICE_URL requests
// directly, so the contract stays swappable in one place.

/**
 * The service credential, as request headers.
 *
 * `FACE_AI_SERVICE_TOKEN` is optional so a development checkout against a
 * service with no token keeps working unchanged; when it is set, every call
 * this file makes carries it. There is no per-call opt-out, because "which
 * face-AI calls need the credential" is not a question a caller should be able
 * to get wrong.
 *
 * The token is never logged. A 401 from the service surfaces as the same
 * `face-ai <path> failed: 401` an operator already knows how to read, and the
 * value itself stays in this module.
 */
function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return env.FACE_AI_SERVICE_TOKEN
    ? { ...extra, Authorization: `Bearer ${env.FACE_AI_SERVICE_TOKEN}` }
    : extra;
}

async function postJson<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
  const res = await fetch(`${env.FACE_AI_SERVICE_URL}${path}`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`face-ai ${path} failed: ${res.status}`);
  }
  return (await res.json()) as TRes;
}

/**
 * Which model is this deployment actually running?
 *
 * Needed to answer "which model produced this result?" for a stored
 * recognition outcome, and to check `productionEligible` before trusting a
 * deployment with real attendance. Metadata only — no vectors, no images.
 */
export async function faceModelInfo(): Promise<ModelInfoResponse> {
  const res = await fetch(`${env.FACE_AI_SERVICE_URL}/v1/model-info`, {
    headers: serviceHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`face-ai model-info failed: ${res.status}`);
  }
  return res.json() as Promise<ModelInfoResponse>;
}

export async function getFaceAiHealth(): Promise<FaceAiHealthResponse> {
  // Health is unauthenticated on the service side (liveness probes need it),
  // but the credential is sent anyway: one code path, and nothing is gained by
  // remembering which endpoint is the exception.
  const res = await fetch(`${env.FACE_AI_SERVICE_URL}/v1/health`, {
    headers: serviceHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`face-ai health check failed: ${res.status}`);
  }
  return res.json() as Promise<FaceAiHealthResponse>;
}

export function detectEmbed(request: DetectEmbedRequest): Promise<DetectEmbedResponse> {
  return postJson("/v1/detect-embed", request);
}

// -----------------------------------------------------------------------
// Phase 3 enrollment primitives. Each maps 1:1 to a face-ai endpoint and
// only exposes the fixed contract types — nothing in apps/web that calls
// these functions should ever import from the model backend or from the
// Python service directly, keeping the choice of model and model vendor
// entirely hidden behind this file.
// -----------------------------------------------------------------------

export function faceQuality(request: QualityRequest): Promise<QualityResponse> {
  return postJson("/v1/quality", request);
}

export function faceDetect(request: DetectRequest): Promise<DetectResponse> {
  return postJson("/v1/detect", request);
}

export function faceEmbed(request: EmbedRequest): Promise<EmbedResponse> {
  return postJson("/v1/embed", request);
}

export function faceEnroll(request: EnrollRequest): Promise<EnrollResponse> {
  return postJson("/v1/enroll", request);
}

export function faceMatch(request: MatchRequest): Promise<MatchResponse> {
  return postJson("/v1/match", request);
}
