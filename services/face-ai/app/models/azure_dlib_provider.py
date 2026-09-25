"""Azure Face detects; this service recognises
(``FACE_MODEL_BACKEND=azure_detection_own_recognition``).

Azure AI Face does one job here: it finds faces. Each image goes to Azure
Detect once, without a faceId, and that call needs no Limited Access
approval. Everything that decides who a face belongs to runs in this
process. Each face is aligned on Azure's landmarks, cut from the original
image and embedded by dlib's ResNet (dlib_recognition.py). The 128-d vectors
go back to apps/web, which stores them in pgvector and matches them within
one class. Identify, Verify and the PersonGroup APIs are never called, so
nothing this backend does waits on Microsoft's approval.

## What Azure receives

The decoded pixels, re-encoded as JPEG. Never the uploaded bytes, for two
reasons:

* A phone photo's EXIF can carry its GPS position and the device's identity.
  Re-encoding sends pixels and nothing else.
* OpenCV applies EXIF orientation when it decodes. If Azure read the
  orientation differently, its landmarks would be in another frame from the
  pixels the chip is cut from, and every face would be aligned on the wrong
  spot without anything failing.

An image beyond Azure's limits (4096 px a side, 6 MB) is scaled down for
detection only. Azure's coordinates are scaled back, and the chip is always
cut from the full-resolution original.

## Scores

dlib's raw cosine similarities are on another scale from the product's
thresholds: most pairs of different people score above 0.8.
``calibration()`` publishes the measured map onto the product's scale
(docs/CALIBRATION.md), and apps/web refuses this backend's scores without it.

## Failure

An Azure outage is an outage. The error propagates and the route answers 503
with a code and nothing else. It never becomes "no faces found", which apps/web
would record as a class with nobody in it. A face that cannot be aligned or
embedded is reported as rejected, with its reason. It is never embedded from
an unaligned crop.
"""

from __future__ import annotations

import base64
import binascii
import logging
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import numpy as np

from app.azure_face import (
    DETECTION_MODEL,
    AzureFaceClient,
    AzureFaceRateLimitedError,
    AzureFaceRequestError,
    AzureFaceUnavailableError,
)
from app.models.azure_provider import (
    _REASON_ORDER,
    ENROLLMENT_PROFILE,
    GROUP_PROFILE,
    ClientFactory,
    _attrs,
    _box,
    _face_size,
    _metrics,
    assess_enrollment,
    evaluate_face,
    landmarks_from_azure,
    quality_score,
)
from app.models.base import (
    AlignedFace,
    DetectionResult,
    EnrollmentOutcome,
    FaceModelProvider,
    ImageAnalysis,
)
from app.models.dlib_recognition import (
    ALIGNMENT_VERSION,
    MIN_EMBEDDABLE_FACE_PX,
    DlibResNetEmbedder,
    LandmarkError,
    golden_chip,
)
from app.models.face_sharpness import (
    MAX_ENROLLMENT_BLUR,
    MEASURE_VERSION,
    measure_blur,
)
from app.models.model_files import DLIB_ARTIFACTS, DLIB_RESNET, verify_all
from app.models.opencv_provider import ImageDecodeError, ModelNotLoadedError
from app.models.pipeline import COSINE_MATCHER, PipelineTimings, StageDescriptor
from app.schemas import (
    BoundingBox,
    CalibrationKnot,
    DetectedFace,
    DetectedFaceBox,
    DetectEmbedImageSummary,
    FaceLandmarks,
    FaceQualityAssessment,
    FaceQualityMetric,
    FaceQualityReason,
    RejectedFace,
    ScoreCalibration,
    SessionImageInput,
)

logger = logging.getLogger(__name__)

#: Azure Detect's input limits (Face API v1.0).
AZURE_MIN_IMAGE_SIDE = 36
AZURE_MAX_IMAGE_SIDE = 4096
AZURE_MIN_IMAGE_BYTES = 1024
AZURE_MAX_IMAGE_BYTES = 6 * 1024 * 1024
#: Tried in order until the payload fits under the byte limit. 95 first: the
#: evaluation sent Azure the original JPEGs, and landmarks from a q95
#: re-encode are the closest to those.
JPEG_QUALITIES = (95, 90, 85, 80)
#: Applied while the payload is still too large at the lowest quality.
DOWNSCALE_STEP = 0.75

