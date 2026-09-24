/**
 * Stable contract between apps/web and services/face-ai (internal REST API).
 * Mirrors the Pydantic schemas in services/face-ai/app/schemas.py.
 * Any embedding model swap must keep this shape (fixed 128-d vectors) or bump
 * FACE_AI_CONTRACT_VERSION and update both sides together.
 */

export const FACE_AI_CONTRACT_VERSION = "v1" as const;

/**
 * Length of every face template, everywhere.
 *
 * 128 because that is what SFace emits: `face_recognition_sface_2021dec.onnx`
 * has output `fc1` of shape [1, 128], verified against the model graph itself
 * in the Phase 4.5 audit.
 *
 * It was 512 until Phase 5, which was never a measurement — it was the
 * placeholder the scaffold was written around while no model had been chosen.
 * Padding or randomly projecting 128 up to 512 was rejected: it adds no
 * information, costs four times the storage and four times the arithmetic on
 * every comparison, and leaves a number in the schema that describes nothing.
 *
 * Changing this invalidates every stored vector. It is a migration, not a
 * setting — see the note on `FaceEmbedding.embedding` in schema.prisma.
 */
export const EMBEDDING_DIMENSION = 128 as const;

export interface FaceAiHealthResponse {
  status: "ok";
  modelName: string;
  modelVersion: string;
  embeddingDim: number;
}

// ---------------------------------------------------------------------------
// Model identity / provenance
//
// Every AI result must be traceable to the exact pipeline that produced it.
// "Which model produced this attendance recognition result?" has to be
// answerable years later, from a stored row, without keeping the image.
//
// `modelVersion` is the single provenance string persisted on each stored
// template (FaceEmbedding.modelVersion). It is COMPOSITE by convention:
//
//     <weightsVersion>+pp<preprocessingVersion>
//
// because preprocessing silently invalidates embeddings just as thoroughly as
// a weights change does. Crop template, output resolution, channel order and
// mean/std normalisation are all part of "the model" from the point of view of
// vector comparability: two vectors produced by identical weights but
// different preprocessing are NOT comparable. Composing both into the string
// that is already stored keeps full provenance without a schema change.
// `weightsVersion` and `preprocessingVersion` are also carried separately so
// callers never have to parse the composite.
// ---------------------------------------------------------------------------

/** Whether a backend's model weights are cleared for commercial production
 * use. This travels on the wire so a deployment can be *checked*, not just
 * documented — see services/face-ai/app/models/LICENSING.md. */
export type CommercialUseStatus =
  /** Weights license verified as permitting commercial use. */
  | "permitted"
  /** Weights are explicitly research/non-commercial only. Never production. */
  | "research-only"
  /** License not yet verified. Treat exactly like research-only. */
  | "unclear"
  /** No weights involved at all (the mock backend). Never production. */
  | "not-applicable";

export interface FaceModelInfo {
  /** Backend/model family identifier, e.g. "mock", "arcface-r100". */
  modelName: string;
  /** Composite provenance string — see the block comment above. This is the
   * value persisted alongside every embedding. */
  modelVersion: string;
  /** Structured component: the weights release/tag/commit. */
  weightsVersion: string;
  /** Structured component: bumped whenever decode, crop, alignment template,
   * resize, channel order or normalisation changes. */
  preprocessingVersion: string;
  embeddingDim: number;
  /** True when embeddings are L2-normalised (unit length), which makes cosine
   * similarity equal to the dot product and makes similarity scores directly
   * comparable across backends. The contract REQUIRES this to be true. */
  embeddingNormalized: boolean;
  /** Inference runtime actually in use, e.g.
   * "onnxruntime-1.19/CPUExecutionProvider". Diagnostic/observability only —
   * business logic must never branch on this string. */
  runtime: string;
  /** Licensing posture of the loaded weights. */
  commercialUse: CommercialUseStatus;
  /** Convenience flag: true only when `commercialUse === "permitted"`. A
   * deployment gate, not a capability flag. */
  productionEligible: boolean;
  /** Contract version this service implements; must equal
   * FACE_AI_CONTRACT_VERSION on the caller's side. */
  contractVersion: string;
  /** Per-stage identity and licensing. The provider is production-eligible
   * only if every stage is. Absent from an older service. */
  stages?: PipelineStageInfo[];
  /** Where templates live. "embedding": apps/web stores the vector and
   * compares it. "gallery": the provider (Azure Face) holds the templates and
   * apps/web stores only the ids pointing at them. Absent from an older
   * service, which means "embedding". */
  templateKind?: TemplateKind;
  /** Whether a gallery backend can identify people right now. See
   * IdentificationStatus. Absent from an older service. */
  identification?: IdentificationStatus;
  /** Structured component: the landmark-to-template mapping. Already part of
   * `modelVersion` when set; reported separately so nobody has to parse that
   * string to know whether two templates were aligned the same way. Absent
   * from a backend that does no alignment of its own. */
  alignmentVersion?: string | null;
  /** How to read this backend's raw similarity scores. See ScoreCalibration.
   * Absent or null means the raw scale IS the product's scale. */
  calibration?: ScoreCalibration | null;
}

