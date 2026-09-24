"""The face-model swap contract (ADR-0005, ADR-0006).

Every backend — the mock, or a real ONNX model chosen after licensing review
— implements ``FaceModelProvider``. Nothing outside this package's
implementations may assume a specific model: ``config.py`` selects a backend
by name via ``FACE_MODEL_BACKEND``, and the routers only ever call this
interface.

The interface is deliberately shaped around the *stages* of a face pipeline
rather than around one convenient composite call:

    detect  ->  assess_quality  ->  align  ->  embed          (+ compare)

That shape is what a real recognition stack actually does. A detector emits
boxes and five-point landmarks; alignment warps the face onto a fixed
template using those landmarks; the recognition network embeds the aligned
crop. Collapsing these into a single ``image -> vector`` call would make the
interface look simpler while making it impossible to reuse a detection across
two embeds, impossible to show a reviewer where a face was found, and
impossible to report *why* an image was rejected.

Two rules every adapter must honour, because callers depend on them and
cannot verify them:

  1. Embeddings are L2-normalised and exactly ``embedding_dim`` long. This
     makes cosine similarity equal to the dot product and makes scores
     comparable across backends.
  2. Failures are expressed in the shared ``FaceQualityReason`` vocabulary. A
     caller must never see a provider-specific error string — that is what
     keeps apps/web free of any single vendor's concepts.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from app.models.pipeline import PipelineTimings, StageDescriptor
from app.schemas import (
    EMBEDDING_DIMENSION,
    FACE_AI_CONTRACT_VERSION,
    BoundingBox,
    CommercialUseStatus,
    DetectedFace,
    DetectedFaceBox,
    DetectEmbedImageSummary,
    FaceLandmarks,
    FaceModelInfo,
    FaceQualityAssessment,
    GalleryEnrollResponse,
    GalleryRemoval,
    GalleryTarget,
    IdentificationStatus,
    IdentifyResponse,
    RejectedFace,
    SessionImageInput,
    TemplateKind,
)


class ProviderCapabilityError(RuntimeError):
    """The running backend cannot do what the route asked.

    A gallery backend has no vector to return from ``/v1/embed``, and an
    embedding backend has no gallery to enroll into. Either way this is a 409
    naming the route to use, not a 500. The request was well-formed; it was
    sent to the wrong kind of backend.
    """


class DetectionResult:
    """Detector output plus the image dimensions needed to interpret it.

    A plain class rather than a Pydantic model: this is an internal return
    value between an adapter and a router, and it should not be confused with
    the wire schema it happens to resemble.
    """

    __slots__ = ("faces", "image_height", "image_width")

    def __init__(
        self,
        faces: list[DetectedFaceBox],
        image_width: int,
        image_height: int,
    ) -> None:
        self.faces = faces
        self.image_width = image_width
        self.image_height = image_height


class AlignedFace:
    """A face warped onto the model's canonical template, ready to embed.

    ``image_base64`` is the aligned crop. ``aligned`` is False when the
    adapter could not perform a real alignment (no landmarks available) and
    fell back to a plain box crop — the caller is told rather than being left
    to assume the crop was aligned when it was not.
    """

    __slots__ = ("aligned", "image_base64")

    def __init__(self, image_base64: str, aligned: bool) -> None:
        self.image_base64 = image_base64
        self.aligned = aligned


@dataclass
class ImageAnalysis:
    """Everything the classroom path learned about one image.

    ``faces`` is what ``detect_and_embed`` has always returned. ``rejected``
    is every detected face that produced no embedding, with a reason — so a
    face that was too small to identify is reported instead of vanishing.
    """

    faces: list[DetectedFace]
    rejected: list[RejectedFace]
    summary: DetectEmbedImageSummary
    timings: PipelineTimings = field(default_factory=PipelineTimings)


@dataclass
class EnrollmentOutcome:
    """The result of the enrolment path for one image.

    ``embedding`` is None whenever ``assessment.reason != "ok"``: a refused
    image has no vector, so a caller cannot store one by mistake.
    """

    assessment: FaceQualityAssessment
    embedding: list[float] | None
    aligned: bool


class FaceModelProvider(ABC):
    """Interface every face-recognition backend implements."""

    #: Model/family identifier, e.g. "mock", "arcface-r100".
    name: str
    #: Weights release, tag or commit. Never "latest".
    weights_version: str
    #: Bumped whenever decode, crop, alignment template, resize, channel
    #: order or normalisation changes — any of which invalidates every
    #: previously stored embedding just as surely as new weights would.
    preprocessing_version: str
    #: Fixed by the contract. A backend with a different native dimension is
    #: a contract change (EMBEDDING_DIMENSION, the pgvector column and every
    #: stored template), not something an adapter papers over by projecting.
    embedding_dim: int = EMBEDDING_DIMENSION
    #: Inference runtime actually in use, for observability only.
    runtime: str = "python"
    #: Licensing posture of the weights. Mirrors the backend log in
    #: models/LICENSING.md; config.py refuses to serve production traffic on
    #: anything that is not "permitted".
    commercial_use: CommercialUseStatus = "unclear"
    #: Where templates live. See ``TemplateKind`` in app/schemas.py.
    template_kind: TemplateKind = "embedding"

    def identification_status(self) -> IdentificationStatus:
        """Whether this backend can identify people right now. Embedding
        backends leave identification to apps/web."""
        return "not_applicable"

    # -- lifecycle ----------------------------------------------------------

    @abstractmethod
    def load(self) -> None:
        """Acquire weights/inference session. Called once during app startup.

        Startup, not first request: a missing or corrupt model artefact must
        fail the container's health check, not a student's enrolment attempt.
        """

    def unload(self) -> None:
        """Release inference resources at shutdown. Optional to override."""
        return None

    # -- identity -----------------------------------------------------------

    @property
    def version(self) -> str:
        """Composite provenance string persisted with every embedding.

        Weights and preprocessing are combined because either one changing
        makes old vectors incomparable, and only one column exists to record
        it. Parsing this apart is never necessary — the structured components
        travel on the wire as their own fields.
        """
        return f"{self.weights_version}+pp{self.preprocessing_version}"

    def stage_descriptors(self) -> tuple[StageDescriptor, ...]:
        """The stages this provider is built from. A composed provider
        overrides this; a monolithic one (the mock) reports none."""
        return ()

    @property
    def production_eligible(self) -> bool:
        """Every part must be cleared, not just the headline status."""
        return self.commercial_use == "permitted" and all(
            stage.production_ready or stage.commercial_use == "not-applicable"
            for stage in self.stage_descriptors()
        )

    def model_info(self) -> FaceModelInfo:
        """Full provenance record. Concrete on purpose: every backend must
        report provenance the same way, so this is not an adapter's choice."""
        return FaceModelInfo(
            modelName=self.name,
            modelVersion=self.version,
            weightsVersion=self.weights_version,
            preprocessingVersion=self.preprocessing_version,
            embeddingDim=self.embedding_dim,
            embeddingNormalized=True,
            runtime=self.runtime,
            commercialUse=self.commercial_use,
            productionEligible=self.production_eligible,
            contractVersion=FACE_AI_CONTRACT_VERSION,
            stages=[stage.to_info() for stage in self.stage_descriptors()],
            templateKind=self.template_kind,
            identification=self.identification_status(),
        )

    # -- pipeline stages ----------------------------------------------------

    @abstractmethod
    def detect(self, image_base64: str) -> DetectionResult:
        """Locate every face in the image. No embeddings, no identity."""

    @abstractmethod
    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        """Judge a single-subject image for enrolment suitability.

        Returns a reason from the shared vocabulary and, where the backend
        actually measures them, per-metric detail. Metrics the backend does
        not implement are reported as ``unavailable`` rather than invented.
        """

    @abstractmethod
    def align(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None,
        landmarks: FaceLandmarks | None,
    ) -> AlignedFace:
        """Warp one face onto the model's canonical input template."""

    @abstractmethod
    def embed(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None = None,
        landmarks: FaceLandmarks | None = None,
    ) -> list[float]:
        """Produce one L2-normalised embedding of length ``embedding_dim``.

        Implementations align first when landmarks are available.
        """

    @abstractmethod
    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        """Detect every face in one classroom image and embed each of them.

        The multi-face path used by ``/v1/detect-embed``. Separate from
        ``embed`` because a classroom frame has many subjects and a real
        backend should batch their crops through one inference call.
        """

    def analyze_image(self, image: SessionImageInput) -> ImageAnalysis:
        """``detect_and_embed`` plus what it could not embed, and why.

        The default reports no rejections, which is true of a backend whose
        ``detect_and_embed`` embeds everything it detects. A backend that
        drops faces must override this so the drops are visible.
        """
        faces = self.detect_and_embed(image)
        detection = self.detect(image.image_base64)
        return ImageAnalysis(
            faces=faces,
            rejected=[],
            summary=DetectEmbedImageSummary(
                sequenceNumber=image.sequence_number,
                imageWidth=detection.image_width,
                imageHeight=detection.image_height,
                detectedFaces=len(detection.faces),
                embeddedFaces=len(faces),
                rejectedFaces=0,
            ),
        )

    def enroll_image(self, image_base64: str) -> EnrollmentOutcome:
        """Quality gate, then detect, align and embed the single subject.

        The default composes the public stages, as ``/v1/enroll`` always has.
        A backend that can do it from one decode should override it.
        """
        assessment = self.assess_quality(image_base64)
        if assessment.reason != "ok":
            return EnrollmentOutcome(
                assessment=assessment, embedding=None, aligned=False
            )

        # An `ok` assessment means exactly one face, so the first is the
        # subject. A backend that disagrees with itself here (quality says one
        # face, detection finds none) degrades to an unaligned crop rather
        # than failing an enrolment somebody is standing in front of.
        detection = self.detect(image_base64)
        face = detection.faces[0] if detection.faces else None
        bounding_box = face.bounding_box if face else None
        landmarks = face.landmarks if face else None
        aligned = self.align(image_base64, bounding_box, landmarks)
        embedding = self.embed(image_base64, bounding_box, landmarks)
        return EnrollmentOutcome(
            assessment=assessment, embedding=embedding, aligned=aligned.aligned
        )

    # -- comparison ---------------------------------------------------------

    def compare_embeddings(self, a: list[float], b: list[float]) -> float:
        """Cosine similarity. Concrete and shared so that swapping a backend
        cannot change how two vectors are compared."""
        from app.matching import cosine_similarity

        return cosine_similarity(a, b)


