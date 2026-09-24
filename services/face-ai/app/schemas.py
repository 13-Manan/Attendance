"""Pydantic schemas mirroring packages/shared-types/src/face-ai-contract.ts.

Keep the two files in sync by hand for this phase; any change to the
embedding dimension or request/response shape must be made in both places
and treated as a contract version bump (FACE_AI_CONTRACT_VERSION).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Length of every face template. 128 is SFace's native output (`fc1`, shape
# [1, 128], read from the model graph during the Phase 4.5 audit), not a
# choice. Must equal EMBEDDING_DIMENSION in the TypeScript contract; a test
# asserts the two agree. Changing it invalidates every stored vector.
EMBEDDING_DIMENSION = 128

# Must equal FACE_AI_CONTRACT_VERSION in the TypeScript contract. A test
# asserts the two agree, so drift fails CI instead of production.
FACE_AI_CONTRACT_VERSION = "v1"

SequenceNumber = Literal[1, 2, 3]

# Product-level quality vocabulary, shared by enrolment and group photos.
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
    # Added with the quality module: an over-exposed face (window behind the
    # student, flash at close range) loses detail just as a dark one does,
    # and "too dark" would tell somebody to do the opposite of what helps.
    "too_bright",
]

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
    #: Composite face quality in [0, 1] — the weakest of the group-profile
    #: checks in app/quality.py. Backends that measure nothing report their
    #: detector confidence here instead, and leave ``quality_flags`` empty.
    quality_score: float = Field(alias="qualityScore")
    landmarks: FaceLandmarks | None = None
    aligned: bool | None = None
    #: Every group-profile check this face failed. The face was still
    #: embedded; the caller decides what a flag means for a match (apps/web
    #: sends it to a human rather than suggesting it).
    quality_flags: list[FaceQualityReason] = Field(
        default_factory=list, alias="qualityFlags"
    )
    #: Shorter side of the face box, in pixels.
    face_size: float | None = Field(default=None, alias="faceSize")


#: Why a detected face produced no embedding.
#: ``low_quality`` is only produced by the gallery backend (Azure Face): a face
#: Azure rates ``qualityForRecognition: low`` is never sent to Identify,
#: because Microsoft documents such faces as unfit for identification.
RejectedFaceReason = Literal[
    "face_too_small", "alignment_failed", "embedding_failed", "low_quality"
]


class RejectedFace(BaseModel):
    """A face the detector found and the pipeline could not embed.

    Reported rather than dropped: "three faces were too small to identify"
    is something a teacher can act on by taking a closer photo, and a silent
    drop is indistinguishable from "that student was not there". Carries no
    embedding and no pixels — only where the face was and why it failed.
    """

    model_config = _CONFIG

    sequence_number: SequenceNumber = Field(alias="sequenceNumber")
    bounding_box: BoundingBox = Field(alias="boundingBox")
    detection_confidence: float = Field(alias="detectionConfidence")
    reason: RejectedFaceReason
    face_size: float | None = Field(default=None, alias="faceSize")


class DetectEmbedImageSummary(BaseModel):
    model_config = _CONFIG

    sequence_number: SequenceNumber = Field(alias="sequenceNumber")
    image_width: int = Field(alias="imageWidth")
    image_height: int = Field(alias="imageHeight")
    detected_faces: int = Field(alias="detectedFaces")
    embedded_faces: int = Field(alias="embeddedFaces")
    rejected_faces: int = Field(alias="rejectedFaces")


class PipelineTimingsWire(BaseModel):
    """Milliseconds per stage, summed over every image in the request."""

    model_config = _CONFIG

    decode_ms: float = Field(alias="decodeMs")
    detect_ms: float = Field(alias="detectMs")
    align_ms: float = Field(alias="alignMs")
    quality_ms: float = Field(alias="qualityMs")
    embed_ms: float = Field(alias="embedMs")
    total_ms: float = Field(alias="totalMs")


class DetectEmbedResponse(BaseModel):
    model_config = _CONFIG

    faces: list[DetectedFace]
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    #: Detected faces that produced no embedding, and why. Additive: a caller
    #: that ignores it sees exactly the old response.
    rejected_faces: list[RejectedFace] = Field(
        default_factory=list, alias="rejectedFaces"
    )
    images: list[DetectEmbedImageSummary] = Field(default_factory=list)
    timings: PipelineTimingsWire | None = None


# ---------------------------------------------------------------------------
# Enrollment contract (Phase 3). Mirrors the TS types in
# packages/shared-types/src/face-ai-contract.ts — every change here must ship
# with a matching TS change.
# ---------------------------------------------------------------------------



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
    # Finer detail, optional so a backend that measures none of it (the mock)
    # is unaffected. See app/quality.py for how each is obtained.
    yaw: FaceQualityMetric | None = None
    pitch: FaceQualityMetric | None = None
    underexposure: FaceQualityMetric | None = None
    overexposure: FaceQualityMetric | None = None
    detection_confidence: FaceQualityMetric | None = Field(
        default=None, alias="detectionConfidence"
    )
    inter_eye_distance: FaceQualityMetric | None = Field(
        default=None, alias="interEyeDistance"
    )

    @classmethod
    def all_unavailable(cls) -> "FaceQualityMetrics":
        return cls(
            blur=FaceQualityMetric.unavailable(),
            brightness=FaceQualityMetric.unavailable(),
            faceSize=FaceQualityMetric.unavailable(),
            pose=FaceQualityMetric.unavailable(),
            occlusion=FaceQualityMetric.unavailable(),
            yaw=FaceQualityMetric.unavailable(),
            pitch=FaceQualityMetric.unavailable(),
            underexposure=FaceQualityMetric.unavailable(),
            overexposure=FaceQualityMetric.unavailable(),
            detectionConfidence=FaceQualityMetric.unavailable(),
            interEyeDistance=FaceQualityMetric.unavailable(),
        )


class FaceQualityAssessment(BaseModel):
    model_config = _CONFIG

    #: The single most actionable failure, or "ok". Kept as the headline so
    #: existing callers are unaffected.
    reason: FaceQualityReason
    quality_score: float = Field(alias="qualityScore")
    face_count: int = Field(alias="faceCount")
    metrics: FaceQualityMetrics | None = None
    detail: str | None = None
    #: Every failed check, most actionable first. ``reasons[0] == reason``
    #: whenever the list is non-empty; empty means ``ok``.
    reasons: list[FaceQualityReason] = Field(default_factory=list)


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

        Scoring is linear in the pool size and each candidate carries 128
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


class PipelineStageInfo(BaseModel):
    """One stage of the running pipeline — see app/models/pipeline.py."""

    model_config = _CONFIG

    role: Literal["detector", "aligner", "embedder", "matcher"]
    name: str
    version: str
    runtime: str
    commercial_use: CommercialUseStatus = Field(alias="commercialUse")
    production_ready: bool = Field(alias="productionReady")
    capabilities: list[str] = Field(default_factory=list)
    required_assets: list[str] = Field(default_factory=list, alias="requiredAssets")
    embedding_dim: int | None = Field(default=None, alias="embeddingDim")
    licence_note: str | None = Field(default=None, alias="licenceNote")


#: Where a backend's templates live. ``embedding``: the backend returns a
#: vector and apps/web stores and compares it (pgvector). ``gallery``: the
#: backend keeps the templates itself in a managed store (Azure Face
#: LargePersonGroups) and answers Identify. It never returns a vector.
TemplateKind = Literal["embedding", "gallery"]

#: Whether the backend can identify people right now. ``not_applicable`` for
#: embedding backends, whose identification is apps/web's own comparison.
IdentificationStatus = Literal[
    "enabled", "not_approved", "unavailable", "not_applicable"
]


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
    #: Per-stage identity and licensing. The provider is production-eligible
    #: only if every stage is.
    stages: list[PipelineStageInfo] = Field(default_factory=list)
    template_kind: TemplateKind = Field(default="embedding", alias="templateKind")
    identification: IdentificationStatus = "not_applicable"


# `/v1/model-info` returns FaceModelInfo directly — no wrapper object, so the
# response body is the provenance record itself.
ModelInfoResponse = FaceModelInfo


# ---------------------------------------------------------------------------
# Gallery contract (template_kind == "gallery"). Mirrors the TS types in
# packages/shared-types/src/face-ai-contract.ts.
#
# The caller (apps/web) decides which gallery a request touches: one gallery
# per class, so an Identify can only ever return people enrolled in that
# class. This service still holds no database and no mapping from a person to
# a student. The person name it writes to Azure is an opaque id the caller
# supplies, never a human name.
# ---------------------------------------------------------------------------

_GALLERY_ID_PATTERN = r"^[a-z0-9_-]{1,64}$"
_OPAQUE_ID_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"


class GalleryTarget(BaseModel):
    model_config = _CONFIG

    gallery_id: str = Field(alias="galleryId", pattern=_GALLERY_ID_PATTERN)
    #: The student's existing person in this gallery, or null to create one.
    person_id: str | None = Field(
        default=None, alias="personId", pattern=_OPAQUE_ID_PATTERN
    )
    #: Opaque label stored as the Azure person name. Must not be a real name.
    person_name: str = Field(alias="personName", pattern=_OPAQUE_ID_PATTERN)


class GalleryEnrollRequest(FaceImageInput):
    targets: list[GalleryTarget] = Field(min_length=1, max_length=20)
    #: Refuse when another person in a target gallery matches at or above this.
    other_person_min_confidence: float = Field(
        default=0.7, ge=0.0, le=1.0, alias="otherPersonMinConfidence"
    )
    #: Refuse when the student's own existing person verifies below this.
    own_person_min_confidence: float = Field(
        default=0.5, ge=0.0, le=1.0, alias="ownPersonMinConfidence"
    )


class GalleryPlacement(BaseModel):
    model_config = _CONFIG

    gallery_id: str = Field(alias="galleryId")
    person_id: str = Field(alias="personId")
    persisted_face_id: str = Field(alias="persistedFaceId")
    person_created: bool = Field(alias="personCreated")


class GalleryCollision(BaseModel):
    model_config = _CONFIG

    gallery_id: str = Field(alias="galleryId")
    person_id: str = Field(alias="personId")
    confidence: float


GalleryEnrollOutcomeKind = Literal["accepted", "rejected", "collision", "own_mismatch"]


class GalleryEnrollResponse(BaseModel):
    model_config = _CONFIG

    outcome: GalleryEnrollOutcomeKind
    assessment: FaceQualityAssessment
    placements: list[GalleryPlacement] = Field(default_factory=list)
    collision: GalleryCollision | None = None
    own_confidence: float | None = Field(default=None, alias="ownConfidence")
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")


class GalleryRemoval(BaseModel):
    model_config = _CONFIG

    gallery_id: str = Field(alias="galleryId", pattern=_GALLERY_ID_PATTERN)
    person_id: str = Field(alias="personId", pattern=_OPAQUE_ID_PATTERN)
    #: Null removes the whole person (every face) from the gallery.
    persisted_face_id: str | None = Field(
        default=None, alias="persistedFaceId", pattern=_OPAQUE_ID_PATTERN
    )


class GalleryRemoveRequest(BaseModel):
    model_config = _CONFIG

    removals: list[GalleryRemoval] = Field(min_length=1, max_length=100)


class GalleryRemoveResponse(BaseModel):
    model_config = _CONFIG

    removed: int


class IdentifyCandidateWire(BaseModel):
    model_config = _CONFIG

    person_id: str = Field(alias="personId")
    confidence: float


class IdentifiedFace(BaseModel):
    """A detected face and who the gallery says it might be. No vector."""

    model_config = _CONFIG

    sequence_number: SequenceNumber = Field(alias="sequenceNumber")
    bounding_box: BoundingBox = Field(alias="boundingBox")
    detection_confidence: float = Field(alias="detectionConfidence")
    quality_score: float = Field(alias="qualityScore")
    quality_flags: list[FaceQualityReason] = Field(
        default_factory=list, alias="qualityFlags"
    )
    face_size: float | None = Field(default=None, alias="faceSize")
    landmarks: FaceLandmarks | None = None
    #: Highest confidence first. Empty when nobody reached the threshold, or
    #: when identification is not available (see ``identification``).
    candidates: list[IdentifyCandidateWire] = Field(default_factory=list)


class IdentifyRequest(DetectEmbedRequest):
    gallery_id: str = Field(alias="galleryId", pattern=_GALLERY_ID_PATTERN)
    max_candidates: int = Field(default=5, ge=1, le=10, alias="maxCandidates")
    confidence_threshold: float = Field(
        default=0.5, ge=0.0, le=1.0, alias="confidenceThreshold"
    )


class IdentifyResponse(BaseModel):
    model_config = _CONFIG

    faces: list[IdentifiedFace]
    rejected_faces: list[RejectedFace] = Field(
        default_factory=list, alias="rejectedFaces"
    )
    images: list[DetectEmbedImageSummary] = Field(default_factory=list)
    #: ``enabled``: every face was identified against the gallery.
    #: ``not_approved``: detection only. Faces are real, candidates are
    #: always empty, and nobody may be marked from this response.
    identification: IdentificationStatus
    #: False when the gallery does not exist yet (nobody enrolled in this
    #: class under this backend). Every candidate list is then empty.
    gallery_ready: bool = Field(alias="galleryReady")
    #: Identify requests sent to Azure. At most 10 faces each.
    identify_batches: int = Field(default=0, alias="identifyBatches")
    model_name: str = Field(alias="modelName")
    model_version: str = Field(alias="modelVersion")
    timings: PipelineTimingsWire | None = None