/**
 * The map from one backend's raw similarity onto the product's scale.
 *
 * Different recognisers put "the same person" at very different numbers. A
 * raw cosine of 0.94 is two different people for dlib's ResNet and a confident
 * match for a model trained with a margin loss. The product's thresholds
 * (present 0.62, review 0.45) are set by institutions who cannot be asked to
 * know which recogniser is deployed, so a backend whose raw scale differs
 * publishes this map and apps/web applies it to every score before any
 * threshold sees it.
 *
 * Piecewise linear between `knots`, which must span raw -1 to 1 and increase
 * strictly in both coordinates — so the mapping is monotone and order is
 * preserved. The values come from a measured evaluation, never a guess; the
 * evidence is in services/face-ai/docs/CALIBRATION.md.
 */
export interface ScoreCalibration {
  /** Identifies the measurement this map came from, e.g.
   * "dlib-resnet-v1.azure-d03.2026-09-24". Recorded with results so a
   * recalibration is visible in the audit trail. */
  id: string;
  knots: CalibrationKnot[];
  /** Minimum separation, ON THE RAW SCALE, between the top two candidates for
   * a match to count as unambiguous. A raw margin as well as the calibrated
   * one because near the top of the scale calibration compresses differences:
   * two students 0.002 raw apart are the same face to this recogniser however
   * far apart their calibrated scores land. */
  rawAmbiguityMargin: number;
}

export interface CalibrationKnot {
  /** The backend's own similarity. */
  raw: number;
  /** What it means on the product's 0..1 scale. */
  calibrated: number;
}

export type TemplateKind = "embedding" | "gallery";

/**
 * - "enabled": identification works.
 * - "not_approved": the provider refuses identification (Azure Face Limited
 *   Access not granted). Faces are still detected; nobody is identified.
 * - "unavailable": the provider could not be asked just now.
 * - "not_applicable": an embedding backend, which leaves identification to
 *   apps/web.
 */
export type IdentificationStatus = "enabled" | "not_approved" | "unavailable" | "not_applicable";

/** One stage of the running pipeline (detector, aligner, embedder, matcher).
 * Diagnostic: shown to administrators, never branched on by business logic. */
export interface PipelineStageInfo {
  role: "detector" | "aligner" | "embedder" | "matcher";
  name: string;
  version: string;
  runtime: string;
  commercialUse: CommercialUseStatus;
  productionReady: boolean;
  capabilities: string[];
  requiredAssets: string[];
  embeddingDim?: number | null;
  licenceNote?: string | null;
}

/** `GET /v1/model-info` returns the provenance record directly. */
export type ModelInfoResponse = FaceModelInfo;

export interface SessionImageInput {
  sequenceNumber: 1 | 2 | 3;
  /** Base64-encoded image bytes (no data: URL prefix). */
  imageBase64: string;
}

export interface DetectEmbedRequest {
  sessionId: string;
  images: SessionImageInput[];
}

