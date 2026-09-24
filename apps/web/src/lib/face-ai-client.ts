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
  GalleryEnrollRequest,
  GalleryEnrollResponse,
  GalleryRemoveRequest,
  GalleryRemoveResponse,
  IdentifyRequest,
  IdentifyResponse,
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

/**
 * A non-2xx from the service. `code` is the service's stable `detail` string
 * when it sent one (for example "identification_not_approved" or
 * "azure_face_unavailable"), so a caller can branch on it. The message keeps
 * the `face-ai <path> failed: <status>` wording operators already know.
 */
export class FaceAiRequestError extends Error {
  // Plain fields, not constructor parameter properties: the test loader runs
  // this file through Node's type stripping, which cannot rewrite those.
  readonly path: string;
  readonly status: number;
  readonly code: string | null;

  constructor(path: string, status: number, code: string | null) {
    super(`face-ai ${path} failed: ${status}${code ? ` ${code}` : ""}`);
    this.name = "FaceAiRequestError";
    this.path = path;
    this.status = status;
    this.code = code;
  }
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    // Only a short machine code is kept. A validation error's detail is an
    // array and is not worth carrying.
    return typeof body.detail === "string" && /^[a-z_]{1,64}$/.test(body.detail)
      ? body.detail
      : null;
  } catch {
    return null;
  }
}

async function postJson<TReq, TRes>(path: string, body: TReq): Promise<TRes> {
  const res = await fetch(`${env.FACE_AI_SERVICE_URL}${path}`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new FaceAiRequestError(path, res.status, await errorCode(res));
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

// -----------------------------------------------------------------------
// Gallery backend (Azure AI Face). Served only when model-info reports
// templateKind "gallery". Templates stay with the provider; these calls move
// ids, never vectors. See docs/AZURE_FACE.md.
// -----------------------------------------------------------------------

export function galleryEnroll(request: GalleryEnrollRequest): Promise<GalleryEnrollResponse> {
  return postJson("/v1/gallery/enroll", request);
}

export function galleryRemove(request: GalleryRemoveRequest): Promise<GalleryRemoveResponse> {
  return postJson("/v1/gallery/remove", request);
}

export function identifyFaces(request: IdentifyRequest): Promise<IdentifyResponse> {
  return postJson("/v1/identify", request);
}
