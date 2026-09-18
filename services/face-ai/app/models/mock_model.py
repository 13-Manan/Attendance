"""Deterministic stand-in backend. Never a production recogniser.

Exists so the whole contract — enrolment, quality rejection, detection,
matching, provenance — is exercisable end-to-end (browser -> apps/web ->
services/face-ai) without bundling any real model or inheriting its licensing
obligations. See LICENSING.md before wiring in real weights.

Embeddings are a hash of the image bytes, so the same image always yields the
same vector and two different images essentially never match. That is enough
to drive the plumbing and is deliberately useless for recognising anyone.

Quality outcomes are simulated from well-known ``imageBase64`` prefixes
("NO_FACE:", "MULTI:", "BLUR:", "DARK:", "SMALL:", "OCCLUDED:", "ANGLE:",
"LOW:") so every rejection branch has a reproducible trigger. A real backend
replaces this with actual scoring while keeping the same
``FaceQualityAssessment`` vocabulary.
"""

import hashlib

import numpy as np

from app.models.base import AlignedFace, DetectionResult, FaceModelProvider
from app.schemas import (
    EMBEDDING_DIMENSION,
    BoundingBox,
    DetectedFace,
    DetectedFaceBox,
    FaceLandmarks,
    FaceQualityAssessment,
    FaceQualityMetrics,
    FaceQualityReason,
    Point,
    SessionImageInput,
)

EMBEDDING_DIM = EMBEDDING_DIMENSION

# The mock reports a fixed synthetic frame size; a real adapter decodes the
# image and reports its true dimensions.
_MOCK_IMAGE_WIDTH = 640
_MOCK_IMAGE_HEIGHT = 480

_REASON_PREFIXES: dict[str, FaceQualityReason] = {
    "NO_FACE:": "no_face",
    "MULTI:": "multiple_faces",
    "SMALL:": "face_too_small",
    "BLUR:": "blurred",
    "DARK:": "too_dark",
    "OCCLUDED:": "occluded",
    "ANGLE:": "bad_angle",
    "LOW:": "low_quality",
}

# Every other rejection reason still describes exactly one face — it is the
# face that is blurred, dark or occluded.
_FACE_COUNTS: dict[FaceQualityReason, int] = {"no_face": 0, "multiple_faces": 2}


def _classify(image_base64: str) -> tuple[FaceQualityReason, int, float]:
    """Deterministic classification of the mock's simulated quality outcome.
    Returns (reason, face_count, quality_score). Kept private — real
    backends produce these from an actual model, not from a prefix."""
    for prefix, reason in _REASON_PREFIXES.items():
        if image_base64.startswith(prefix):
            face_count = _FACE_COUNTS.get(reason, 1)
            return reason, face_count, 0.1
    return "ok", 1, 0.9


def _embed_from_bytes(image_base64: str) -> list[float]:
    digest = hashlib.sha256(image_base64.encode("utf-8")).digest()
    seed = int.from_bytes(digest[:8], "big")
    rng = np.random.default_rng(seed)
    vector = rng.normal(size=EMBEDDING_DIM)
    vector = vector / np.linalg.norm(vector)
    return vector.tolist()


def _box(x: float, y: float) -> BoundingBox:
    return BoundingBox(x=x, y=y, width=128.0, height=128.0)


def _landmarks_for(box: BoundingBox) -> FaceLandmarks:
    """Synthetic but geometrically plausible 5-point landmarks inside the box,
    so downstream alignment code has real coordinates to exercise."""
    x, y, w, h = box.x, box.y, box.width, box.height
    return FaceLandmarks(
        leftEye=Point(x=x + w * 0.30, y=y + h * 0.40),
        rightEye=Point(x=x + w * 0.70, y=y + h * 0.40),
        noseTip=Point(x=x + w * 0.50, y=y + h * 0.58),
        mouthLeft=Point(x=x + w * 0.35, y=y + h * 0.76),
        mouthRight=Point(x=x + w * 0.65, y=y + h * 0.76),
    )


class MockEmbeddingModel(FaceModelProvider):
    name = "mock"
    weights_version = "0.1.0"
    preprocessing_version = "1"
    embedding_dim = EMBEDDING_DIM
    runtime = "numpy-hash-stub"
    # No weights exist, so no weights licence applies — and this backend must
    # never serve production recognition regardless.
    commercial_use = "not-applicable"

    def load(self) -> None:
        return None

    def detect(self, image_base64: str) -> DetectionResult:
        reason, face_count, _ = _classify(image_base64)
        if reason == "no_face":
            return DetectionResult(
                faces=[],
                image_width=_MOCK_IMAGE_WIDTH,
                image_height=_MOCK_IMAGE_HEIGHT,
            )
        boxes = [_box(64.0, 64.0)]
        if face_count > 1:
            boxes.append(_box(320.0, 64.0))
        faces = [
            DetectedFaceBox(
                faceId=index,
                boundingBox=box,
                detectionConfidence=0.99,
                landmarks=_landmarks_for(box),
            )
            for index, box in enumerate(boxes)
        ]
        return DetectionResult(
            faces=faces,
            image_width=_MOCK_IMAGE_WIDTH,
            image_height=_MOCK_IMAGE_HEIGHT,
        )

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        reason, face_count, quality_score = _classify(image_base64)
        return FaceQualityAssessment(
            reason=reason,
            qualityScore=quality_score,
            faceCount=face_count,
            # The mock measures nothing. Reporting every metric as
            # unavailable is the honest answer and is exactly what a real
            # backend must do for metrics it has not implemented.
            metrics=FaceQualityMetrics.all_unavailable(),
        )

    def align(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None,
        landmarks: FaceLandmarks | None,
    ) -> AlignedFace:
        # There is no image decoding here, so there is nothing to warp. The
        # mock reports aligned=True only when it was given the landmarks a
        # real alignment would have required, so callers exercise both paths.
        return AlignedFace(image_base64=image_base64, aligned=landmarks is not None)

    def embed(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None = None,
        landmarks: FaceLandmarks | None = None,
    ) -> list[float]:
        # Box and landmarks are accepted but cannot affect the result: the
        # hash seed already stabilises the vector across calls.
        return _embed_from_bytes(image_base64)

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        detection = self.detect(image.image_base64)
        return [
            DetectedFace(
                sequenceNumber=image.sequence_number,
                boundingBox=face.bounding_box,
                embedding=_embed_from_bytes(
                    f"{image.image_base64}#{face.face_id}"
                    if face.face_id
                    else image.image_base64
                ),
                detectionConfidence=face.detection_confidence,
                qualityScore=0.9,
                landmarks=face.landmarks,
                aligned=face.landmarks is not None,
            )
            for face in detection.faces
        ]