/**
 * Axis-aligned face box.
 *
 * COORDINATE SPACE: pixels of the submitted image, origin at top-left, x to
 * the right and y downward. `x`/`y` are the top-left corner. This was
 * previously undeclared; detectors natively emit pixel `x1,y1,x2,y2`, so
 * leaving the space ambiguous is how normalised-vs-pixel bugs get shipped.
 * A provider adapter converts into this space; nothing downstream guesses.
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Five-point facial landmarks, same coordinate space as BoundingBox.
 *
 * These exist because face alignment is not optional for ArcFace-family
 * recognition: the canonical pipeline warps the face onto a fixed template
 * via a similarity transform estimated from exactly these five points before
 * embedding. A box alone cannot drive that transform. Carrying landmarks on
 * the detect response is what lets `/v1/detect` -> `/v1/embed` run as two
 * calls without the embed step having to re-detect the face.
 */
export interface FaceLandmarks {
  leftEye: Point;
  rightEye: Point;
  noseTip: Point;
  mouthLeft: Point;
  mouthRight: Point;
}

export interface DetectedFaceBox {
  /** Stable identifier of this face WITHIN this image/response only. Never a
   * person identifier — detection knows nothing about identity. */
  faceId: number;
  boundingBox: BoundingBox;
  /** Detector score in [0,1]. */
  detectionConfidence: number;
  /** Absent when the backend's detector does not produce landmarks, in which
   * case that backend cannot align and must say so in its model info. */
  landmarks?: FaceLandmarks;
}

export interface DetectedFace {
  sequenceNumber: 1 | 2 | 3;
  boundingBox: BoundingBox;
  /** Fixed-length embedding vector, length === EMBEDDING_DIMENSION. */
  embedding: number[];
  detectionConfidence: number;
  qualityScore: number;
  /** Optional 5-point landmarks for this face, in the same pixel space as
   * `boundingBox`. Present when the backend's detector supplies them. */
  landmarks?: FaceLandmarks;
  /** Whether this embedding was produced from an aligned crop. */
  aligned?: boolean;
  /** Every group-photo quality check this face failed. The face was still
   * embedded; a flagged face is only ever sent to review, never suggested
   * present. Empty (or absent, from an older service) means none failed —
   * or that the backend measures nothing, in which case `qualityScore` is
   * the detector confidence. */
  qualityFlags?: FaceQualityReason[];
  /** Shorter side of the face box, in pixels. */
  faceSize?: number | null;
}

/** Why a detected face produced no embedding. ``low_quality`` comes only from
 * the gallery backend: a face Azure rates unfit for recognition is never sent
 * to Identify. */
export type RejectedFaceReason =
  | "face_too_small"
  | "alignment_failed"
  | "embedding_failed"
  | "low_quality";

/**
 * A face the detector found and the pipeline could not embed.
 *
 * Reported rather than dropped: "three faces were too small to identify" is
 * something a teacher can act on by taking a closer photo, and a silent drop
 * is indistinguishable from "that student was not there". Carries no
 * embedding and no pixels.
 */
export interface RejectedFace {
  sequenceNumber: 1 | 2 | 3;
  boundingBox: BoundingBox;
  detectionConfidence: number;
  reason: RejectedFaceReason;
  faceSize?: number | null;
}

export interface DetectEmbedImageSummary {
  sequenceNumber: 1 | 2 | 3;
  imageWidth: number;
  imageHeight: number;
  detectedFaces: number;
  embeddedFaces: number;
  rejectedFaces: number;
}

/** Milliseconds per pipeline stage, summed over every image in the request. */
export interface PipelineTimings {
  decodeMs: number;
  detectMs: number;
  alignMs: number;
  qualityMs: number;
  embedMs: number;
  totalMs: number;
}

export interface DetectEmbedResponse {
  faces: DetectedFace[];
  modelName: string;
  modelVersion: string;
  /** Additive fields: absent from an older service, which the caller must
   * read as "nothing rejected" rather than fail on. */
  rejectedFaces?: RejectedFace[];
  images?: DetectEmbedImageSummary[];
  timings?: PipelineTimings | null;
}

