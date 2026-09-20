"""YuNet + SFace, through OpenCV's own implementations.

    image -> YuNet (FaceDetectorYN)   -> boxes + 5 landmarks + scores
          -> SFace  (alignCrop)       -> 112x112 warped crop
          -> SFace  (feature)         -> raw 128-d vector
          -> L2 normalise             -> the template we store and compare

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
   cosine distance and quietly wrong under inner-product or L2. ``embed``
   normalises before returning; a test asserts it.

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

import numpy as np

from app.models.base import AlignedFace, DetectionResult, FaceModelProvider
from app.models.model_files import SFACE, YUNET, verify_all
from app.schemas import (
    EMBEDDING_DIMENSION,
    BoundingBox,
    DetectedFace,
    DetectedFaceBox,
    FaceLandmarks,
    FaceQualityAssessment,
    FaceQualityMetric,
    FaceQualityMetrics,
    FaceQualityReason,
    Point,
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
    #: order or normalisation. "1" is this pipeline's first definition.
    preprocessing_version = "1"
    embedding_dim = EMBEDDING_DIMENSION
    runtime = "opencv"
    #: STAYS "unclear". The weight licences are permissive (SFace Apache-2.0,
    #: YuNet MIT) but the training-data provenance behind the distributed SFace
    #: artefact is unresolved for commercial biometric use — see LICENSING.md.
    #: `config.py` refuses production traffic on anything but "permitted", and a
    #: test asserts no shipped backend claims it.
    commercial_use = "unclear"

    def __init__(
        self,
        model_dir: str | None = None,
        score_threshold: float = 0.6,
        nms_threshold: float = 0.3,
        top_k: int = 5000,
        min_face_pixels: int = 24,
    ) -> None:
        self._model_dir = model_dir
        # YuNet's own published defaults. Exposed as configuration rather than
        # constants because a classroom is not the benchmark these were tuned
        # on, and lowering the score threshold to catch a back row is a decision
        # an operator must be able to make and measure. THEY ARE NOT CALIBRATED
        # FOR THIS PRODUCT.
        self._score_threshold = score_threshold
        self._nms_threshold = nms_threshold
        self._top_k = top_k
        # Faces below this are refused for *enrolment*, where a bad template is
        # permanent. Detection reports them; it is the enrolment gate that
        # cares. Configurable for the same reason as above.
        self._min_face_pixels = min_face_pixels
        self._detector = None
        self._recognizer = None
        self._detector_input_size: tuple[int, int] | None = None

    # -- lifecycle ----------------------------------------------------------

    def load(self) -> None:
        """Verify the artefacts, build both OpenCV models, then warm them.

        Every failure here is a startup failure, which is the point: a missing
        file, a tampered artefact or a broken OpenCV build must fail the
        container's health check rather than a student's enrolment.
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

        import cv2

        self._detector = cv2.FaceDetectorYN.create(
            model=str(paths["detector"]),
            config="",
            # Replaced per image by `setInputSize`. YuNet's anchor grid is
            # derived from the input size, so it must match the frame actually
            # being scored; this is only a construction-time placeholder.
            input_size=(320, 320),
            score_threshold=self._score_threshold,
            nms_threshold=self._nms_threshold,
            top_k=self._top_k,
        )
        self._recognizer = cv2.FaceRecognizerSF.create(
            model=str(paths["recognizer"]),
            config="",
        )
        self._warmup()

    def _warmup(self) -> None:
        """Run one inference of each network on a synthetic frame.

        The first ``detect``/``feature`` call pays lazy allocation and graph
        setup. Doing it here moves that cost off the first classroom capture,
        where a teacher is standing in front of a room waiting.

        A flat grey frame, not a face: this is about allocating buffers, and the
        result is discarded.
        """
        blank = np.full((ALIGNED_SIZE, ALIGNED_SIZE, 3), 128, dtype=np.uint8)
        assert self._detector is not None and self._recognizer is not None
        self._detector.setInputSize((ALIGNED_SIZE, ALIGNED_SIZE))
        self._detector.detect(blank)
        self._detector_input_size = (ALIGNED_SIZE, ALIGNED_SIZE)
        self._recognizer.feature(blank)

    def unload(self) -> None:
        self._detector = None
        self._recognizer = None
        self._detector_input_size = None

    # -- decoding -----------------------------------------------------------

    @staticmethod
    def _decode(image_base64: str) -> np.ndarray:
        """base64 -> BGR uint8 array.

        BGR because that is what OpenCV produces and what both models expect
        (SFace's own preprocessing does the BGR->RGB swap internally, inside
        ``feature``). Converting here would double-swap and degrade every
        embedding in a way nothing would report.
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

    def _require_loaded(self):
        if self._detector is None or self._recognizer is None:
            raise ModelNotLoadedError(
                "The opencv backend was used before load() completed."
            )
        return self._detector, self._recognizer

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
        detector, _ = self._require_loaded()
        height, width = image.shape[:2]
        size = (int(width), int(height))
        # YuNet builds its anchor grid from the declared input size, so it must
        # equal the frame being scored or every box lands in the wrong place.
        # Cached because setInputSize rebuilds that grid, and a three-capture
        # classroom request is three frames of identical size.
        if self._detector_input_size != size:
            detector.setInputSize(size)
            self._detector_input_size = size

        _, faces = detector.detect(image)
        if faces is None:
            return np.empty((0, 15), dtype=np.float32)
        rows = np.asarray(faces, dtype=np.float32)
        if rows.ndim != 2 or rows.shape[1] < 15:
            # A malformed detector result must not be interpreted. Returning
            # "no faces" is the conservative answer: it routes every student to
            # review rather than inventing a match.
            return np.empty((0, 15), dtype=np.float32)
        return rows

    def detect(self, image_base64: str) -> DetectionResult:
        image = self._decode(image_base64)
        rows = self._detect_rows(image)
        height, width = image.shape[:2]

        faces: list[DetectedFaceBox] = []
        for index, row in enumerate(rows):
            box = self._box_from_row(row, width, height)
            if box is None:
                continue
            faces.append(
                DetectedFaceBox(
                    faceId=index,
                    boundingBox=box,
                    # Clamped: the contract promises [0, 1], and a detector that
                    # returns a hair over 1.0 must not leak that upward into a
                    # confidence the rest of the system compares against a
                    # threshold.
                    detectionConfidence=float(min(max(row[14], 0.0), 1.0)),
                    landmarks=self._landmarks_from_row(row),
                )
            )
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

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        """Judge a single-subject image for enrolment.

        Only what is actually measured is reported. Blur (variance of the
        Laplacian), brightness (mean luminance) and face size are computed here;
        pose and occlusion are not, and are reported ``unavailable`` rather than
        given a plausible number an operator might tune against.

        The two thresholds that reject — minimum face pixels, and the blur and
        brightness bounds — are conservative and configurable. They are NOT
        calibrated against classroom data.
        """
        import cv2

        try:
            image = self._decode(image_base64)
        except ImageDecodeError as error:
            return FaceQualityAssessment(
                reason="low_quality",
                qualityScore=0.0,
                faceCount=0,
                metrics=FaceQualityMetrics.all_unavailable(),
                detail=str(error),
            )

        rows = self._detect_rows(image)
        face_count = int(rows.shape[0])

        if face_count == 0:
            return self._quality(
                "no_face", 0.0, 0, None, None, None, "No face was found in the image."
            )
        if face_count > 1:
            return self._quality(
                "multiple_faces",
                0.0,
                face_count,
                None,
                None,
                None,
                f"{face_count} faces were found; enrolment needs exactly one.",
            )

        row = rows[0]
        box = self._box_from_row(row, image.shape[1], image.shape[0])
        if box is None:
            return self._quality(
                "low_quality", 0.0, 1, None, None, None,
                "The detected face has no usable area.",
            )

        face_pixels = float(min(box.width, box.height))
        crop = image[
            int(box.y) : int(box.y + box.height), int(box.x) : int(box.x + box.width)
        ]
        grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.size else None
        blur = float(cv2.Laplacian(grey, cv2.CV_64F).var()) if grey is not None else 0.0
        brightness = float(grey.mean()) if grey is not None else 0.0
        confidence = float(min(max(row[14], 0.0), 1.0))

        if face_pixels < self._min_face_pixels:
            return self._quality(
                "face_too_small",
                confidence,
                1,
                blur,
                brightness,
                face_pixels,
                f"The face is {face_pixels:.0f}px across; at least "
                f"{self._min_face_pixels}px is required for a usable template.",
            )
        # Deliberately loose. These reject images that are obviously unusable —
        # a lens cap, a dark room — not images that are merely imperfect. A
        # tighter gate would refuse enrolments that would have worked, and the
        # numbers to set it correctly do not exist yet.
        if brightness < 25.0:
            return self._quality(
                "too_dark", confidence, 1, blur, brightness, face_pixels,
                "The face is too dark to enrol. Add light and retake.",
            )
        if blur < 10.0:
            return self._quality(
                "blurred", confidence, 1, blur, brightness, face_pixels,
                "The face is too blurred to enrol. Hold still and retake.",
            )

        return self._quality("ok", confidence, 1, blur, brightness, face_pixels, None)

    @staticmethod
    def _quality(
        reason: FaceQualityReason,
        score: float,
        face_count: int,
        blur: float | None,
        brightness: float | None,
        face_pixels: float | None,
        detail: str | None,
    ) -> FaceQualityAssessment:
        return FaceQualityAssessment(
            reason=reason,
            qualityScore=score,
            faceCount=face_count,
            metrics=FaceQualityMetrics(
                blur=(
                    FaceQualityMetric.measured(blur, "laplacian_variance")
                    if blur is not None
                    else FaceQualityMetric.unavailable()
                ),
                brightness=(
                    FaceQualityMetric.measured(brightness, "mean_luminance_0_255")
                    if brightness is not None
                    else FaceQualityMetric.unavailable()
                ),
                faceSize=(
                    FaceQualityMetric.measured(face_pixels, "pixels")
                    if face_pixels is not None
                    else FaceQualityMetric.unavailable()
                ),
                # Not measured. Reporting a number here would be inventing one.
                pose=FaceQualityMetric.unavailable(),
                occlusion=FaceQualityMetric.unavailable(),
            ),
            detail=detail,
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

        _, recognizer = self._require_loaded()

        if landmarks is None or bounding_box is None:
            rows = self._detect_rows(image)
            if rows.shape[0] > 0:
                row = rows[0]
                found_box = self._box_from_row(row, image.shape[1], image.shape[0])
                if found_box is not None:
                    landmarks = landmarks or self._landmarks_from_row(row)
                    bounding_box = bounding_box or found_box

        if landmarks is not None and bounding_box is not None:
            row = self._row_for_align(bounding_box, landmarks)
            aligned = recognizer.alignCrop(image, row)
            if aligned is None or aligned.size == 0:
                raise ImageDecodeError("Alignment produced an empty crop.")
            return aligned, True

        if bounding_box is not None:
            x0 = max(0, int(bounding_box.x))
            y0 = max(0, int(bounding_box.y))
            x1 = min(image.shape[1], int(bounding_box.x + bounding_box.width))
            y1 = min(image.shape[0], int(bounding_box.y + bounding_box.height))
            crop = image[y0:y1, x0:x1]
            if crop.size == 0:
                raise ImageDecodeError("The bounding box does not overlap the image.")
            resized = cv2.resize(
                crop, (ALIGNED_SIZE, ALIGNED_SIZE), interpolation=cv2.INTER_LINEAR
            )
            return resized, False

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

    def _embed_crop(self, crop: np.ndarray) -> list[float]:
        """One 112x112 BGR crop -> one L2-normalised 128-d vector.

        ``feature`` performs SFace's own preprocessing internally —
        ``blobFromImage(crop, scalefactor=1, size=(112,112), mean=(0,0,0),
        swapRB=true, crop=false)``. That is: raw 0-255 values, no mean
        subtraction, BGR->RGB. Doing any of it here as well would double-apply
        it; this is why ``_decode`` keeps the image in BGR.
        """
        _, recognizer = self._require_loaded()
        raw = recognizer.feature(crop)
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
        # SFace does NOT emit unit vectors — measured norms on this artefact run
        # ~2.3-5.1. The contract in base.py promises normalised embeddings, and
        # pgvector stores what we give it, so this is the line that makes a
        # stored template comparable under cosine similarity.
        return (vector / norm).tolist()

    def embed(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None = None,
        landmarks: FaceLandmarks | None = None,
    ) -> list[float]:
        image = self._decode(image_base64)
        crop, _ = self._aligned_crop(image, bounding_box, landmarks)
        return self._embed_crop(crop)

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        """The classroom path: every face in one frame, each embedded.

        Faces are embedded independently and keep their own box, landmarks and
        confidence. No cross-face or cross-image reasoning happens here —
        deduplicating a student seen in two captures belongs to
        ``modules/recognition-engine`` in apps/web, which has the cohort and the
        policy. This service stays stateless.
        """
        frame = self._decode(image.image_base64)
        rows = self._detect_rows(frame)
        height, width = frame.shape[:2]

        faces: list[DetectedFace] = []
        for row in rows:
            box = self._box_from_row(row, width, height)
            if box is None:
                continue
            landmarks = self._landmarks_from_row(row)
            try:
                crop, aligned = self._aligned_crop(frame, box, landmarks)
                embedding = self._embed_crop(crop)
            except (ImageDecodeError, ModelNotLoadedError):
                # One unusable face must not fail a whole classroom capture.
                # Dropping it means that student is not recognised and lands in
                # review — which is the safe direction. Marking them present is
                # the outcome that would be unacceptable.
                continue
            faces.append(
                DetectedFace(
                    sequenceNumber=image.sequence_number,
                    boundingBox=box,
                    embedding=embedding,
                    detectionConfidence=float(min(max(row[14], 0.0), 1.0)),
                    # Detector confidence, reported as the per-face quality
                    # score. The contract requires a number here; this is a
                    # real measurement rather than an invented one, and the
                    # richer per-metric detail lives on `assess_quality`.
                    qualityScore=float(min(max(row[14], 0.0), 1.0)),
                    landmarks=landmarks,
                    aligned=aligned,
                )
            )
        return faces