class GalleryIdentificationProvider(ABC):
    """What a ``template_kind == "gallery"`` backend adds.

    The backend keeps templates in a store it manages (for Azure Face, one
    LargePersonGroup per class). apps/web holds the mapping from a person in a
    gallery to a student, and chooses the gallery for every call. That keeps
    each Identify scoped to one class, and it keeps this service
    database-free.
    """

    @abstractmethod
    def gallery_enroll(
        self,
        image_base64: str,
        targets: list[GalleryTarget],
        other_person_min_confidence: float,
        own_person_min_confidence: float,
    ) -> GalleryEnrollResponse:
        """Quality gate, then add the one face to every target gallery."""

    @abstractmethod
    def gallery_remove(self, removals: list[GalleryRemoval]) -> int:
        """Delete faces or whole persons. Missing ones count as removed."""

    @abstractmethod
    def identify(
        self,
        gallery_id: str,
        images: list[SessionImageInput],
        max_candidates: int,
        confidence_threshold: float,
    ) -> IdentifyResponse:
        """Detect every face in every image and identify them against one
        gallery. Without identification approval this degrades to detection
        only, and every candidate list is empty."""


# Backwards-compatible alias. The interface was called EmbeddingModel when it
# only produced embeddings; it now spans the whole pipeline. Existing imports
# keep working.
EmbeddingModel = FaceModelProvider