// ---------------------------------------------------------------------------
// Enrollment contract (Phase 3)
//
// Two design constraints frame the shape below:
//
//   1) Provider agnostic. Nothing about the wire format encodes InsightFace,
//      Facenet, or any specific network. The Python side is free to swap
//      backends — the contract only asserts fixed-length embeddings and a
//      shared quality-reason vocabulary.
//   2) Quality is authoritative. Callers (apps/web) do NOT re-run a quality
//      check on the returned embedding — if `accepted` is false the caller
//      must not persist. This keeps the "no silent bad data" invariant
//      documented in Phase 3's quality gate list expressible in one place.
// ---------------------------------------------------------------------------

/** Product-level quality/rejection reasons. Any real model must map its own
 * failure modes onto one of these — a caller must never receive a model-
 * specific error string. */
export type FaceQualityReason =
  | "ok"
  | "no_face"
  | "multiple_faces"
  | "face_too_small"
  | "blurred"
  | "too_dark"
  | "occluded"
  | "bad_angle"
  | "low_quality"
  /** An over-exposed face (window behind the subject, flash at close range).
   * Distinct from `too_dark` because the advice is the opposite. */
  | "too_bright";

/**
 * Availability of an individual quality metric.
 *
 * A backend that does not implement a metric reports "unavailable" rather
 * than emitting a plausible-looking number. Fabricated metrics are worse
 * than missing ones: an operator tuning thresholds against invented values
 * will tune against noise, and a reviewer reading a rejection reason will
 * trust a measurement that was never taken.
 */
export type MetricAvailability = "measured" | "unavailable";

export interface FaceQualityMetric {
  status: MetricAvailability;
  /** Present if and only if `status === "measured"`. */
  value?: number;
  /** Unit/scale of `value`, e.g. "variance-of-laplacian", "mean-luma-0-255",
   * "face-height-px", "degrees". Required when measured so a score is never
   * interpreted against the wrong scale. */
  unit?: string;
}

/** Per-metric detail behind a FaceQualityAssessment. Every field is always
 * present as an object; it is the `status` inside that says whether the
 * backend actually measured it. */
export interface FaceQualityMetrics {
  blur: FaceQualityMetric;
  brightness: FaceQualityMetric;
  faceSize: FaceQualityMetric;
  /** Head pose deviation from frontal. */
  pose: FaceQualityMetric;
  occlusion: FaceQualityMetric;
  /** Finer detail; optional because a backend that measures none of it (the
   * mock) omits it. */
  yaw?: FaceQualityMetric | null;
  pitch?: FaceQualityMetric | null;
  underexposure?: FaceQualityMetric | null;
  overexposure?: FaceQualityMetric | null;
  detectionConfidence?: FaceQualityMetric | null;
  interEyeDistance?: FaceQualityMetric | null;
}

export interface FaceQualityAssessment {
  reason: FaceQualityReason;
  qualityScore: number;
  faceCount: number;
  /** Per-metric breakdown. Optional so existing callers are unaffected;
   * backends should populate it, marking unimplemented metrics as
   * "unavailable". */
  metrics?: FaceQualityMetrics;
  /** Optional model-provided human-readable detail; NEVER show to end users
   * verbatim if the model backend is not audited — treat as debug-only. */
  detail?: string | null;
  /** Every failed check, most actionable first. `reasons[0] === reason`
   * whenever non-empty; empty means `ok`. */
  reasons?: FaceQualityReason[];
}

export interface FaceImageInput {
  /** Base64-encoded image bytes (no data: URL prefix). */
  imageBase64: string;
}

export interface QualityRequest extends FaceImageInput {}

export interface QualityResponse {
  assessment: FaceQualityAssessment;
  modelName: string;
  modelVersion: string;
}

export interface DetectRequest extends FaceImageInput {}

export interface DetectResponse {
  /** One entry per detected face, richest-first ordering not guaranteed. */
  faces: DetectedFaceBox[];
  faceCount: number;
  /** Dimensions of the submitted image, so a caller can interpret the pixel
   * coordinates above without decoding the image itself. */
  imageWidth: number;
  imageHeight: number;
  modelName: string;
  modelVersion: string;
}

