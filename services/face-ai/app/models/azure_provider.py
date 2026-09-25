"""Azure AI Face as a face backend (``FACE_MODEL_BACKEND=azure``).

This is the one backend whose templates never leave the provider. Azure Face
does not return an embedding. It stores enrolled faces in LargePersonGroups
and answers Identify against them. So this backend is ``template_kind =
"gallery"``:

* ``/v1/quality`` and ``/v1/detect`` work as they do for every backend, using
  Azure Detect (detection_03) with quality attributes (recognition_04
  ``qualityForRecognition``, head pose, blur, exposure, occlusion and mask).
  Neither needs Limited Access approval.
* ``/v1/gallery/enroll``, ``/v1/gallery/remove`` and ``/v1/identify`` are the
  gallery routes. Enrolment and removal need Microsoft's Identification
  approval. Without it, ``/v1/identify`` degrades to detection only: every
  face is still found and quality-checked, and every candidate list is
  empty.
* The embedding routes (``/v1/embed``, ``/v1/enroll``, ``/v1/detect-embed``
  and ``/v1/match``) answer 409, because this backend has no vector to give
  and must never pretend otherwise.

Nothing an old mock or opencv template holds can be turned into an Azure
template. apps/web keys every template on ``modelName``/``modelVersion``, so
existing embeddings simply stop being used under this backend, and the
students show as needing re-enrolment.

The key is held by the client object only. It never reaches model-info, a
log line or an error message. No image is logged or stored here. Azure keeps
only the face features of an enrolled face, not the photograph.
"""

from __future__ import annotations

