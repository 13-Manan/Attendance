"""YuNet + SFace, through OpenCV's own implementations.

    image -> YuNetDetector  (FaceDetectorYN)  -> boxes + 5 landmarks + scores
          -> SFaceAligner   (alignCrop)       -> 112x112 warped crop
          -> app/quality.py                   -> measurements, flags, score
          -> SFaceEmbedder  (cv2.dnn, batched) -> raw 128-d vectors
          -> L2 normalise                     -> the template we store and compare

Each arrow is a stage object implementing a protocol from pipeline.py, so the
provider is an assembly rather than a monolith, and each stage reports its own
identity and licensing.

## Batching, and why it changes nothing about the vectors

``FaceRecognizerSF.feature`` embeds one crop per call. For a classroom frame
that is thirty sequential inferences. The embedder instead runs the same ONNX
graph through ``cv2.dnn`` with ``blobFromImages``, several crops per forward
pass, using the preprocessing ``feature`` applies internally (scale 1, no mean,
BGR->RGB, 112x112). Measured on this artefact the outputs are identical to
``feature`` (max absolute difference 0.0), so batching is not a preprocessing
change and stored templates remain comparable. Chunks of eight: the same
throughput as one batch of forty at under half the peak memory.

## Thread safety

gunicorn runs sync routes on a thread pool, so two requests can reach one
provider at once. ``FaceDetectorYN.setInputSize`` followed by ``detect`` is a
read-modify-use sequence on shared state, and a ``cv2.dnn.Net`` holds its
input blob between ``setInput`` and ``forward``. Each stage serialises its own
critical section with a lock; different stages still overlap.

## Why OpenCV rather than ONNX Runtime directly

Both artefacts are ONNX graphs and this service already depends on
``onnxruntime``, so running them there looks like the smaller change. It is not.

The YuNet graph emits twelve *undecoded* tensors — ``cls_``/``obj_``/``bbox_``/
``kps_`` at strides 8, 16 and 32 over 8400 anchors. The tidy ``[N, 15]`` array
with boxes, landmarks and scores is produced by OpenCV's C++ ``FaceDetectorYN``,
which does anchor decoding, ``cls x obj`` score fusion, keypoint decoding and
NMS. None of that is documented in the model zoo. Reimplementing it in Python
would mean owning a numerical reimplementation of somebody else's detector
post-processing, where every bug presents as "recognition is a bit worse" rather
than as a failure.

``FaceRecognizerSF.alignCrop`` is the same argument again: it is the reference
implementation of the exact similarity transform SFace was trained against.

So the decoder and the alignment come from OpenCV, and what this file owns is
the part that is genuinely ours: decoding input, mapping OpenCV's positional
output onto our named contract, enforcing the L2 normalisation our contract
promises, and refusing to run weights nobody verified.

## The two details that are silently expensive to get wrong

1. **SFace does not emit unit vectors.** Measured norms on this exact artefact
   run ~2.3-5.1. ``FaceRecognizerSF.match`` normalises internally, which hides
   it from anyone who only ever uses OpenCV end to end. We store vectors in
   pgvector and compare them ourselves, so a raw vector would be correct under
   cosine distance and quietly wrong under inner-product or L2.
   ``_normalise`` runs on every vector before it leaves; a test asserts it.

2. **Landmark order is positional and easy to transpose.** YuNet emits
   right-eye, left-eye, nose, right-mouth, left-mouth. Our contract is *named*.
   Swapping the eyes produces a mirrored alignment that still yields a plausible
   128-d vector which simply never matches well. ``_landmarks_from_row`` is the
   one place the mapping happens, and a test pins it.
"""

from __future__ import annotations

import base64
import binascii
import math
import threading
import time
from pathlib import Path

import numpy as np

from app.models.base import (
    AlignedFace,
    DetectionResult,
    EnrollmentOutcome,
    FaceModelProvider,
    ImageAnalysis,
)
from app.models.model_files import SFACE, YUNET, verify_all
from app.models.pipeline import (
    AlignedCrop,
    PipelineTimings,
    RawDetection,
    StageDescriptor,
    StageSet,
)
from app.quality import (
    ENROLLMENT_PROFILE,
    GROUP_PROFILE,
    MIN_EMBEDDABLE_FACE_PX,
    FaceMeasurements,
    QualityProfile,
    evaluate,
    measure,
    metrics_from,
)
from app.schemas import (
    EMBEDDING_DIMENSION,
    BoundingBox,
    DetectedFace,
    DetectedFaceBox,
    DetectEmbedImageSummary,
    FaceLandmarks,
    FaceQualityAssessment,
    FaceQualityMetrics,
    FaceQualityReason,
    Point,
    RejectedFace,
    SessionImageInput,
)