export interface EmbedRequest extends FaceImageInput {
  /** Optional pre-computed bounding box (client crops around a detected face
   * before requesting an embedding). Omit to let the service detect first. */
  boundingBox?: BoundingBox;
  /** Landmarks from a prior `/v1/detect` call. Supplying them lets the
   * service align without re-running detection; omitting them means the
   * service must detect again to align. */
  landmarks?: FaceLandmarks;
}

export interface EmbedResponse {
  /** Fixed-length embedding vector, length === EMBEDDING_DIMENSION, L2-
   * normalised (see FaceModelInfo.embeddingNormalized). */
  embedding: number[];
  modelName: string;
  modelVersion: string;
  embeddingDim: number;
  /** Structured provenance mirroring the composite `modelVersion`. */
  weightsVersion: string;
  preprocessingVersion: string;
  /** False when the backend could not align (no landmarks available). An
   * unaligned embedding is still returned but is materially less accurate;
   * the orchestrator may choose to treat it as low quality. */
  aligned: boolean;
}

export interface EnrollRequest extends FaceImageInput {}

export type EnrollResponse =
  | {
      accepted: true;
      assessment: FaceQualityAssessment;
      /** Fixed-length embedding vector. Only the internal orchestrator sees
       * this — apps/web must never forward it to a client or public API
       * response (Phase 3 security invariant). */
      embedding: number[];
      modelName: string;
      modelVersion: string;
      embeddingDim: number;
      weightsVersion: string;
      preprocessingVersion: string;
      aligned: boolean;
    }
  | {
      accepted: false;
      assessment: FaceQualityAssessment;
      modelName: string;
      modelVersion: string;
    };

// ---------------------------------------------------------------------------
// Matching
//
// A similarity score is not a decision. The service returns a NORMALISED
// status alongside the raw score so that no caller has to re-derive the
// meaning of a float, and so that "high score" can never be silently equated
// with "present".
//
// Thresholds are product policy and therefore owned by apps/web
// (Institution.settings.confidenceThresholds). They are sent down with each
// request and echoed back on the response, so a stored result can always be
// explained: this score, against these thresholds, produced this status.
// ---------------------------------------------------------------------------

/**
 * MATCHED   — above the accept threshold; a confident identification.
 * UNCERTAIN — plausible but below the accept threshold. MUST route to human
 *             review. Never auto-marked present.
 * UNMATCHED — below the review threshold, or no candidates were supplied.
 */
export type MatchStatus = "MATCHED" | "UNCERTAIN" | "UNMATCHED";

export interface MatchThresholds {
  /** similarity >= matchThreshold                      -> MATCHED */
  matchThreshold: number;
  /** reviewThreshold <= similarity < matchThreshold    -> UNCERTAIN */
  reviewThreshold: number;
}

/** Deliberately conservative fallback used only when a caller sends no
 * thresholds. Real values come from Institution.settings. */
export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = {
  matchThreshold: 0.62,
  reviewThreshold: 0.45,
};

export interface MatchCandidateScore {
  studentId: string;
  /** Similarity on the PRODUCT's scale, in [-1, 1] — the number the
   * thresholds are written against. Equal to `rawSimilarity` unless the
   * backend published a ScoreCalibration. */
  similarity: number;
  status: MatchStatus;
  /** The backend's own cosine similarity, before calibration. Reported so a
   * score stays explainable and a recalibration can be replayed against
   * stored results. Absent from an older service. */
  rawSimilarity?: number;
}

export interface MatchRequest extends FaceImageInput {
  /** Candidate embeddings the caller wants scored — passed by-value so the
   * face-ai service stays stateless (no DB access; see ADR-0002).
   *
   * Scoping this list to one cohort/section is the caller's job and is the
   * whole of the "class-scoped search" guarantee: the service physically
   * cannot search students it was not handed. */
  candidates: { studentId: string; embedding: number[] }[];
  /** Omit to accept DEFAULT_MATCH_THRESHOLDS. */
  thresholds?: MatchThresholds;
}