import base64
import binascii
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.azure_face import (
    IDENTIFY_BATCH_SIZE,
    AzureFaceClient,
    AzureFaceError,
    AzureFaceGalleryNotReadyError,
    AzureFaceNotApprovedError,
    AzureFaceNotFoundError,
    AzureFaceUnavailableError,
    IdentificationStatus,
    IdentifyCandidate,
    batched,
)
from app.models.base import (
    AlignedFace,
    DetectionResult,
    EnrollmentOutcome,
    FaceModelProvider,
    GalleryIdentificationProvider,
    ImageAnalysis,
    ProviderCapabilityError,
)
from app.models.opencv_provider import ImageDecodeError
from app.schemas import (
    BoundingBox,
    DetectedFace,
    DetectedFaceBox,
    DetectEmbedImageSummary,
    FaceLandmarks,
    FaceQualityAssessment,
    FaceQualityMetric,
    FaceQualityMetrics,
    FaceQualityReason,
    GalleryCollision,
    GalleryEnrollResponse,
    GalleryPlacement,
    GalleryRemoval,
    GalleryTarget,
    IdentifiedFace,
    IdentifyCandidateWire,
    IdentifyResponse,
    PipelineTimingsWire,
    Point,
    RejectedFace,
    SessionImageInput,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Quality policy over Azure's attributes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AzureQualityProfile:
    """Where each of Azure's attributes stops being acceptable.

    NOT CALIBRATED on this product's own photographs. The levels follow
    Microsoft's published guidance: enrol only faces Azure rates ``high`` for
    recognition, and identify only ``medium`` or better. The pose limits are
    engineering estimates, loose enough for the "slightly left/right" samples
    the guided enrolment asks for. See docs/AZURE_FACE.md.
    """

    name: str
    min_face_px: float
    accepted_recognition_quality: frozenset[str]
    #: Azure blur levels accepted. ``None`` when the backend measures blur
    #: itself and Azure's rating must not decide — see face_sharpness.py for
    #: why the dlib backend's enrolment does exactly that.
    accepted_blur: frozenset[str] | None
    max_abs_yaw_deg: float
    max_abs_pitch_deg: float
    max_abs_roll_deg: float


#: Enrolment refuses anything that would make a weak permanent template.
ENROLLMENT_PROFILE = AzureQualityProfile(
    name="enrollment",
    # Microsoft recommends at least 200px faces for enrolment and detects down
    # to 36px. 100 lets a phone held at arm's length through and still
    # refuses a face that is a small part of the frame.
    min_face_px=100.0,
    accepted_recognition_quality=frozenset({"high"}),
    accepted_blur=frozenset({"low"}),
    max_abs_yaw_deg=30.0,
    max_abs_pitch_deg=25.0,
    max_abs_roll_deg=30.0,
)

#: Group photos flag and do not refuse. A flagged face is still identified,
#: and a match on it goes to a human.
GROUP_PROFILE = AzureQualityProfile(
    name="group",
    min_face_px=40.0,
    accepted_recognition_quality=frozenset({"high", "medium"}),
    accepted_blur=frozenset({"low", "medium"}),
    max_abs_yaw_deg=45.0,
    max_abs_pitch_deg=35.0,
    max_abs_roll_deg=45.0,
)

#: Below this a group-photo face is not sent to Identify at all.
MIN_IDENTIFIABLE_FACE_PX = 24.0

_REASON_ORDER: tuple[FaceQualityReason, ...] = (
    "face_too_small",
    "bad_angle",
    "too_dark",
    "too_bright",
    "blurred",
    "occluded",
    "low_quality",
)

_QUALITY_SCORE = {"high": 0.95, "medium": 0.6, "low": 0.2}


def _attrs(face: dict[str, Any]) -> dict[str, Any]:
    value = face.get("faceAttributes")
    return value if isinstance(value, dict) else {}


def _face_size(face: dict[str, Any]) -> float:
    rect = face.get("faceRectangle") or {}
    return float(min(rect.get("width", 0), rect.get("height", 0)))


def evaluate_face(
    face: dict[str, Any], profile: AzureQualityProfile
) -> list[FaceQualityReason]:
    """Every check ``face`` fails under ``profile``, most actionable first."""
    attrs = _attrs(face)
    failed: set[FaceQualityReason] = set()
    if _face_size(face) < profile.min_face_px:
        failed.add("face_too_small")
    pose = attrs.get("headPose") or {}
    if (
        abs(float(pose.get("yaw", 0.0))) > profile.max_abs_yaw_deg
        or abs(float(pose.get("pitch", 0.0))) > profile.max_abs_pitch_deg
        or abs(float(pose.get("roll", 0.0))) > profile.max_abs_roll_deg
    ):
        failed.add("bad_angle")
    exposure = (attrs.get("exposure") or {}).get("exposureLevel")
    if exposure == "underExposure":
        failed.add("too_dark")
    elif exposure == "overExposure":
        failed.add("too_bright")
    blur = (attrs.get("blur") or {}).get("blurLevel")
    if (
        profile.accepted_blur is not None
        and blur is not None
        and blur not in profile.accepted_blur
    ):
        failed.add("blurred")
    occlusion = attrs.get("occlusion") or {}
    mask = attrs.get("mask") or {}
    if (
        occlusion.get("eyeOccluded")
        or occlusion.get("mouthOccluded")
        or mask.get("noseAndMouthCovered")
        or mask.get("type") in {"faceMask", "otherMaskOrOcclusion"}
    ):
        failed.add("occluded")
    quality = attrs.get("qualityForRecognition")
    if quality not in profile.accepted_recognition_quality:
        failed.add("low_quality")
    return [r for r in _REASON_ORDER if r in failed]


def quality_score(face: dict[str, Any]) -> float:
    return _QUALITY_SCORE.get(str(_attrs(face).get("qualityForRecognition")), 0.5)


def _metrics(face: dict[str, Any] | None) -> FaceQualityMetrics:
    if face is None:
        return FaceQualityMetrics.all_unavailable()
    attrs = _attrs(face)
    pose = attrs.get("headPose") or {}
    blur = attrs.get("blur") or {}
    exposure = attrs.get("exposure") or {}
    occlusion = attrs.get("occlusion") or {}
    mask = attrs.get("mask") or {}
    occluded = bool(
        occlusion.get("eyeOccluded")
        or occlusion.get("mouthOccluded")
        or mask.get("noseAndMouthCovered")
    )
    yaw = float(pose.get("yaw", 0.0))
    pitch = float(pose.get("pitch", 0.0))

    def measured_or_unavailable(value: Any, unit: str) -> FaceQualityMetric:
        if value is None:
            return FaceQualityMetric.unavailable()
        return FaceQualityMetric.measured(float(value), unit)

    return FaceQualityMetrics(
        # Azure's own scales: blur 0 (sharp) to 1, exposure 0 (dark) to 1,
        # with 0.5 ideal. Not comparable with the opencv backend's numbers.
        blur=measured_or_unavailable(blur.get("value"), "azure_blur"),
        brightness=measured_or_unavailable(exposure.get("value"), "azure_exposure"),
        faceSize=FaceQualityMetric.measured(_face_size(face), "px"),
        pose=FaceQualityMetric.measured(max(abs(yaw), abs(pitch)), "deg"),
        occlusion=FaceQualityMetric.measured(1.0 if occluded else 0.0, "flag"),
        yaw=FaceQualityMetric.measured(yaw, "deg"),
        pitch=FaceQualityMetric.measured(pitch, "deg"),
        underexposure=FaceQualityMetric.unavailable(),
        overexposure=FaceQualityMetric.unavailable(),
        # Azure reports no per-face detector score.
        detectionConfidence=FaceQualityMetric.unavailable(),
        interEyeDistance=FaceQualityMetric.unavailable(),
    )


def assess_enrollment(faces: list[dict[str, Any]]) -> FaceQualityAssessment:
    """Exactly one usable face, or a refusal saying why not."""
    if not faces:
        return FaceQualityAssessment(
            reason="no_face",
            qualityScore=0.0,
            faceCount=0,
            metrics=_metrics(None),
            reasons=["no_face"],
            detail="No face was found in the photo.",
        )
    if len(faces) > 1:
        return FaceQualityAssessment(
            reason="multiple_faces",
            qualityScore=0.0,
            faceCount=len(faces),
            metrics=_metrics(None),
            reasons=["multiple_faces"],
            detail=f"{len(faces)} faces were found; enrolment needs exactly one.",
        )
    face = faces[0]
    reasons = evaluate_face(face, ENROLLMENT_PROFILE)
    return FaceQualityAssessment(
        reason=reasons[0] if reasons else "ok",
        qualityScore=quality_score(face),
        faceCount=1,
        metrics=_metrics(face),
        reasons=reasons,
        detail=None,
    )


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def _box(face: dict[str, Any]) -> BoundingBox:
    rect = face.get("faceRectangle") or {}
    return BoundingBox(
        x=float(rect.get("left", 0)),
        y=float(rect.get("top", 0)),
        width=float(rect.get("width", 0)),
        height=float(rect.get("height", 0)),
    )


def _rect(face: dict[str, Any]) -> tuple[int, int, int, int]:
    rect = face.get("faceRectangle") or {}
    return (
        int(rect["left"]),
        int(rect["top"]),
        int(rect["width"]),
        int(rect["height"]),
    )


def landmarks_from_azure(face: dict[str, Any]) -> FaceLandmarks | None:
    """Azure's 27 landmarks, reduced to the five-point contract.

    Azure names points from the viewer's side: ``pupilLeft`` is the eye on
    the image's left, which is the subject's right eye. The contract follows
    YuNet, whose ``rightEye`` is the subject's right eye, so the names swap.
    That was checked on a live response, where ``pupilLeft.x`` <
    ``pupilRight.x``.
    """
    points = face.get("faceLandmarks")
    if not isinstance(points, dict):
        return None
    try:

        def p(name: str) -> Point:
            return Point(x=float(points[name]["x"]), y=float(points[name]["y"]))

        return FaceLandmarks(
            rightEye=p("pupilLeft"),
            leftEye=p("pupilRight"),
            noseTip=p("noseTip"),
            mouthRight=p("mouthLeft"),
            mouthLeft=p("mouthRight"),
        )
    except (KeyError, TypeError, ValueError):
        return None


def decode_image(image_base64: str) -> tuple[bytes, int, int]:
    """base64 -> (bytes to send, width, height).

    Decoded locally before anything goes to Azure. An unreadable payload is
    then a 400 from this service with the same wording as every other
    backend, and a photograph that is not an image never leaves the
    process.
    """
    if not image_base64:
        raise ImageDecodeError("No image data was supplied.")
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ImageDecodeError("The image payload is not valid base64.") from error
    if not raw:
        raise ImageDecodeError("The image payload decoded to zero bytes.")

    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ImageDecodeError(
            "The payload could not be decoded as an image. "
            "Expected JPEG, PNG or WebP bytes."
        )
    height, width = image.shape[:2]
    return raw, int(width), int(height)


def _ms_since(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


ClientFactory = Callable[[], AzureFaceClient]


class AzureFaceModelProvider(FaceModelProvider, GalleryIdentificationProvider):
    name = "azure-face"
    weights_version = "detection_03.recognition_04"
    #: Bump if the quality mapping or the gallery layout changes in a way
    #: that should invalidate stored gallery templates.
    preprocessing_version = "1"
    runtime = "azure-ai-face"
    #: A managed Microsoft service used under the subscription's product
    #: terms. Its separate Limited Access gate for identification is reported
    #: as ``identification`` rather than folded into this licensing flag.
    commercial_use = "permitted"
    template_kind = "gallery"

    #: How long a capability answer is trusted. Short, so approval by Microsoft
    #: takes effect without a redeploy.
    PROBE_TTL_S = 300.0
    PROBE_RETRY_S = 30.0

    def __init__(
        self,
        endpoint: str | None,
        key: str | None,
        *,
        timeout_s: float = 15.0,
        max_retries: int = 2,
        client_factory: ClientFactory | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._endpoint = endpoint or ""
        self._key = key or ""
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        self._client_factory = client_factory
        self._clock = clock
        self._client: AzureFaceClient | None = None
        self._lock = threading.Lock()
        self._identification: IdentificationStatus = "unavailable"
        self._checked_at: float | None = None

    # -- lifecycle ----------------------------------------------------------

    def load(self) -> None:
        """Build the client and ask Azure once whether identification is
        approved.

        A missing or wrong key fails startup, so a deploy with a broken
        credential never reaches Running. An unreachable Azure does not fail
        it: the probe is retried on demand.
        """
        if self._client_factory is not None:
            self._client = self._client_factory()
        else:
            self._client = AzureFaceClient(
                self._endpoint,
                self._key,
                timeout_s=self._timeout_s,
                max_retries=self._max_retries,
            )
        # Raises AzureFaceAuthError on a bad key, on purpose.
        self._record(self._client.probe_identification())
        logger.info("azure-face identification status: %s", self._identification)

    def unload(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _require_client(self) -> AzureFaceClient:
        if self._client is None:
            raise AzureFaceUnavailableError(
                "The azure backend was used before load() completed."
            )
        return self._client

    # -- capability ---------------------------------------------------------

    def _record(self, status: IdentificationStatus) -> None:
        with self._lock:
            self._identification = status
            self._checked_at = self._clock()

    def identification_status(self) -> IdentificationStatus:
        with self._lock:
            status, checked = self._identification, self._checked_at
        ttl = self.PROBE_RETRY_S if status == "unavailable" else self.PROBE_TTL_S
        if checked is not None and self._clock() - checked < ttl:
            return status
        if self._client is None:
            return status
        try:
            self._record(self._client.probe_identification())
        except AzureFaceError as error:
            # A key that stopped working after startup. model-info must still
            # answer, so this reports "unavailable" and logs the code only.
            logger.warning("azure-face capability probe failed: %s", error.code)
            self._record("unavailable")
        return self._identification

    # -- detection and quality (no approval needed) --------------------------

    def detect(self, image_base64: str) -> DetectionResult:
        raw, width, height = decode_image(image_base64)
        faces = self._require_client().detect(raw, return_face_id=False)
        return DetectionResult(
            faces=[
                DetectedFaceBox(
                    faceId=i,
                    boundingBox=_box(face),
                    # Azure reports no detector score; every face it returns
                    # already passed its own threshold.
                    detectionConfidence=1.0,
                    landmarks=landmarks_from_azure(face),
                )
                for i, face in enumerate(faces)
            ],
            image_width=width,
            image_height=height,
        )

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        raw, _, _ = decode_image(image_base64)
        return assess_enrollment(
            self._require_client().detect(raw, return_face_id=False)
        )

    # -- embedding routes: not this backend ------------------------------------

    def _no_embeddings(self) -> ProviderCapabilityError:
        return ProviderCapabilityError(
            "The azure backend keeps templates in Azure Face and returns no "
            "embeddings. Use /v1/gallery/enroll and /v1/identify."
        )

    def align(self, image_base64, bounding_box, landmarks) -> AlignedFace:
        raise self._no_embeddings()

    def embed(self, image_base64, bounding_box=None, landmarks=None) -> list[float]:
        raise self._no_embeddings()

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        raise self._no_embeddings()

    def analyze_image(self, image: SessionImageInput) -> ImageAnalysis:
        raise self._no_embeddings()

    def enroll_image(self, image_base64: str) -> EnrollmentOutcome:
        raise self._no_embeddings()

    def compare_embeddings(self, a: list[float], b: list[float]) -> float:
        raise self._no_embeddings()

    # -- gallery ------------------------------------------------------------

    def _require_identification(self) -> AzureFaceClient:
        client = self._require_client()
        status = self.identification_status()
        if status == "not_approved":
            raise AzureFaceNotApprovedError(
                "Azure Face Identification/Verification is not approved for this "
                "resource. Apply at https://aka.ms/facerecognition."
            )
        if status != "enabled":
            raise AzureFaceUnavailableError(
                "Azure Face identification is currently unavailable."
            )
        return client

    def _detect_with_ids(
        self, client: AzureFaceClient, raw: bytes
    ) -> list[dict[str, Any]]:
        try:
            return client.detect(raw, return_face_id=True)
        except AzureFaceNotApprovedError:
            self._record("not_approved")
            raise

    def gallery_enroll(
        self,
        image_base64: str,
        targets: list[GalleryTarget],
        other_person_min_confidence: float,
        own_person_min_confidence: float,
    ) -> GalleryEnrollResponse:
        client = self._require_identification()
        raw, _, _ = decode_image(image_base64)
        faces = self._detect_with_ids(client, raw)
        assessment = assess_enrollment(faces)

        def respond(outcome: str, **extra: Any) -> GalleryEnrollResponse:
            return GalleryEnrollResponse(
                outcome=outcome,
                assessment=assessment,
                modelName=self.name,
                modelVersion=self.version,
                **extra,
            )

        if assessment.reason != "ok":
            return respond("rejected")
        face = faces[0]
        face_id = str(face["faceId"])
        rect = _rect(face)

        # Check every target before writing to any of them. A refusal must
        # leave every gallery exactly as it was.
        person_ids: dict[str, str | None] = {}
        own_confidences: list[float] = []
        threshold = min(other_person_min_confidence, own_person_min_confidence)
        for target in targets:
            created = client.ensure_gallery(target.gallery_id)
            candidates: list[IdentifyCandidate] = []
            if not created:
                try:
                    candidates = client.identify(
                        [face_id],
                        target.gallery_id,
                        max_candidates=5,
                        confidence_threshold=threshold,
                    )[face_id]
                except AzureFaceGalleryNotReadyError:
                    # Never trained, so nobody in it can be identified yet.
                    # A gallery that is re-training still answers, against
                    # its last trained state.
                    candidates = []
            for candidate in candidates:
                if (
                    candidate.person_id != target.person_id
                    and candidate.confidence >= other_person_min_confidence
                ):
                    return respond(
                        "collision",
                        collision=GalleryCollision(
                            galleryId=target.gallery_id,
                            personId=candidate.person_id,
                            confidence=round(candidate.confidence, 4),
                        ),
                    )
            person_id = target.person_id
            if person_id is not None:
                try:
                    confidence = client.verify(face_id, target.gallery_id, person_id)
                except AzureFaceNotFoundError:
                    # The person was removed on Azure's side. A new one is
                    # created below, and apps/web records the new id.
                    person_id = None
                else:
                    own_confidences.append(confidence)
                    if confidence < own_person_min_confidence:
                        return respond(
                            "own_mismatch", ownConfidence=round(confidence, 4)
                        )
            person_ids[target.gallery_id] = person_id

        placements: list[GalleryPlacement] = []
        created_people: list[tuple[str, str]] = []
        try:
            for target in targets:
                person_id = person_ids[target.gallery_id]
                created = person_id is None
                if person_id is None:
                    person_id = client.create_person(
                        target.gallery_id, target.person_name
                    )
                    created_people.append((target.gallery_id, person_id))
                persisted = client.add_face(target.gallery_id, person_id, raw, rect)
                placements.append(
                    GalleryPlacement(
                        galleryId=target.gallery_id,
                        personId=person_id,
                        persistedFaceId=persisted,
                        personCreated=created,
                    )
                )
        except AzureFaceError:
            # Undo what this request wrote, so a half-finished enrolment
            # leaves no face in Azure that apps/web has no record of.
            for placement in placements:
                self._quietly(
                    client.delete_face,
                    placement.gallery_id,
                    placement.person_id,
                    placement.persisted_face_id,
                )
            for gallery_id, person_id in created_people:
                self._quietly(client.delete_person, gallery_id, person_id)
            raise

        for gallery_id in {p.gallery_id for p in placements}:
            self._quietly(client.train, gallery_id)
        return respond(
            "accepted",
            placements=placements,
            ownConfidence=round(min(own_confidences), 4) if own_confidences else None,
        )

    def gallery_remove(self, removals: list[GalleryRemoval]) -> int:
        client = self._require_identification()
        touched: set[str] = set()
        for removal in removals:
            if removal.persisted_face_id is None:
                client.delete_person(removal.gallery_id, removal.person_id)
            else:
                client.delete_face(
                    removal.gallery_id, removal.person_id, removal.persisted_face_id
                )
            touched.add(removal.gallery_id)
        for gallery_id in touched:
            self._quietly(client.train, gallery_id)
        return len(removals)

    def identify(
        self,
        gallery_id: str,
        images: list[SessionImageInput],
        max_candidates: int,
        confidence_threshold: float,
    ) -> IdentifyResponse:
        started = time.perf_counter()
        client = self._require_client()
        identification = self.identification_status()
        use_ids = identification == "enabled"

        decode_ms = detect_ms = identify_ms = 0.0
        pending: list[
            tuple[SessionImageInput, dict[str, Any], list[FaceQualityReason]]
        ] = []
        rejected: list[RejectedFace] = []
        summaries: list[DetectEmbedImageSummary] = []
        for image in images:
            t = time.perf_counter()
            raw, width, height = decode_image(image.image_base64)
            decode_ms += _ms_since(t)
            t = time.perf_counter()
            if use_ids:
                try:
                    faces = self._detect_with_ids(client, raw)
                except AzureFaceNotApprovedError:
                    use_ids, identification = False, "not_approved"
                    faces = client.detect(raw, return_face_id=False)
            else:
                faces = client.detect(raw, return_face_id=False)
            detect_ms += _ms_since(t)

            kept = 0
            dropped = 0
            for face in faces:
                size = _face_size(face)
                quality = _attrs(face).get("qualityForRecognition")
                reason = (
                    "face_too_small"
                    if size < MIN_IDENTIFIABLE_FACE_PX
                    else "low_quality"
                    if quality == "low"
                    else None
                )
                if reason is not None:
                    dropped += 1
                    rejected.append(
                        RejectedFace(
                            sequenceNumber=image.sequence_number,
                            boundingBox=_box(face),
                            detectionConfidence=1.0,
                            reason=reason,
                            faceSize=size,
                        )
                    )
                    continue
                kept += 1
                pending.append((image, face, evaluate_face(face, GROUP_PROFILE)))
            summaries.append(
                DetectEmbedImageSummary(
                    sequenceNumber=image.sequence_number,
                    imageWidth=width,
                    imageHeight=height,
                    detectedFaces=len(faces),
                    embeddedFaces=kept,
                    rejectedFaces=dropped,
                )
            )

        candidates_by_face: dict[str, list[IdentifyCandidate]] = {}
        gallery_ready = False
        batches = 0
        face_ids = [
            str(face["faceId"])
            for _, face, _ in pending
            if use_ids and face.get("faceId")
        ]
        if use_ids:
            gallery_ready = True
            if face_ids:
                t = time.perf_counter()
                try:
                    candidates_by_face = client.identify(
                        face_ids,
                        gallery_id,
                        max_candidates=max_candidates,
                        confidence_threshold=confidence_threshold,
                    )
                    batches = len(batched(face_ids, IDENTIFY_BATCH_SIZE))
                except (AzureFaceNotFoundError, AzureFaceGalleryNotReadyError):
                    # No gallery yet, or one that has never finished
                    # training: nobody in this class can be identified under
                    # this backend yet. Faces are reported; nobody is
                    # suggested.
                    gallery_ready = False
                identify_ms = _ms_since(t)

        identified = [
            IdentifiedFace(
                sequenceNumber=image.sequence_number,
                boundingBox=_box(face),
                detectionConfidence=1.0,
                qualityScore=quality_score(face),
                qualityFlags=flags,
                faceSize=_face_size(face),
                landmarks=landmarks_from_azure(face),
                candidates=[
                    IdentifyCandidateWire(
                        personId=c.person_id, confidence=round(c.confidence, 4)
                    )
                    for c in sorted(
                        candidates_by_face.get(str(face.get("faceId")), []),
                        key=lambda c: -c.confidence,
                    )
                ],
            )
            for image, face, flags in pending
        ]
        return IdentifyResponse(
            faces=identified,
            rejectedFaces=rejected,
            images=summaries,
            identification=identification,
            galleryReady=gallery_ready,
            identifyBatches=batches,
            modelName=self.name,
            modelVersion=self.version,
            timings=PipelineTimingsWire(
                decodeMs=round(decode_ms, 2),
                detectMs=round(detect_ms, 2),
                alignMs=0.0,
                qualityMs=0.0,
                # The recognition stage. For a gallery backend that is
                # Identify, not an embedding network.
                embedMs=round(identify_ms, 2),
                totalMs=round(_ms_since(started), 2),
            ),
        )

    @staticmethod
    def _quietly(fn: Callable[..., Any], *args: Any) -> None:
        """Best effort. Training and cleanup failures are logged by code and
        never replace the outcome the caller is waiting for."""
        try:
            fn(*args)
        except AzureFaceError as error:
            logger.warning("azure-face %s failed: %s", fn.__name__, error.code)