class ModelNotLoadedError(RuntimeError):
    """A pipeline stage was called before ``load()`` succeeded."""


class ImageDecodeError(ValueError):
    """The submitted payload is not a decodable image."""


#: The destination template SFace was trained against, in the 112x112 output
#: frame. Copied from OpenCV's own ``face_recognize.cpp`` so alignment here is
#: the alignment the network expects. Order matches YuNet's landmark order:
#: right eye, left eye, nose tip, right mouth corner, left mouth corner.
SFACE_TEMPLATE_112: tuple[tuple[float, float], ...] = (
    (38.2946, 51.6963),
    (73.5318, 51.5014),
    (56.0252, 71.7366),
    (41.5493, 92.3655),
    (70.7299, 92.2041),
)

ALIGNED_SIZE = 112

#: Crops per forward pass. Measured: 8 matches the throughput of one batch of
#: 40 at under half the peak memory (see the module note).
EMBED_BATCH_SIZE = 8

_TRAINING_DATA_NOTE = (
    "Weights licence is permissive, but the training data behind the "
    "distributed artefact is not licensed for commercial biometric use or is "
    "undocumented — see models/LICENSING.md. Not production-approved."
)


def _ms_since(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


# ===========================================================================
# Stages
# ===========================================================================


class YuNetDetector:
    """YuNet via ``cv2.FaceDetectorYN``: boxes, five landmarks and a score."""

    descriptor = StageDescriptor(
        role="detector",
        name="yunet",
        version=YUNET.upstream_release,
        runtime="opencv-FaceDetectorYN",
        commercial_use="unclear",
        capabilities=frozenset({"landmarks5"}),
        required_assets=(YUNET.filename,),
        licence_note=(
            "MIT weights; trained on WIDER FACE, whose annotations are "
            "CC BY-NC-ND. " + _TRAINING_DATA_NOTE
        ),
    )

    def __init__(
        self,
        model_path: Path,
        score_threshold: float,
        nms_threshold: float,
        top_k: int,
        max_detection_edge: int | None = None,
    ) -> None:
        self._model_path = model_path
        self._score_threshold = score_threshold
        self._nms_threshold = nms_threshold
        self._top_k = top_k
        self._max_detection_edge = max_detection_edge
        self._detector = None
        self._input_size: tuple[int, int] | None = None
        self._lock = threading.Lock()

    def load(self) -> None:
        import cv2

        self._detector = cv2.FaceDetectorYN.create(
            model=str(self._model_path),
            config="",
            # Replaced per image by `setInputSize`. YuNet's anchor grid is
            # derived from the input size, so it must match the frame actually
            # being scored; this is only a construction-time placeholder.
            input_size=(320, 320),
            score_threshold=self._score_threshold,
            nms_threshold=self._nms_threshold,
            top_k=self._top_k,
        )
        blank = np.full((ALIGNED_SIZE, ALIGNED_SIZE, 3), 128, dtype=np.uint8)
        self.rows(blank)

    def rows(self, frame: np.ndarray) -> np.ndarray:
        """Raw ``[N, 15]`` YuNet rows, in pixels of ``frame``.

        A frame whose longest edge exceeds ``max_detection_edge`` is detected
        on a downscaled copy and the coordinates scaled back. Detection cost
        grows with pixel count, and a face big enough to recognise is still
        big enough to find at 1920px; alignment then crops from the full
        frame, so no resolution is lost where it matters. The web client
        already caps captures at 1920px, so this only bounds other callers.
        """
        if self._detector is None:
            raise ModelNotLoadedError("The detector was used before load().")
        import cv2

        height, width = frame.shape[:2]
        scale = 1.0
        target = frame
        limit = self._max_detection_edge
        if limit and max(height, width) > limit:
            scale = limit / float(max(height, width))
            target = cv2.resize(
                frame,
                (max(1, round(width * scale)), max(1, round(height * scale))),
                interpolation=cv2.INTER_AREA,
            )

        size = (int(target.shape[1]), int(target.shape[0]))
        with self._lock:
            # YuNet builds its anchor grid from the declared input size, so it
            # must equal the frame being scored or every box lands in the
            # wrong place. Cached because setInputSize rebuilds that grid, and
            # a three-capture classroom request is three frames of one size.
            # Inside the lock: the size and the detect must belong to the
            # same frame.
            if self._input_size != size:
                self._detector.setInputSize(size)
                self._input_size = size
            _, faces = self._detector.detect(target)

        if faces is None:
            return np.empty((0, 15), dtype=np.float32)
        rows = np.array(faces, dtype=np.float32)
        if rows.ndim != 2 or rows.shape[1] < 15:
            # A malformed detector result must not be interpreted. Returning
            # "no faces" is the conservative answer: it routes every student to
            # review rather than inventing a match.
            return np.empty((0, 15), dtype=np.float32)
        if scale != 1.0:
            rows[:, :14] /= scale
        return rows

    def detect_frame(self, frame: np.ndarray) -> list[RawDetection]:
        height, width = frame.shape[:2]
        found: list[RawDetection] = []
        for row in self.rows(frame):
            box = OpenCVFaceModelProvider._box_from_row(row, width, height)
            if box is None:
                continue
            found.append(
                RawDetection(
                    box=box,
                    score=float(min(max(row[14], 0.0), 1.0)),
                    landmarks=OpenCVFaceModelProvider._landmarks_from_row(row),
                )
            )
        return found


class SFaceAligner:
    """``FaceRecognizerSF.alignCrop``: the similarity transform SFace expects.

    The recogniser object is held only for its alignment. Its own network is
    never run (``SFaceEmbedder`` does the inference, batched), so apart from
    the weights it loads nothing is allocated for it. A numpy re-implementation
    of the transform was measured at cosine >= 0.999997 against this one —
    close, but not identical, and "not identical" is a preprocessing change
    that would orphan every stored template. So the reference implementation
    stays.
    """

    descriptor = StageDescriptor(
        role="aligner",
        name="sface-aligncrop",
        version="opencv-" + SFACE.upstream_release,
        runtime="opencv-FaceRecognizerSF.alignCrop",
        commercial_use="not-applicable",
        capabilities=frozenset({"similarity_transform"}),
        required_assets=(SFACE.filename,),
        licence_note="OpenCV (Apache-2.0) geometry; no learned weights are used.",
    )
    output_size = ALIGNED_SIZE

    def __init__(self, model_path: Path) -> None:
        self._model_path = model_path
        self._recognizer = None

    def load(self) -> None:
        import cv2

        self._recognizer = cv2.FaceRecognizerSF.create(
            model=str(self._model_path), config=""
        )

    def align_frame(
        self,
        frame: np.ndarray,
        box: BoundingBox,
        landmarks: FaceLandmarks | None,
    ) -> AlignedCrop:
        import cv2

        if self._recognizer is None:
            raise ModelNotLoadedError("The aligner was used before load().")
        if landmarks is not None:
            row = OpenCVFaceModelProvider._row_for_align(box, landmarks)
            aligned = self._recognizer.alignCrop(frame, row)
            if aligned is None or aligned.size == 0:
                raise ImageDecodeError("Alignment produced an empty crop.")
            return AlignedCrop(crop=aligned, aligned=True)

        x0 = max(0, int(box.x))
        y0 = max(0, int(box.y))
        x1 = min(frame.shape[1], int(box.x + box.width))
        y1 = min(frame.shape[0], int(box.y + box.height))
        crop = frame[y0:y1, x0:x1]
        if crop.size == 0:
            raise ImageDecodeError("The bounding box does not overlap the image.")
        resized = cv2.resize(
            crop, (ALIGNED_SIZE, ALIGNED_SIZE), interpolation=cv2.INTER_LINEAR
        )
        return AlignedCrop(crop=resized, aligned=False)


class SFaceEmbedder:
    """SFace through ``cv2.dnn``, several crops per forward pass."""

    descriptor = StageDescriptor(
        role="embedder",
        name="sface",
        version=SFACE.upstream_release,
        runtime="opencv-dnn",
        commercial_use="unclear",
        capabilities=frozenset({"batch"}),
        required_assets=(SFACE.filename,),
        embedding_dim=EMBEDDING_DIMENSION,
        licence_note=(
            "Apache-2.0 weights; training data undocumented (likely "
            "CASIA-WebFace / VGGFace2 / MS1M-derived). " + _TRAINING_DATA_NOTE
        ),
    )

    def __init__(self, model_path: Path, batch_size: int = EMBED_BATCH_SIZE) -> None:
        self._model_path = model_path
        self._batch_size = max(1, batch_size)
        self._net = None
        self._lock = threading.Lock()

    def load(self) -> None:
        import cv2

        self._net = cv2.dnn.readNetFromONNX(str(self._model_path))
        blank = np.full((ALIGNED_SIZE, ALIGNED_SIZE, 3), 128, dtype=np.uint8)
        self.embed_crops([blank])

    def embed_crops(self, crops: list[np.ndarray]) -> np.ndarray:
        """Raw vectors, one row per crop.

        ``blobFromImages(scale 1, size 112, mean 0, swapRB)`` is exactly what
        ``FaceRecognizerSF.feature`` does internally: raw 0-255 values, no mean
        subtraction, BGR->RGB. Doing any of it before this point as well would
        double-apply it, which is why frames stay BGR from decode onward.
        """
        import cv2

        if self._net is None:
            raise ModelNotLoadedError("The embedder was used before load().")
        if not crops:
            return np.empty((0, EMBEDDING_DIMENSION), dtype=np.float32)
        outputs: list[np.ndarray] = []
        for start in range(0, len(crops), self._batch_size):
            chunk = crops[start : start + self._batch_size]
            blob = cv2.dnn.blobFromImages(
                chunk,
                scalefactor=1.0,
                size=(ALIGNED_SIZE, ALIGNED_SIZE),
                mean=(0, 0, 0),
                swapRB=True,
                crop=False,
            )
            with self._lock:
                self._net.setInput(blob)
                out = self._net.forward()
            outputs.append(np.asarray(out, dtype=np.float32).reshape(len(chunk), -1))
        return np.concatenate(outputs, axis=0)


# ===========================================================================
# Provider
# ===========================================================================


class OpenCVFaceModelProvider(FaceModelProvider):
    """Real recognition: YuNet detection, SFace embedding, via OpenCV."""

    name = "opencv-yunet-sface"
    #: Project-controlled, because upstream publishes dated releases rather than
    #: semantic versions. Composed from both artefacts' upstream release tags so
    #: the identifier stored against a template names exactly what produced it.
    #: Changing either artefact must change this string — every stored vector
    #: becomes incomparable, and `modelVersion` is what makes that detectable.
    weights_version = f"yunet-{YUNET.upstream_release}+sface-{SFACE.upstream_release}"
    #: Bump on any change to decode, crop, alignment template, resize, channel
    #: order or normalisation. "1" is this pipeline's first definition, and the
    #: staged/batched pipeline was verified to produce identical vectors.
    preprocessing_version = "1"
    embedding_dim = EMBEDDING_DIMENSION
    runtime = "opencv"
    #: STAYS "unclear". The weight licences are permissive (SFace Apache-2.0,
    #: YuNet MIT) but the training-data provenance behind both artefacts is
    #: unresolved for commercial biometric use — see LICENSING.md.
    #: `config.py` refuses production traffic on anything but "permitted", and a
    #: test asserts no shipped backend claims it.
    commercial_use = "unclear"

    def __init__(
        self,
        model_dir: str | None = None,
        score_threshold: float = 0.6,
        nms_threshold: float = 0.3,
        top_k: int = 5000,
        min_face_pixels: int | None = None,
        max_detection_edge: int | None = 1920,
        enrollment_profile: QualityProfile = ENROLLMENT_PROFILE,
        group_profile: QualityProfile = GROUP_PROFILE,
    ) -> None:
        self._model_dir = model_dir
        # YuNet's own published defaults. Exposed as configuration rather than
        # constants because a classroom is not the benchmark these were tuned
        # on, and lowering the score threshold to catch a back row is a decision
        # an operator must be able to make and measure.
        self._score_threshold = score_threshold
        self._nms_threshold = nms_threshold
        self._top_k = top_k
        self._max_detection_edge = max_detection_edge
        # An explicit minimum overrides the calibrated enrolment profile's —
        # an operator decision, and one the profile cannot second-guess.
        if min_face_pixels is not None:
            from dataclasses import replace

            enrollment_profile = replace(
                enrollment_profile,
                min_face_px=float(min_face_pixels),
                good_face_px=max(
                    enrollment_profile.good_face_px, float(min_face_pixels)
                ),
            )
        self.enrollment_profile = enrollment_profile
        self.group_profile = group_profile
        self.detector: YuNetDetector | None = None
        self.aligner: SFaceAligner | None = None
        self.embedder: SFaceEmbedder | None = None

    # -- lifecycle ----------------------------------------------------------

    def load(self) -> None:
        """Verify the artefacts, build every stage, then warm them.

        Every failure here is a startup failure, which is the point: a missing
        file, a tampered artefact or a broken OpenCV build must fail the
        container's health check rather than a student's enrolment. Warming
        moves lazy allocation off the first classroom capture, where a
        teacher is standing in front of a room waiting.
        """
        if not self._model_dir:
            raise ModelNotLoadedError(
                "The 'opencv' backend has no model directory configured. Set "
                "FACE_MODEL_DIR to a directory holding the pinned YuNet and "
                "SFace artefacts, then run `python scripts/fetch_models.py` to "
                "download and verify them."
            )

        # Raises ModelArtifactError naming exactly what is wrong. Runs before
        # OpenCV sees a path, so an unverified file is never opened at all.
        paths = verify_all(self._model_dir)

        detector = YuNetDetector(
            paths["detector"],
            score_threshold=self._score_threshold,
            nms_threshold=self._nms_threshold,
            top_k=self._top_k,
            max_detection_edge=self._max_detection_edge,
        )
        aligner = SFaceAligner(paths["recognizer"])
        embedder = SFaceEmbedder(paths["recognizer"])
        for stage in (detector, aligner, embedder):
            stage.load()
        self.detector, self.aligner, self.embedder = detector, aligner, embedder

    def unload(self) -> None:
        self.detector = None
        self.aligner = None
        self.embedder = None

    def stages(self) -> StageSet:
        detector, aligner, embedder = self._require_loaded()
        return StageSet(detector=detector, aligner=aligner, embedder=embedder)

    def stage_descriptors(self) -> tuple[StageDescriptor, ...]:
        # Static, so model-info can describe the pipeline even before load.
        from app.models.pipeline import COSINE_MATCHER

        return (
            YuNetDetector.descriptor,
            SFaceAligner.descriptor,
            SFaceEmbedder.descriptor,
            COSINE_MATCHER,
        )

    # -- decoding -----------------------------------------------------------

    @staticmethod
    def _decode(image_base64: str) -> np.ndarray:
        """base64 -> BGR uint8 array.

        BGR because that is what OpenCV produces and what both models expect
        (SFace's preprocessing does the BGR->RGB swap itself). Converting here
        would double-swap and degrade every embedding in a way nothing would
        report.
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

        buffer = np.frombuffer(raw, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        if image is None:
            raise ImageDecodeError(
                "The payload could not be decoded as an image. Expected JPEG, "
                "PNG or WebP bytes."
            )
        if image.ndim != 3 or image.shape[2] != 3:
            raise ImageDecodeError(
                "The decoded image is not a three-channel colour image."
            )
        return image

    def _require_loaded(self) -> tuple[YuNetDetector, SFaceAligner, SFaceEmbedder]:
        if self.detector is None or self.aligner is None or self.embedder is None:
            raise ModelNotLoadedError(
                "The opencv backend was used before load() completed."
            )
        return self.detector, self.aligner, self.embedder

    # -- detection ----------------------------------------------------------

    @staticmethod
    def _landmarks_from_row(row: np.ndarray) -> FaceLandmarks:
        """Columns 4..13 of a YuNet row, mapped onto our named contract.

        YuNet's order is fixed and positional: right eye, left eye, nose tip,
        right mouth corner, left mouth corner. The single most damaging mistake
        available here is transposing the eyes — it mirrors the alignment, and
        the result is a perfectly well-formed 128-d vector that simply never
        matches the same person again.
        """
        return FaceLandmarks(
            rightEye=Point(x=float(row[4]), y=float(row[5])),
            leftEye=Point(x=float(row[6]), y=float(row[7])),
            noseTip=Point(x=float(row[8]), y=float(row[9])),
            mouthRight=Point(x=float(row[10]), y=float(row[11])),
            mouthLeft=Point(x=float(row[12]), y=float(row[13])),
        )

    def _detect_rows(self, image: np.ndarray) -> np.ndarray:
        """Raw ``[N, 15]`` detections for one decoded frame."""
        detector, _, _ = self._require_loaded()
        return detector.rows(image)

    def detect(self, image_base64: str) -> DetectionResult:
        image = self._decode(image_base64)
        detector, _, _ = self._require_loaded()
        height, width = image.shape[:2]
        faces = [
            DetectedFaceBox(
                faceId=index,
                boundingBox=found.box,
                # Clamped in detect_frame: the contract promises [0, 1], and a
                # detector that returns a hair over 1.0 must not leak that into
                # a confidence the rest of the system compares to a threshold.
                detectionConfidence=found.score,
                landmarks=found.landmarks,
            )
            for index, found in enumerate(detector.detect_frame(image))
        ]
        return DetectionResult(
            faces=faces, image_width=int(width), image_height=int(height)
        )

    @staticmethod
    def _box_from_row(row: np.ndarray, width: int, height: int) -> BoundingBox | None:
        """YuNet's native ``(x, y, w, h)`` clipped to the frame.

        Already our contract's format, so there is no conversion — only
        clipping. YuNet can return a box that runs off the edge for a face at
        the frame boundary, and a negative origin or an overhanging width
        breaks crop arithmetic downstream. A box left with no area is dropped
        rather than passed on as a degenerate rectangle.
        """
        x, y, w, h = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
        if not all(math.isfinite(v) for v in (x, y, w, h)):
            return None
        x0 = max(0.0, x)
        y0 = max(0.0, y)
        x1 = min(float(width), x + w)
        y1 = min(float(height), y + h)
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            return None
        return BoundingBox(x=x0, y=y0, width=x1 - x0, height=y1 - y0)

    # -- quality ------------------------------------------------------------

    @staticmethod
    def _assessment(
        reasons: list[FaceQualityReason],
        score: float,
        face_count: int,
        metrics: FaceQualityMetrics,
        detail: str | None,
    ) -> FaceQualityAssessment:
        return FaceQualityAssessment(
            reason=reasons[0] if reasons else "ok",
            reasons=reasons,
            qualityScore=score,
            faceCount=face_count,
            metrics=metrics,
            detail=detail,
        )

    def _single_subject(
        self, image: np.ndarray
    ) -> tuple[FaceQualityAssessment, RawDetection | None, AlignedCrop | None]:
        """The enrolment gate, on an already-decoded frame.

        Exactly one face, then every check in the enrolment profile. Returns
        the detection and aligned crop too, so the caller that goes on to embed
        does not detect or align a second time.
        """
        detector, aligner, _ = self._require_loaded()
        found = detector.detect_frame(image)

        if not found:
            return (
                self._assessment(
                    ["no_face"], 0.0, 0, FaceQualityMetrics.all_unavailable(),
                    "No face was found in the image.",
                ),
                None,
                None,
            )
        if len(found) > 1:
            return (
                self._assessment(
                    ["multiple_faces"], 0.0, len(found),
                    FaceQualityMetrics.all_unavailable(),
                    f"{len(found)} faces were found; enrolment needs exactly one.",
                ),
                None,
                None,
            )

        face = found[0]
        crop: AlignedCrop | None = None
        try:
            crop = aligner.align_frame(image, face.box, face.landmarks)
        except ImageDecodeError:
            crop = None
        measurements = measure(
            face.score, face.box, face.landmarks, crop.crop if crop else None
        )
        verdict = evaluate(measurements, self.enrollment_profile)
        reasons = list(verdict.reasons)
        if crop is None and "low_quality" not in reasons:
            reasons.append("low_quality")
        return (
            self._assessment(
                reasons,
                verdict.score if reasons == verdict.reasons else 0.0,
                1,
                metrics_from(measurements),
                _describe(reasons, measurements, self.enrollment_profile),
            ),
            face,
            crop,
        )

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        """Judge a single-subject image for enrolment.

        Every check in ``ENROLLMENT_PROFILE`` runs and every failure is
        reported, most actionable first — "move closer" before "hold still",
        because a small face also looks blurred. Pose is estimated from the
        landmarks; occlusion is not measured and says so.
        """
        try:
            image = self._decode(image_base64)
        except ImageDecodeError as error:
            return self._assessment(
                ["low_quality"], 0.0, 0, FaceQualityMetrics.all_unavailable(),
                str(error),
            )
        assessment, _, _ = self._single_subject(image)
        return assessment

    def enroll_image(self, image_base64: str) -> EnrollmentOutcome:
        """One decode, one detection, one alignment, then the embedding.

        The generic path in base.py decodes the image four times and detects
        twice; for a 1280px capture that is most of the request.
        """
        try:
            image = self._decode(image_base64)
        except ImageDecodeError as error:
            return EnrollmentOutcome(
                assessment=self._assessment(
                    ["low_quality"], 0.0, 0, FaceQualityMetrics.all_unavailable(),
                    str(error),
                ),
                embedding=None,
                aligned=False,
            )
        assessment, _, crop = self._single_subject(image)
        if assessment.reason != "ok" or crop is None:
            return EnrollmentOutcome(
                assessment=assessment, embedding=None, aligned=False
            )
        return EnrollmentOutcome(
            assessment=assessment,
            embedding=self._embed_crop(crop.crop),
            aligned=crop.aligned,
        )

    # -- alignment ----------------------------------------------------------

    @staticmethod
    def _row_for_align(
        bounding_box: BoundingBox, landmarks: FaceLandmarks
    ) -> np.ndarray:
        """Rebuild the ``[1, 15]`` row ``alignCrop`` reads landmarks out of.

        ``alignCrop`` takes a detection row rather than landmarks, and reads
        columns 4..13. Our contract carries named landmarks, so the row is
        reconstructed in YuNet's order — the inverse of ``_landmarks_from_row``,
        and wrong in exactly the same way if the eyes are transposed.
        """
        return np.array(
            [[
                bounding_box.x, bounding_box.y, bounding_box.width, bounding_box.height,
                landmarks.right_eye.x, landmarks.right_eye.y,
                landmarks.left_eye.x, landmarks.left_eye.y,
                landmarks.nose_tip.x, landmarks.nose_tip.y,
                landmarks.mouth_right.x, landmarks.mouth_right.y,
                landmarks.mouth_left.x, landmarks.mouth_left.y,
                1.0,
            ]],
            dtype=np.float32,
        )

    def _aligned_crop(
        self,
        image: np.ndarray,
        bounding_box: BoundingBox | None,
        landmarks: FaceLandmarks | None,
    ) -> tuple[np.ndarray, bool]:
        """The 112x112 crop to embed, and whether it is a real alignment.

        Three paths, in descending order of quality, and the caller is always
        told which one was taken:

          1. Landmarks supplied -> ``alignCrop``, the transform SFace expects.
          2. No landmarks, but a box -> plain resized crop, ``aligned=False``.
          3. Neither -> detect first, then (1) or (2).

        The fallbacks exist because ``aligned`` is a field on the response and
        a caller that knows the crop was unaligned can weigh it accordingly.
        They are not equivalent: an unaligned crop through an alignment-trained
        recogniser is measurably worse, and silently pretending otherwise is
        what the flag exists to prevent.
        """
        import cv2

        detector, aligner, _ = self._require_loaded()

        if landmarks is None or bounding_box is None:
            found = detector.detect_frame(image)
            if found:
                landmarks = landmarks or found[0].landmarks
                bounding_box = bounding_box or found[0].box

        if bounding_box is not None:
            result = aligner.align_frame(image, bounding_box, landmarks)
            return result.crop, result.aligned

        # Nothing found and nothing supplied: the whole frame, resized. Honest
        # rather than useful — `aligned=False` says so.
        whole = cv2.resize(
            image, (ALIGNED_SIZE, ALIGNED_SIZE), interpolation=cv2.INTER_LINEAR
        )
        return whole, False

    def align(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None,
        landmarks: FaceLandmarks | None,
    ) -> AlignedFace:
        import cv2

        image = self._decode(image_base64)
        crop, aligned = self._aligned_crop(image, bounding_box, landmarks)
        ok, buffer = cv2.imencode(".png", crop)
        if not ok:
            raise ImageDecodeError("The aligned crop could not be encoded.")
        # PNG, not JPEG: this crop is about to be turned into a biometric
        # template, and a lossy re-encode would change the vector for no reason.
        return AlignedFace(
            image_base64=base64.b64encode(buffer.tobytes()).decode("ascii"),
            aligned=aligned,
        )

    # -- embedding ----------------------------------------------------------

    def _normalise(self, raw: np.ndarray) -> list[float]:
        """One raw vector -> the L2-normalised template, or a refusal.

        SFace does NOT emit unit vectors — measured norms on this artefact run
        ~2.3-5.1. The contract in base.py promises normalised embeddings, and
        pgvector stores what we give it, so this is the line that makes a
        stored template comparable under cosine similarity.
        """
        vector = np.asarray(raw, dtype=np.float64).reshape(-1)
        if vector.shape[0] != self.embedding_dim:
            raise ModelNotLoadedError(
                f"The recogniser returned {vector.shape[0]} dimensions; "
                f"{self.embedding_dim} were expected. The loaded artefact is "
                f"not the pinned SFace model."
            )
        if not np.all(np.isfinite(vector)):
            raise ImageDecodeError(
                "The recogniser produced a non-finite embedding for this crop."
            )
        norm = float(np.linalg.norm(vector))
        if norm == 0.0:
            raise ImageDecodeError(
                "The recogniser produced a zero-length embedding, which has no "
                "direction and could not be compared against anything."
            )
        return (vector / norm).tolist()

    def _embed_crop(self, crop: np.ndarray) -> list[float]:
        """One 112x112 BGR crop -> one L2-normalised 128-d vector."""
        _, _, embedder = self._require_loaded()
        raw = embedder.embed_crops([crop])
        if raw.shape[0] != 1:
            raise ModelNotLoadedError("The embedder returned the wrong number of rows.")
        return self._normalise(raw[0])

    def embed(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None = None,
        landmarks: FaceLandmarks | None = None,
    ) -> list[float]:
        image = self._decode(image_base64)
        crop, _ = self._aligned_crop(image, bounding_box, landmarks)
        return self._embed_crop(crop)

    # -- the classroom path -------------------------------------------------

    def analyze_image(self, image: SessionImageInput) -> ImageAnalysis:
        """Every face in one frame: detected, quality-checked, embedded.

        Faces are embedded independently and keep their own box, landmarks,
        confidence and quality flags. No cross-face or cross-image reasoning
        happens here — deciding who is who, deduplicating a student seen in
        two captures and routing doubt to a human belong to
        ``modules/recognition-engine`` in apps/web, which has the cohort and
        the policy. This service stays stateless.

        A face that cannot be embedded is reported in ``rejected`` rather than
        dropped. The one that matters most in practice is a face too small to
        identify: the teacher can fix that with a closer photo, but only if
        somebody tells them it happened.
        """
        timings = PipelineTimings()
        started = time.perf_counter()
        frame = self._decode(image.image_base64)
        timings.decode_ms = _ms_since(started)
        detector, aligner, embedder = self._require_loaded()
        height, width = frame.shape[:2]

        started = time.perf_counter()
        found = detector.detect_frame(frame)
        timings.detect_ms = _ms_since(started)

        rejected: list[RejectedFace] = []
        pending: list[tuple[RawDetection, AlignedCrop, FaceMeasurements]] = []

        for face in found:
            face_px = float(min(face.box.width, face.box.height))
            if face_px < MIN_EMBEDDABLE_FACE_PX:
                rejected.append(_rejected(image, face, "face_too_small"))
                continue
            started = time.perf_counter()
            try:
                crop = aligner.align_frame(frame, face.box, face.landmarks)
            except ImageDecodeError:
                rejected.append(_rejected(image, face, "alignment_failed"))
                continue
            finally:
                timings.align_ms += _ms_since(started)
            started = time.perf_counter()
            measurements = measure(face.score, face.box, face.landmarks, crop.crop)
            timings.quality_ms += _ms_since(started)
            pending.append((face, crop, measurements))

        started = time.perf_counter()
        raw = embedder.embed_crops([crop.crop for _, crop, _ in pending])
        timings.embed_ms = _ms_since(started)

        faces: list[DetectedFace] = []
        for (face, crop, measurements), vector in zip(pending, raw, strict=True):
            try:
                embedding = self._normalise(vector)
            except ImageDecodeError:
                # One unusable face must not fail a whole classroom capture.
                # Reported, so the count of faces the teacher sees is honest;
                # that student lands in review, which is the safe direction.
                rejected.append(_rejected(image, face, "embedding_failed"))
                continue
            verdict = evaluate(measurements, self.group_profile)
            faces.append(
                DetectedFace(
                    sequenceNumber=image.sequence_number,
                    boundingBox=face.box,
                    embedding=embedding,
                    detectionConfidence=face.score,
                    qualityScore=verdict.score,
                    landmarks=face.landmarks,
                    aligned=crop.aligned,
                    qualityFlags=verdict.reasons,
                    faceSize=measurements.face_size_px,
                )
            )

        return ImageAnalysis(
            faces=faces,
            rejected=rejected,
            summary=DetectEmbedImageSummary(
                sequenceNumber=image.sequence_number,
                imageWidth=int(width),
                imageHeight=int(height),
                detectedFaces=len(found),
                embeddedFaces=len(faces),
                rejectedFaces=len(rejected),
            ),
            timings=timings,
        )

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        return self.analyze_image(image).faces


def _rejected(
    image: SessionImageInput, face: RawDetection, reason: str
) -> RejectedFace:
    return RejectedFace(
        sequenceNumber=image.sequence_number,
        boundingBox=face.box,
        detectionConfidence=face.score,
        reason=reason,
        faceSize=float(min(face.box.width, face.box.height)),
    )


def _describe(
    reasons: list[FaceQualityReason],
    m: FaceMeasurements,
    profile: QualityProfile,
) -> str | None:
    """Operator-facing detail. Debug only — apps/web shows its own wording."""
    if not reasons:
        return None
    parts: list[str] = []
    for reason in reasons:
        if reason == "face_too_small":
            parts.append(
                f"face is {m.face_size_px:.0f}px; {profile.min_face_px:.0f}px needed"
            )
        elif reason == "blurred" and m.sharpness is not None:
            parts.append(f"sharpness {m.sharpness:.0f} < {profile.min_sharpness:.0f}")
        elif reason in ("too_dark", "too_bright") and m.brightness is not None:
            parts.append(f"brightness {m.brightness:.0f}")
        elif (
            reason == "bad_angle"
            and m.yaw_deg is not None
            and m.pitch_deg is not None
        ):
            parts.append(
                f"yaw {m.yaw_deg:+.0f}°, pitch {m.pitch_deg:+.0f}° (estimated)"
            )
        elif reason == "occluded":
            parts.append(
                f"detector confidence {m.detection_confidence:.2f} "
                f"< {profile.min_detection_confidence:.2f}"
            )
        else:
            parts.append(reason)
    return "; ".join(parts)