export interface MatchResponse {
  /** Highest-scoring candidate, or null when no candidate could be scored.
   * Non-null does NOT mean "matched" — always read `status`. */
  bestMatch: MatchCandidateScore | null;
  /** Status of `bestMatch`; UNMATCHED when `bestMatch` is null. */
  status: MatchStatus;
  scores: MatchCandidateScore[];
  /** The thresholds actually applied, whether supplied or defaulted. */
  thresholdsUsed: MatchThresholds;
  modelName: string;
  modelVersion: string;
  /** Candidates dropped because their embedding length did not match this
   * model's dimension — i.e. templates enrolled under a different model.
   * Silently skipping them would understate a miss as an absence. */
  skippedIncompatibleCandidates: number;
}

// ---------------------------------------------------------------------------
// Gallery contract: /v1/gallery/enroll, /v1/gallery/remove, /v1/identify.
// Only served by a backend whose model-info says templateKind "gallery"; an
// embedding backend answers 409. Mirrors app/schemas.py.
//
// No vector crosses this contract. A gallery template is a (galleryId,
// personId, persistedFaceId) triple pointing into the provider's store.
// ---------------------------------------------------------------------------

export interface GalleryTarget {
  /** 1-64 of [a-z0-9_-]. One gallery per class. */
  galleryId: string;
  /** The student's existing person in this gallery, or null to create one. */
  personId: string | null;
  /** Opaque id stored as the provider-side person name. Never a real name. */
  personName: string;
}

export interface GalleryEnrollRequest extends FaceImageInput {
  targets: GalleryTarget[];
  otherPersonMinConfidence?: number;
  ownPersonMinConfidence?: number;
}

export interface GalleryPlacement {
  galleryId: string;
  personId: string;
  persistedFaceId: string;
  personCreated: boolean;
}

export interface GalleryCollision {
  galleryId: string;
  personId: string;
  confidence: number;
}

export type GalleryEnrollOutcome = "accepted" | "rejected" | "collision" | "own_mismatch";

export interface GalleryEnrollResponse {
  outcome: GalleryEnrollOutcome;
  assessment: FaceQualityAssessment;
  placements: GalleryPlacement[];
  collision: GalleryCollision | null;
  ownConfidence: number | null;
  modelName: string;
  modelVersion: string;
}

export interface GalleryRemoval {
  galleryId: string;
  personId: string;
  /** Null removes the whole person. */
  persistedFaceId: string | null;
}

export interface GalleryRemoveRequest {
  removals: GalleryRemoval[];
}

export interface GalleryRemoveResponse {
  removed: number;
}

export interface IdentifyCandidate {
  personId: string;
  /** The provider's confidence, 0-1. NOT comparable with embedding cosine
   * similarity, so it has its own thresholds. */
  confidence: number;
}

export interface IdentifiedFace {
  sequenceNumber: 1 | 2 | 3;
  boundingBox: BoundingBox;
  detectionConfidence: number;
  qualityScore: number;
  qualityFlags: FaceQualityReason[];
  faceSize: number | null;
  landmarks: FaceLandmarks | null;
  /** Highest confidence first. Empty when nobody reached the threshold or
   * identification is not available. */
  candidates: IdentifyCandidate[];
}

export interface IdentifyRequest extends DetectEmbedRequest {
  galleryId: string;
  maxCandidates?: number;
  confidenceThreshold?: number;
}

export interface IdentifyResponse {
  faces: IdentifiedFace[];
  rejectedFaces: RejectedFace[];
  images: DetectEmbedImageSummary[];
  /** "not_approved": detection only. Faces are real, every candidate list is
   * empty, and nobody may be marked from this response. */
  identification: IdentificationStatus;
  /** False when the class has no trained gallery yet. */
  galleryReady: boolean;
  /** Identify requests sent to the provider, at most 10 faces each. */
  identifyBatches: number;
  modelName: string;
  modelVersion: string;
  timings: PipelineTimings | null;
}