#: A face given to /v1/embed or /v1/align by box must overlap one Azure finds
#: at least this much. Otherwise it is not the same face.
MIN_BOX_IOU = 0.3

#: Raw dlib cosine to the product's scale. The two middle knots put the
#: thresholds apps/web already applies (review 0.45, present 0.62) on the raw
#: scores the evaluation chose: 0.93 and 0.955. At those settings no clean or
#: degraded probe was marked present as somebody else, in either evaluation
#: set (docs/CALIBRATION.md). The margin makes a face whose top two students
#: are within 0.01 raw of each other ambiguous, whatever the institution's own
#: margin says.
DLIB_CALIBRATION = ScoreCalibration(
    id="dlib-resnet-v1.azure-d03.2026-09-24",
    knots=[
        CalibrationKnot(raw=-1.0, calibrated=-1.0),
        CalibrationKnot(raw=0.93, calibrated=0.45),
        CalibrationKnot(raw=0.955, calibrated=0.62),
        CalibrationKnot(raw=1.0, calibrated=1.0),
    ],
    rawAmbiguityMargin=0.01,
)


#: Enrolment for this backend: Azure's enrolment profile, unchanged, except
#: that Azure's blur rating no longer decides. It rises as a face gets
#: smaller whether or not the face is blurred, so it refused ordinary webcam
#: captures as blurry; blur is measured here instead, on the face, at the
#: recogniser's scale (face_sharpness.py). Size, pose, exposure, occlusion
#: and Azure's recognition-quality rating all still apply — and that last one
#: still falls for real blur.
DLIB_ENROLLMENT_PROFILE = replace(
    ENROLLMENT_PROFILE, name="enrollment-dlib", accepted_blur=None
)


# ---------------------------------------------------------------------------
# Image preparation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PreparedImage:
    """One decoded image, and what Azure is sent in its place."""

    #: The original pixels, RGB. Chips are cut from this.
    rgb: np.ndarray
    #: Re-encoded JPEG carrying pixels and no metadata.
    payload: bytes
    width: int
    height: int
    #: Original pixels per pixel of what Azure saw. 1.0 unless it was
    #: scaled down.
    scale_x: float
    scale_y: float


def _encode(image: np.ndarray, extension: str, params: list[int]) -> bytes:
    import cv2

    ok, buffer = cv2.imencode(extension, image, params)
    if not ok:
        raise ImageDecodeError("The image could not be re-encoded for detection.")
    return buffer.tobytes()


def _resize(image: np.ndarray, factor: float) -> np.ndarray:
    import cv2

    height, width = image.shape[:2]
    size = (max(1, round(width * factor)), max(1, round(height * factor)))
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


def _payload_for_azure(bgr: np.ndarray) -> tuple[bytes, int, int]:
    """JPEG bytes inside Azure's limits, and the size they encode."""
    import cv2

    image = bgr
    longest = max(image.shape[:2])
    if longest > AZURE_MAX_IMAGE_SIDE:
        image = _resize(image, AZURE_MAX_IMAGE_SIDE / longest)
    while True:
        for quality in JPEG_QUALITIES:
            payload = _encode(image, ".jpg", [cv2.IMWRITE_JPEG_QUALITY, quality])
            if len(payload) <= AZURE_MAX_IMAGE_BYTES:
                break
        else:
            image = _resize(image, DOWNSCALE_STEP)
            if min(image.shape[:2]) < AZURE_MIN_IMAGE_SIDE:
                raise ImageDecodeError(
                    "The image could not be made small enough for detection."
                )
            continue
        break
    if len(payload) < AZURE_MIN_IMAGE_BYTES:
        # Azure rejects anything under a kilobyte as an invalid image. A
        # photograph containing a face big enough to recognise never encodes
        # that small at q95; a blank frame does. Saying so is more use than
        # forwarding it and relaying "InvalidImage".
        raise ImageDecodeError(
            "The image holds too little detail to contain a face."
        )
    height, width = image.shape[:2]
    return payload, int(width), int(height)


