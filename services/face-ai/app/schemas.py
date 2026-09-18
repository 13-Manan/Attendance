"""Pydantic schemas mirroring packages/shared-types/src/face-ai-contract.ts.

Keep the two files in sync by hand for this phase; any change to the
embedding dimension or request/response shape must be made in both places
and treated as a contract version bump (FACE_AI_CONTRACT_VERSION).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EMBEDDING_DIMENSION = 512

# Must equal FACE_AI_CONTRACT_VERSION in the TypeScript contract. A test
# asserts the two agree, so drift fails CI instead of production.
FACE_AI_CONTRACT_VERSION = "v1"

SequenceNumber = Literal[1, 2, 3]

# `model_name`/`model_version` fields below collide with Pydantic v2's
# protected `model_` namespace (reserved for model_config, model_fields,
# etc.) unless protected_namespaces is cleared; populate_by_name lets these
# schemas be constructed from Python code using the snake_case names while
# still serializing to the camelCase wire format the TS contract expects.
_CONFIG = ConfigDict(populate_by_name=True, protected_namespaces=())


def _bounded_image(value: str) -> str:
    """Rejects an oversized ``imageBase64`` before anything decodes it.

    Pydantic validates the whole body before a handler runs, so this is the
    earliest point at which a 200 MB "image" can be turned away — after that
    it is a decode, a numpy allocation, and a worker that stops answering.
    The ceiling is configuration rather than a literal because a deployment
    running a higher-resolution detector may legitimately need a larger one.

    The limit is enforced *here* and not only in apps/web because this service
    must be safe against any caller that reaches it. A bound that lives only
    in the client is a bound that disappears the moment the client is not the
    only caller — which is the same assumption that left this service
    unauthenticated.

    Imported lazily: ``app.config`` imports this module for
    ``CommercialUseStatus``, so a module-level import would be a cycle.
    """
    from app.config import get_settings

    limit = get_settings().face_ai_max_image_base64_chars
    if len(value) > limit:
        raise ValueError(
            f"imageBase64 is {len(value)} characters; the limit is {limit}."
        )
    return value


class HealthResponse(BaseModel):
    model_config = _CONFIG

    status: Literal["ok"] = "ok"
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    embedding_dim: int = Field(alias="embeddingDim")


class SessionImageInput(BaseModel):
    model_config = _CONFIG

    sequence_number: SequenceNumber = Field(alias="sequenceNumber")
    image_base64: str = Field(alias="imageBase64")

    _bound_image = field_validator("image_base64")(_bounded_image)


class DetectEmbedRequest(BaseModel):
    model_config = _CONFIG

    session_id: str = Field(alias="sessionId")
    images: list[SessionImageInput]

    @field_validator("images")
    @classmethod
    def _bound_images(cls, value: list[SessionImageInput]) -> list[SessionImageInput]:
        """Caps the batch as well as each member.

        Three bounded images and three thousand bounded images are different
        requests: the per-image limit alone lets one call ask for gigabytes of
        decoding. The classroom wizard captures at most three.
        """
        from app.config import get_settings

        limit = get_settings().face_ai_max_images_per_request
        if len(value) > limit:
            raise ValueError(f"images has {len(value)} entries; the limit is {limit}.")
        return value


class BoundingBox(BaseModel):
    """Pixel coordinates of the submitted image, origin top-left, (x, y) is
    the top-left corner. Adapters convert their model's native format (often
    x1,y1,x2,y2) into this one — nothing downstream guesses."""

    model_config = _CONFIG

    x: float
    y: float
    width: float
    height: float


class Point(BaseModel):
    model_config = _CONFIG

    x: float
    y: float


class FaceLandmarks(BaseModel):
    """Five-point landmarks in the same pixel space as BoundingBox.

    Required for the similarity-transform alignment that ArcFace-family
    recognition models expect; a bounding box alone cannot drive it."""

    model_config = _CONFIG

    left_eye: Point = Field(alias="leftEye")
    right_eye: Point = Field(alias="rightEye")
    nose_tip: Point = Field(alias="noseTip")
    mouth_left: Point = Field(alias="mouthLeft")
    mouth_right: Point = Field(alias="mouthRight")


class DetectedFaceBox(BaseModel):
    model_config = _CONFIG

    face_id: int = Field(alias="faceId")
    bounding_box: BoundingBox = Field(alias="boundingBox")
    detection_confidence: float = Field(alias="detectionConfidence")
    landmarks: FaceLandmarks | None = None


class DetectedFace(BaseModel):
    model_config = _CONFIG

    sequence_number: SequenceNumber = Field(alias="sequenceNumber")
    bounding_box: BoundingBox = Field(alias="boundingBox")
    embedding: list[float]
    detection_confidence: float = Field(alias="detectionConfidence")
    quality_score: float = Field(alias="qualityScore")
    landmarks: FaceLandmarks | None = None
    aligned: bool | None = None


class DetectEmbedResponse(BaseModel):
    model_config = _CONFIG

    faces: list[DetectedFace]
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")


# ---------------------------------------------------------------------------
# Enrollment contract (Phase 3). Mirrors the TS types in
# packages/shared-types/src/face-ai-contract.ts — every change here must ship
# with a matching TS change.
# ---------------------------------------------------------------------------

FaceQualityReason = Literal[
    "ok",
    "no_face",
    "multiple_faces",
    "face_too_small",
    "blurred",
    "too_dark",
    "occluded",
    "bad_angle",
    "low_quality",
]


MetricAvailability = Literal["measured", "unavailable"]


class FaceQualityMetric(BaseModel):
    """A backend that has not implemented a metric reports ``unavailable``
    rather than a plausible-looking number — an operator must never tune
    thresholds against a fabricated measurement."""

    model_config = _CONFIG

    status: MetricAvailability
    value: float | None = None
    unit: str | None = None

    @classmethod
    def unavailable(cls) -> "FaceQualityMetric":
        return cls(status="unavailable")

    @classmethod
    def measured(cls, value: float, unit: str) -> "FaceQualityMetric":
        return cls(status="measured", value=value, unit=unit)


class FaceQualityMetrics(BaseModel):
    model_config = _CONFIG

    blur: FaceQualityMetric
    brightness: FaceQualityMetric
    face_size: FaceQualityMetric = Field(alias="faceSize")
    pose: FaceQualityMetric
    occlusion: FaceQualityMetric

    @classmethod
    def all_unavailable(cls) -> "FaceQualityMetrics":
        return cls(
            blur=FaceQualityMetric.unavailable(),
            brightness=FaceQualityMetric.unavailable(),
            faceSize=FaceQualityMetric.unavailable(),
            pose=FaceQualityMetric.unavailable(),
            occlusion=FaceQualityMetric.unavailable(),
        )


class FaceQualityAssessment(BaseModel):
    model_config = _CONFIG

    reason: FaceQualityReason
    quality_score: float = Field(alias="qualityScore")
    face_count: int = Field(alias="faceCount")
    metrics: FaceQualityMetrics | None = None
    detail: str | None = None


class FaceImageInput(BaseModel):
    model_config = _CONFIG

    image_base64: str = Field(alias="imageBase64")

    _bound_image = field_validator("image_base64")(_bounded_image)


class QualityRequest(FaceImageInput):
    pass


class QualityResponse(BaseModel):
    model_config = _CONFIG

    assessment: FaceQualityAssessment
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")


class DetectRequest(FaceImageInput):
    pass


class DetectResponse(BaseModel):
    model_config = _CONFIG

    faces: list[DetectedFaceBox]
    face_count: int = Field(alias="faceCount")
    image_width: int = Field(alias="imageWidth")
    image_height: int = Field(alias="imageHeight")
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")


class EmbedRequest(FaceImageInput):
    bounding_box: BoundingBox | None = Field(default=None, alias="boundingBox")
    landmarks: FaceLandmarks | None = None


class EmbedResponse(BaseModel):
    model_config = _CONFIG

    embedding: list[float]
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    embedding_dim: int = Field(alias="embeddingDim")
    weights_version: str = Field(alias="weightsVersion")
    preprocessing_version: str = Field(alias="preprocessingVersion")
    aligned: bool


class EnrollRequest(FaceImageInput):
    pass


class EnrollAccepted(BaseModel):
    model_config = _CONFIG

    accepted: Literal[True] = True
    assessment: FaceQualityAssessment
    embedding: list[float]
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    embedding_dim: int = Field(alias="embeddingDim")
    weights_version: str = Field(alias="weightsVersion")
    preprocessing_version: str = Field(alias="preprocessingVersion")
    aligned: bool


class EnrollRejected(BaseModel):
    model_config = _CONFIG

    accepted: Literal[False] = False
    assessment: FaceQualityAssessment
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")


# FastAPI serializes unions transparently — the `accepted` literal is the
# discriminator on the wire, matching the TS `EnrollResponse` shape.
EnrollResponse = EnrollAccepted | EnrollRejected


class MatchCandidate(BaseModel):
    model_config = _CONFIG

    student_id: str = Field(alias="studentId")
    embedding: list[float]


MatchStatus = Literal["MATCHED", "UNCERTAIN", "UNMATCHED"]


class MatchThresholds(BaseModel):
    model_config = _CONFIG

    match_threshold: float = Field(alias="matchThreshold")
    review_threshold: float = Field(alias="reviewThreshold")


# Conservative fallback, used only when the caller sends no thresholds. Real
# values are product policy and come from Institution.settings in apps/web.
DEFAULT_MATCH_THRESHOLDS = MatchThresholds(matchThreshold=0.62, reviewThreshold=0.45)


class MatchRequest(FaceImageInput):
    candidates: list[MatchCandidate]
    thresholds: MatchThresholds | None = None

    @field_validator("candidates")
    @classmethod
    def _bound_candidates(cls, value: list["MatchCandidate"]) -> list["MatchCandidate"]:
        """Caps the candidate pool.

        Scoring is linear in the pool size and each candidate carries 512
        floats, so an unbounded list is both a large body and a long CPU
        burn from a single request. The ceiling is generous next to a real
        class — the narrowest pool is always the most accurate one anyway
        (see `/v1/match`'s docstring and recognition-results/repository.ts).
        """
        from app.config import get_settings

        limit = get_settings().face_ai_max_match_candidates
        if len(value) > limit:
            raise ValueError(
                f"candidates has {len(value)} entries; the limit is {limit}."
            )
        return value


class MatchScore(BaseModel):
    model_config = _CONFIG

    student_id: str = Field(alias="studentId")
    similarity: float
    status: MatchStatus


class MatchResponse(BaseModel):
    model_config = _CONFIG

    best_match: MatchScore | None = Field(default=None, alias="bestMatch")
    status: MatchStatus
    scores: list[MatchScore]
    thresholds_used: MatchThresholds = Field(alias="thresholdsUsed")
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    skipped_incompatible_candidates: int = Field(
        default=0, alias="skippedIncompatibleCandidates"
    )


# ---------------------------------------------------------------------------
# Model identity / provenance
# ---------------------------------------------------------------------------

CommercialUseStatus = Literal["permitted", "research-only", "unclear", "not-applicable"]


class FaceModelInfo(BaseModel):
    model_config = _CONFIG

    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    weights_version: str = Field(alias="weightsVersion")
    preprocessing_version: str = Field(alias="preprocessingVersion")
    embedding_dim: int = Field(alias="embeddingDim")
    embedding_normalized: bool = Field(alias="embeddingNormalized")
    runtime: str
    commercial_use: CommercialUseStatus = Field(alias="commercialUse")
    production_eligible: bool = Field(alias="productionEligible")
    contract_version: str = Field(alias="contractVersion")


# `/v1/model-info` returns FaceModelInfo directly — no wrapper object, so the
# response body is the provenance record itself.
ModelInfoResponse = FaceModelInfo