def prepare_image(image_base64: str) -> PreparedImage:
    """Decode once, locally, before anything goes to Azure.

    An unreadable payload is then a 400 from this service in the same words
    as every other backend, and bytes that are not an image never leave the
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

    bgr = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ImageDecodeError(
            "The payload could not be decoded as an image. "
            "Expected JPEG, PNG or WebP bytes."
        )
    if bgr.ndim != 3 or bgr.shape[2] != 3:
        raise ImageDecodeError("The decoded image is not a three-channel colour image.")
    height, width = bgr.shape[:2]
    if min(height, width) < AZURE_MIN_IMAGE_SIDE:
        raise ImageDecodeError(
            f"The image is {width}x{height}px. Face detection needs at least "
            f"{AZURE_MIN_IMAGE_SIDE}px on each side."
        )
    payload, sent_width, sent_height = _payload_for_azure(bgr)
    return PreparedImage(
        rgb=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB),
        payload=payload,
        width=int(width),
        height=int(height),
        scale_x=width / sent_width,
        scale_y=height / sent_height,
    )


def _scaled_point(point: Any, sx: float, sy: float) -> Any:
    try:
        return {"x": float(point["x"]) * sx, "y": float(point["y"]) * sy}
    except (KeyError, TypeError, ValueError):
        # Left as it came. five_points refuses it by name.
        return point


def to_original(face: dict[str, Any], sx: float, sy: float) -> dict[str, Any]:
    """One of Azure's faces, in pixels of the original image.

    Always a copy with float coordinates, even at scale 1, so that every face
    downstream has been through the same check.
    """
    rect = face.get("faceRectangle")
    try:
        rectangle = {
            "left": float(rect["left"]) * sx,
            "top": float(rect["top"]) * sy,
            "width": float(rect["width"]) * sx,
            "height": float(rect["height"]) * sy,
        }
    except (KeyError, TypeError, ValueError) as error:
        raise AzureFaceRequestError(
            "Azure Face detect returned a face without a usable rectangle."
        ) from error
    mapped = dict(face)
    mapped["faceRectangle"] = rectangle
    points = face.get("faceLandmarks")
    if isinstance(points, dict):
        mapped["faceLandmarks"] = {
            name: _scaled_point(point, sx, sy) for name, point in points.items()
        }
    return mapped


def _iou(a: BoundingBox, b: BoundingBox) -> float:
    x0, y0 = max(a.x, b.x), max(a.y, b.y)
    x1 = min(a.x + a.width, b.x + b.width)
    y1 = min(a.y + a.height, b.y + b.height)
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = a.width * a.height + b.width * b.height - inter
    return inter / union if union > 0 else 0.0


def _ms_since(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class AzureDetectionOwnRecognitionProvider(FaceModelProvider):
    name = "dlib-resnet-v1"
    #: The dlib-models commit that pins the weights (model_files.DLIB_RESNET).
    weights_version = "dlib-models-2a61575"
    #: Bump if decoding, the re-encode sent to Azure or the chip's colour
    #: order changes.
    preprocessing_version = "1"
    #: The landmarks come from Azure's detector, so its model is part of the
    #: alignment. Changing either invalidates every stored template.
    alignment_version = f"{ALIGNMENT_VERSION}.{DETECTION_MODEL}"
    runtime = "dlib+azure-face-detect"
    #: Every stage is cleared: Azure Detect under the subscription's product
    #: terms, dlib's code under the Boost licence and its weights in the
    #: public domain. docs/MODEL_LICENSES.md records a residual risk in the
    #: weights' training data, which is for legal review, not a blocker.
    commercial_use = "permitted"
    template_kind = "embedding"

    def __init__(
        self,
        model_dir: str | Path | None,
        endpoint: str | None,
        key: str | None,
        *,
        timeout_s: float = 15.0,
        max_retries: int = 2,
        client_factory: ClientFactory | None = None,
        embedder: DlibResNetEmbedder | None = None,
    ) -> None:
        self._model_dir = model_dir
        self._endpoint = endpoint or ""
        self._key = key or ""
        self._timeout_s = timeout_s
        self._max_retries = max_retries
        self._client_factory = client_factory
        self._embedder = embedder
        self._client: AzureFaceClient | None = None

    # -- lifecycle ----------------------------------------------------------

    def load(self) -> None:
        """Verify and load the recogniser, then check the Azure credential.

        Local problems first: a missing or altered weights file, or a dlib
        build that computes something other than the pinned output, fails
        startup before any network call. A wrong key then fails it too. An
        Azure that is only unreachable does not: requests answer 503 until
        it is back.
        """
        if self._embedder is None:
            if not self._model_dir:
                raise ModelNotLoadedError(
                    "FACE_MODEL_DIR is not set. This backend needs the pinned "
                    "dlib recogniser there (scripts/fetch_models.py --set dlib)."
                )
            weights = verify_all(self._model_dir, DLIB_ARTIFACTS)[DLIB_RESNET.role]
            self._embedder = DlibResNetEmbedder(weights)
        if not self._embedder.loaded:
            self._embedder.load()

        if self._client_factory is not None:
            self._client = self._client_factory()
        else:
            self._client = AzureFaceClient(
                self._endpoint,
                self._key,
                timeout_s=self._timeout_s,
                max_retries=self._max_retries,
            )
        self._check_detection(self._client)

    @staticmethod
    def _check_detection(client: AzureFaceClient) -> None:
        """One Detect call on a synthetic pattern, the call every request
        makes. No photograph is sent. A bad key raises AzureFaceAuthError
        here, on purpose."""
        import cv2

        pattern = cv2.resize(golden_chip(), (256, 256), interpolation=cv2.INTER_NEAREST)
        payload = _encode(pattern, ".jpg", [cv2.IMWRITE_JPEG_QUALITY, 95])
        try:
            client.detect(payload, return_face_id=False)
        except (AzureFaceUnavailableError, AzureFaceRateLimitedError) as error:
            logger.warning(
                "azure-face detection is unreachable at startup (%s); "
                "requests will answer 503 until it is back",
                error.code,
            )
            return
        logger.info("azure-face detection check passed")

    def unload(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _require(self) -> tuple[AzureFaceClient, DlibResNetEmbedder]:
        if self._client is None or self._embedder is None or not self._embedder.loaded:
            raise ModelNotLoadedError(
                "The azure_detection_own_recognition backend was used before "
                "load() completed."
            )
        return self._client, self._embedder

    # -- provenance ---------------------------------------------------------

    def calibration(self) -> ScoreCalibration:
        return DLIB_CALIBRATION

    def stage_descriptors(self) -> tuple[StageDescriptor, ...]:
        return (
            StageDescriptor(
                role="detector",
                name="azure-face-detect",
                version=DETECTION_MODEL,
                runtime="azure-ai-face",
                commercial_use="permitted",
                capabilities=frozenset({"landmarks5"}),
                licence_note=(
                    "Azure AI Face Detect, a managed service under the "
                    "subscription's Microsoft Product Terms. Detection needs "
                    "no Limited Access approval. Only pixels are sent; no "
                    "faceId is requested and nothing is stored by Azure."
                ),
            ),
            StageDescriptor(
                role="aligner",
                name="dlib-5point-from-azure-27",
                version=self.alignment_version or "",
                runtime="dlib",
                commercial_use="permitted",
                capabilities=frozenset({"similarity_transform"}),
                licence_note=(
                    "dlib's chip extraction (Boost Software License 1.0) on "
                    "five points derived from Azure's landmarks. No weights."
                ),
            ),
            StageDescriptor(
                role="embedder",
                name="dlib_face_recognition_resnet_model_v1",
                version=self.weights_version,
                runtime="dlib",
                commercial_use="permitted",
                capabilities=frozenset({"batch"}),
                required_assets=(DLIB_RESNET.filename,),
                embedding_dim=self.embedding_dim,
                licence_note=(
                    "Weights released into the public domain by their author "
                    "(davisking/dlib-models, CC0-1.0); dlib itself is Boost "
                    "1.0. About half the training images came from FaceScrub "
                    "and VGG Face, whose licences are non-commercial. That "
                    "residual risk is recorded in docs/MODEL_LICENSES.md for "
                    "legal review."
                ),
            ),
            COSINE_MATCHER,
        )

    # -- detection ----------------------------------------------------------

    def _detect(
        self, image_base64: str
    ) -> tuple[PreparedImage, list[dict[str, Any]], float, float]:
        """Decode, detect, and map every face back to the original image.

        Returns the prepared image, the faces, and the decode and detect
        times in milliseconds.
        """
        client, _ = self._require()
        started = time.perf_counter()
        prepared = prepare_image(image_base64)
        decode_ms = _ms_since(started)
        started = time.perf_counter()
        found = client.detect(prepared.payload, return_face_id=False)
        detect_ms = _ms_since(started)
        faces = [
            to_original(face, prepared.scale_x, prepared.scale_y) for face in found
        ]
        return prepared, faces, decode_ms, detect_ms

    def detect(self, image_base64: str) -> DetectionResult:
        prepared, faces, _, _ = self._detect(image_base64)
        return DetectionResult(
            faces=[
                DetectedFaceBox(
                    faceId=index,
                    boundingBox=_box(face),
                    # Azure reports no detector score. Every face it returns
                    # already passed its own threshold.
                    detectionConfidence=1.0,
                    landmarks=landmarks_from_azure(face),
                )
                for index, face in enumerate(faces)
            ],
            image_width=prepared.width,
            image_height=prepared.height,
        )

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        try:
            prepared, faces, _, _ = self._detect(image_base64)
        except ImageDecodeError as error:
            return _refusal(str(error), face_count=0)
        assessment, blur = assess_dlib_enrollment(prepared, faces)
        _log_enrollment_quality("quality", prepared, faces, assessment, blur)
        return assessment

    # -- alignment and embedding --------------------------------------------

    def _chip(self, prepared: PreparedImage, face: dict[str, Any]) -> np.ndarray:
        """The aligned chip for one face. Raises LandmarkError."""
        _, embedder = self._require()
        points = _five_points(face)
        return embedder.extract_chip(prepared.rgb, points)

    def _embed_one(self, prepared: PreparedImage, face: dict[str, Any]) -> list[float]:
        _, embedder = self._require()
        try:
            chip = self._chip(prepared, face)
        except LandmarkError as error:
            raise ImageDecodeError(
                f"The face could not be aligned: {error}."
            ) from error
        vector = embedder.embed([chip])[0]
        if vector is None:
            raise ImageDecodeError(
                "The recogniser produced no usable embedding for this face."
            )
        return vector

    def _select(
        self, image_base64: str, bounding_box: BoundingBox | None
    ) -> tuple[PreparedImage, dict[str, Any]]:
        """The face a single-face route means.

        Azure is asked again, because alignment needs its 27 landmarks and
        the five-point contract cannot carry them. With a box, the detected
        face that overlaps it most; without one, the largest face.
        """
        prepared, faces, _, _ = self._detect(image_base64)
        if not faces:
            raise ImageDecodeError("No face was found in the image.")
        if bounding_box is None:
            return prepared, max(faces, key=_face_size)
        best = max(faces, key=lambda face: _iou(_box(face), bounding_box))
        if _iou(_box(best), bounding_box) < MIN_BOX_IOU:
            raise ImageDecodeError(
                "No detected face matches the supplied bounding box."
            )
        return prepared, best

    def align(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None,
        landmarks: FaceLandmarks | None,
    ) -> AlignedFace:
        """The chip the recogniser sees. ``landmarks`` is not used: see
        ``_select``."""
        import cv2

        prepared, face = self._select(image_base64, bounding_box)
        try:
            chip = self._chip(prepared, face)
        except LandmarkError as error:
            raise ImageDecodeError(
                f"The face could not be aligned: {error}."
            ) from error
        # PNG, lossless, and BGR because that is what imencode writes.
        encoded = _encode(cv2.cvtColor(chip, cv2.COLOR_RGB2BGR), ".png", [])
        return AlignedFace(
            image_base64=base64.b64encode(encoded).decode("ascii"), aligned=True
        )

    def embed(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None = None,
        landmarks: FaceLandmarks | None = None,
    ) -> list[float]:
        prepared, face = self._select(image_base64, bounding_box)
        return self._embed_one(prepared, face)

    def enroll_image(self, image_base64: str) -> EnrollmentOutcome:
        """One decode, one Detect, one embedding.

        The quality gate is ``assess_dlib_enrollment``: Azure's attributes
        for size, pose, exposure, occlusion and recognition quality, and this
        service's own measurement of blur, all in original pixels. A face that
        passes it and still cannot be embedded is refused as ``low_quality``,
        with no vector.
        """
        try:
            prepared, faces, _, _ = self._detect(image_base64)
        except ImageDecodeError as error:
            return EnrollmentOutcome(
                assessment=_refusal(str(error), face_count=0),
                embedding=None,
                aligned=False,
            )
        assessment, blur = assess_dlib_enrollment(prepared, faces)
        _log_enrollment_quality("enroll", prepared, faces, assessment, blur)
        if assessment.reason != "ok":
            return EnrollmentOutcome(
                assessment=assessment, embedding=None, aligned=False
            )
        try:
            vector = self._embed_one(prepared, faces[0])
        except ImageDecodeError as error:
            return EnrollmentOutcome(
                assessment=_refusal(str(error), face_count=1, base=assessment),
                embedding=None,
                aligned=False,
            )
        return EnrollmentOutcome(assessment=assessment, embedding=vector, aligned=True)

    # -- the classroom path -------------------------------------------------

    def analyze_image(self, image: SessionImageInput) -> ImageAnalysis:
        """Every face in one photo: detected by Azure, aligned, embedded here.

        Quality is flagged, not refused. A flagged face is still embedded,
        and apps/web sends any match on it to a teacher. Faces too small to
        embed, or whose landmarks cannot align them, are reported in
        ``rejected`` with the reason, so the count the teacher sees is honest.
        """
        _, embedder = self._require()
        timings = PipelineTimings()
        prepared, faces, timings.decode_ms, timings.detect_ms = self._detect(
            image.image_base64
        )

        rejected: list[RejectedFace] = []
        pending: list[tuple[dict[str, Any], np.ndarray, list[Any]]] = []
        for face in faces:
            size = _face_size(face)
            if size < MIN_EMBEDDABLE_FACE_PX:
                rejected.append(_rejected(image, face, "face_too_small"))
                continue
            started = time.perf_counter()
            try:
                chip = self._chip(prepared, face)
            except LandmarkError:
                rejected.append(_rejected(image, face, "alignment_failed"))
                continue
            finally:
                timings.align_ms += _ms_since(started)
            started = time.perf_counter()
            flags = evaluate_face(face, GROUP_PROFILE)
            timings.quality_ms += _ms_since(started)
            pending.append((face, chip, flags))

        started = time.perf_counter()
        vectors = embedder.embed([chip for _, chip, _ in pending])
        timings.embed_ms = _ms_since(started)

        embedded: list[DetectedFace] = []
        for (face, _, flags), vector in zip(pending, vectors, strict=True):
            if vector is None:
                rejected.append(_rejected(image, face, "embedding_failed"))
                continue
            embedded.append(
                DetectedFace(
                    sequenceNumber=image.sequence_number,
                    boundingBox=_box(face),
                    embedding=vector,
                    detectionConfidence=1.0,
                    qualityScore=quality_score(face),
                    landmarks=landmarks_from_azure(face),
                    aligned=True,
                    qualityFlags=flags,
                    faceSize=_face_size(face),
                )
            )

        return ImageAnalysis(
            faces=embedded,
            rejected=rejected,
            summary=DetectEmbedImageSummary(
                sequenceNumber=image.sequence_number,
                imageWidth=prepared.width,
                imageHeight=prepared.height,
                detectedFaces=len(faces),
                embeddedFaces=len(embedded),
                rejectedFaces=len(rejected),
            ),
            timings=timings,
        )

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        return self.analyze_image(image).faces


def assess_dlib_enrollment(
    prepared: PreparedImage, faces: list[dict[str, Any]]
) -> tuple[FaceQualityAssessment, float | None]:
    """Exactly one usable face, or a refusal naming the thing to fix.

    Returns the assessment and the measured blur (None when it was not
    measured). The order matters for what a person is told:

    * Too small is decided before blur and blur is then not measured. A small
      face has little detail at any focus, and "hold the camera steady" does
      not fix a face that is too far away; "move closer" fixes both.
    * Blur is measured on the face, at the recogniser's scale, against a
      threshold calibrated on what blur costs the template. Not Azure's blur
      rating: that tracks face size as much as focus.
    * Everything else Azure reports is applied exactly as before.
    """
    if len(faces) != 1:
        return assess_enrollment(faces), None
    face = faces[0]
    failed: set[FaceQualityReason] = set(
        evaluate_face(face, DLIB_ENROLLMENT_PROFILE)
    )
    blur: float | None = None
    detail: str | None = None
    if "face_too_small" not in failed:
        try:
            blur = measure_blur(prepared.rgb, _five_points(face))
        except LandmarkError as error:
            # Enrolment could not embed this face either; say why now.
            failed.add("low_quality")
            detail = f"The face could not be aligned: {error}."
        else:
            if blur > MAX_ENROLLMENT_BLUR:
                failed.add("blurred")
    reasons = [r for r in _REASON_ORDER if r in failed]
    metrics = _metrics(face).model_copy(
        update={
            "blur": (
                FaceQualityMetric.measured(blur, f"blur_effect_v{MEASURE_VERSION}")
                if blur is not None
                else FaceQualityMetric.unavailable()
            )
        }
    )
    return (
        FaceQualityAssessment(
            reason=reasons[0] if reasons else "ok",
            qualityScore=quality_score(face),
            faceCount=1,
            metrics=metrics,
            reasons=reasons,
            detail=detail,
        ),
        blur,
    )


def _log_enrollment_quality(
    route: str,
    prepared: PreparedImage,
    faces: list[dict[str, Any]],
    assessment: FaceQualityAssessment,
    blur: float | None,
) -> None:
    """One line per enrolment decision, so a refusal can be explained from
    the logs instead of guessed at.

    Sizes, levels and scores only. No pixels, no landmark positions, no
    vector, nothing that identifies anybody — and apps/web does not audit
    quality refusals, so without this line nobody could tell a strict
    threshold from a bad camera.
    """
    sent_w = round(prepared.width / prepared.scale_x)
    sent_h = round(prepared.height / prepared.scale_y)
    face_part = "face=-"
    if len(faces) == 1:
        face = faces[0]
        rect = face.get("faceRectangle") or {}
        attrs = _attrs(face)
        pose = attrs.get("headPose") or {}
        azure_blur = attrs.get("blur") or {}
        width, height = float(rect.get("width", 0)), float(rect.get("height", 0))
        face_part = (
            f"face={width:.0f}x{height:.0f} "
            f"blur={'-' if blur is None else f'{blur:.3f}'} "
            f"max_blur={MAX_ENROLLMENT_BLUR:.2f} measure=v{MEASURE_VERSION} "
            f"azure_blur={azure_blur.get('blurLevel', '-')}"
            f"({float(azure_blur.get('value', 0.0)):.2f}) "
            f"azure_quality={attrs.get('qualityForRecognition', '-')} "
            f"exposure={(attrs.get('exposure') or {}).get('exposureLevel', '-')} "
            f"yaw={float(pose.get('yaw', 0.0)):.0f} "
            f"pitch={float(pose.get('pitch', 0.0)):.0f} "
            f"roll={float(pose.get('roll', 0.0)):.0f}"
        )
    logger.info(
        "enrolment quality: route=%s decision=%s reasons=%s image=%dx%d "
        "sent=%dx%d faces=%d %s",
        route,
        assessment.reason,
        ",".join(assessment.reasons) or "-",
        prepared.width,
        prepared.height,
        sent_w,
        sent_h,
        len(faces),
        face_part,
    )


def _five_points(face: dict[str, Any]) -> list[tuple[float, float]]:
    from app.models.dlib_recognition import five_points

    landmarks = face.get("faceLandmarks")
    if not isinstance(landmarks, dict):
        raise LandmarkError("Azure returned no landmarks for this face")
    return five_points(landmarks, _face_size(face))


def _rejected(
    image: SessionImageInput, face: dict[str, Any], reason: str
) -> RejectedFace:
    return RejectedFace(
        sequenceNumber=image.sequence_number,
        boundingBox=_box(face),
        detectionConfidence=1.0,
        reason=reason,
        faceSize=_face_size(face),
    )


def _refusal(
    detail: str,
    *,
    face_count: int,
    base: FaceQualityAssessment | None = None,
) -> FaceQualityAssessment:
    """``low_quality`` with a reason, keeping any metrics already measured."""
    from app.schemas import FaceQualityMetrics

    return FaceQualityAssessment(
        reason="low_quality",
        reasons=["low_quality"],
        qualityScore=0.0,
        faceCount=face_count,
        metrics=(
            base.metrics if base is not None else FaceQualityMetrics.all_unavailable()
        ),
        detail=detail,
    )
