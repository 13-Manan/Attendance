"""The staged provider, driven by fake stages.

``OpenCVFaceModelProvider`` is assembled from a detector, an aligner and an
embedder. Standing fakes in for all three exercises everything the provider
itself decides — which faces are embedded, which are rejected and why, which
are flagged, how many inference calls a group photo costs, what enrolment
refuses — with no model weights and no photograph of anybody.

The fake embedder derives each vector from the crop it is handed, so "two
faces produced two different vectors" and "a face produced the vector for its
own crop" are both checkable. It says nothing about recognition accuracy;
that is bench/calibrate_quality.py's job, against a corpus outside the repo.
"""

from __future__ import annotations

import base64
import hashlib

import numpy as np
import pytest

from app.models.opencv_provider import (
    ImageDecodeError,
    ModelNotLoadedError,
    OpenCVFaceModelProvider,
    SFaceAligner,
    SFaceEmbedder,
    YuNetDetector,
)
from app.models.pipeline import AlignedCrop, RawDetection, StageDescriptor
from app.quality import GROUP_PROFILE, MIN_EMBEDDABLE_FACE_PX
from app.schemas import (
    EMBEDDING_DIMENSION,
    BoundingBox,
    FaceLandmarks,
    Point,
    SessionImageInput,
)

cv2 = pytest.importorskip("cv2", reason="opencv-python-headless is required")


# ---------------------------------------------------------------------------
# Fake stages
# ---------------------------------------------------------------------------


def _face(x: float, y: float, size: float, score: float = 0.95) -> RawDetection:
    """A frontal face of ``size`` px at (x, y), landmarks in proportion."""
    s = size / 200.0

    def pt(px: float, py: float) -> Point:
        return Point(x=x + px * s, y=y + py * s)

    return RawDetection(
        box=BoundingBox(x=x, y=y, width=size, height=size),
        score=score,
        landmarks=FaceLandmarks(
            rightEye=pt(65, 70),
            leftEye=pt(135, 70),
            noseTip=pt(100, 117),
            mouthRight=pt(72, 150),
            mouthLeft=pt(128, 150),
        ),
    )


class FakeDetector:
    descriptor = YuNetDetector.descriptor

    def __init__(self, faces: list[RawDetection]):
        self.faces = faces

    def load(self):
        return None

    def detect_frame(self, frame):
        return list(self.faces)


class FakeAligner:
    """Textured crop seeded by the face position, so each face is distinct.
    Faces listed in ``blurred`` come back smoothed; ``failing`` raise."""

    descriptor = SFaceAligner.descriptor
    output_size = 112

    def __init__(self, blurred=(), failing=()):
        self.blurred = set(blurred)
        self.failing = set(failing)

    def load(self):
        return None

    def align_frame(self, frame, box, landmarks):
        key = (int(box.x), int(box.y))
        if key in self.failing:
            raise ImageDecodeError("Alignment produced an empty crop.")
        rng = np.random.default_rng(key[0] * 10007 + key[1])
        crop = rng.integers(70, 190, (112, 112, 3)).astype(np.uint8)
        if key in self.blurred:
            crop = cv2.GaussianBlur(crop, (0, 0), 6)
        return AlignedCrop(crop=crop, aligned=landmarks is not None)


class FakeEmbedder:
    """A vector derived from the crop's bytes; ``zero_for`` crops whose first
    pixel equals a value produce a zero vector (an unusable embedding)."""

    descriptor = SFaceEmbedder.descriptor

    def __init__(self, zero_first_pixel: int | None = None):
        self.calls: list[int] = []
        self.zero_first_pixel = zero_first_pixel

    def load(self):
        return None

    def embed_crops(self, crops):
        self.calls.append(len(crops))
        rows = []
        for crop in crops:
            if (
                self.zero_first_pixel is not None
                and int(crop[0, 0, 0]) == self.zero_first_pixel
            ):
                rows.append(np.zeros(EMBEDDING_DIMENSION, np.float32))
                continue
            seed = int.from_bytes(hashlib.sha256(crop.tobytes()).digest()[:8], "big")
            rows.append(
                np.random.default_rng(seed)
                .normal(size=EMBEDDING_DIMENSION)
                .astype(np.float32)
                * 3.7  # SFace's raw output is not unit length either
            )
        return (
            np.stack(rows) if rows else np.empty((0, EMBEDDING_DIMENSION), np.float32)
        )


def provider_with(detector, aligner=None, embedder=None) -> OpenCVFaceModelProvider:
    p = OpenCVFaceModelProvider()
    p.detector = detector
    p.aligner = aligner or FakeAligner()
    p.embedder = embedder or FakeEmbedder()
    return p


def frame_b64(width: int = 1280, height: int = 960) -> str:
    array = np.full((height, width, 3), 128, np.uint8)
    return base64.b64encode(cv2.imencode(".png", array)[1].tobytes()).decode()


FRAME = frame_b64()


def image(seq: int = 1) -> SessionImageInput:
    return SessionImageInput(sequenceNumber=seq, imageBase64=FRAME)


def grid(n: int, size: float = 90.0) -> list[RawDetection]:
    """n faces laid out in rows, like a classroom."""
    per_row = 8
    return [
        _face(20 + (i % per_row) * 150, 20 + (i // per_row) * 150, size)
        for i in range(n)
    ]


# ===========================================================================
# Group photos
# ===========================================================================


def test_every_face_in_a_group_photo_is_embedded_independently():
    p = provider_with(FakeDetector(grid(6)))
    result = p.analyze_image(image(seq=2))
    assert len(result.faces) == 6
    assert result.rejected == []
    vectors = np.array([f.embedding for f in result.faces])
    # Unit length, and six different vectors — no face borrowed another's.
    assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0)
    assert len({tuple(np.round(v, 6)) for v in vectors}) == 6
    assert {f.sequence_number for f in result.faces} == {2}
    assert [f.bounding_box for f in result.faces] == [d.box for d in grid(6)]


def test_a_group_photo_costs_one_batched_embedding_call():
    embedder = FakeEmbedder()
    p = provider_with(FakeDetector(grid(40)), embedder=embedder)
    result = p.analyze_image(image())
    assert len(result.faces) == 40
    assert embedder.calls == [40]


def test_a_photo_with_no_faces_returns_nothing_and_says_so():
    p = provider_with(FakeDetector([]))
    result = p.analyze_image(image())
    assert result.faces == [] and result.rejected == []
    assert result.summary.detected_faces == 0
    assert result.summary.image_width == 1280


def test_a_face_too_small_to_embed_is_reported_not_dropped():
    tiny = _face(900, 700, MIN_EMBEDDABLE_FACE_PX - 4)
    p = provider_with(FakeDetector([*grid(3), tiny]))
    result = p.analyze_image(image())
    assert len(result.faces) == 3
    assert len(result.rejected) == 1
    assert result.rejected[0].reason == "face_too_small"
    assert result.rejected[0].face_size == pytest.approx(MIN_EMBEDDABLE_FACE_PX - 4)
    assert result.summary.detected_faces == 4
    assert result.summary.embedded_faces == 3
    assert result.summary.rejected_faces == 1


def test_a_small_but_embeddable_face_is_embedded_and_flagged():
    small = _face(900, 700, (MIN_EMBEDDABLE_FACE_PX + GROUP_PROFILE.min_face_px) / 2)
    p = provider_with(FakeDetector([small]))
    [face] = p.analyze_image(image()).faces
    assert face.quality_flags == ["face_too_small"]
    assert face.quality_score <= 0.49
    assert face.face_size == pytest.approx(small.box.width)


def test_a_blurred_face_is_embedded_but_flagged():
    faces = grid(2)
    blurred_key = (int(faces[1].box.x), int(faces[1].box.y))
    p = provider_with(FakeDetector(faces), aligner=FakeAligner(blurred=[blurred_key]))
    sharp, blurred = p.analyze_image(image()).faces
    assert sharp.quality_flags == []
    assert "blurred" in blurred.quality_flags
    assert blurred.quality_score < sharp.quality_score


def test_a_low_confidence_detection_is_flagged_as_possibly_occluded():
    weak = _face(20, 20, 90, score=GROUP_PROFILE.min_detection_confidence - 0.05)
    p = provider_with(FakeDetector([weak]))
    [face] = p.analyze_image(image()).faces
    assert "occluded" in face.quality_flags


def test_one_face_that_fails_alignment_does_not_fail_the_photo():
    faces = grid(3)
    bad = (int(faces[0].box.x), int(faces[0].box.y))
    p = provider_with(FakeDetector(faces), aligner=FakeAligner(failing=[bad]))
    result = p.analyze_image(image())
    assert len(result.faces) == 2
    assert [r.reason for r in result.rejected] == ["alignment_failed"]


def test_one_unusable_embedding_does_not_fail_the_photo():
    faces = grid(3)
    aligner = FakeAligner()
    first = aligner.align_frame(None, faces[1].box, faces[1].landmarks).crop
    p = provider_with(
        FakeDetector(faces),
        aligner=aligner,
        embedder=FakeEmbedder(zero_first_pixel=int(first[0, 0, 0])),
    )
    result = p.analyze_image(image())
    assert len(result.faces) + len(result.rejected) == 3
    assert "embedding_failed" in [r.reason for r in result.rejected]


def test_timings_are_reported_per_stage():
    p = provider_with(FakeDetector(grid(5)))
    t = p.analyze_image(image()).timings
    assert t.decode_ms >= 0 and t.detect_ms >= 0 and t.embed_ms >= 0
    assert t.align_ms >= 0 and t.quality_ms >= 0


def test_detect_and_embed_is_the_faces_of_analyze_image():
    p = provider_with(FakeDetector(grid(4)))
    assert p.detect_and_embed(image()) == p.analyze_image(image()).faces


def test_an_undecodable_image_raises_rather_than_returning_no_faces():
    p = provider_with(FakeDetector(grid(2)))
    with pytest.raises(ImageDecodeError):
        p.analyze_image(
            SessionImageInput(sequenceNumber=1, imageBase64="bm90LWFuLWltYWdl")
        )


def test_an_unloaded_provider_refuses():
    with pytest.raises(ModelNotLoadedError):
        OpenCVFaceModelProvider().analyze_image(image())


# ===========================================================================
# Enrolment
# ===========================================================================


def test_a_good_single_face_enrols_with_a_unit_vector():
    p = provider_with(FakeDetector([_face(400, 300, 300)]))
    outcome = p.enroll_image(FRAME)
    assert outcome.assessment.reason == "ok"
    assert outcome.assessment.reasons == []
    assert outcome.aligned is True
    assert abs(float(np.linalg.norm(outcome.embedding)) - 1.0) < 1e-9


def test_the_enrolment_vector_is_the_one_the_classroom_path_would_produce():
    # Same stages, same crop, same vector: a template and a probe of the same
    # image must be comparable, or nothing ever matches.
    face = _face(400, 300, 300)
    p = provider_with(FakeDetector([face]))
    enrolled = p.enroll_image(FRAME).embedding
    [probe] = p.analyze_image(image()).faces
    assert enrolled == probe.embedding


@pytest.mark.parametrize(
    "faces, reason",
    [
        ([], "no_face"),
        ([_face(100, 100, 300), _face(600, 100, 300)], "multiple_faces"),
        ([_face(400, 300, 40)], "face_too_small"),
        ([_face(400, 300, 300, score=0.5)], "occluded"),
    ],
)
def test_enrolment_refuses_and_returns_no_embedding(faces, reason):
    p = provider_with(FakeDetector(faces))
    outcome = p.enroll_image(FRAME)
    assert outcome.assessment.reason == reason
    assert outcome.embedding is None


def test_a_blurred_enrolment_is_refused():
    face = _face(400, 300, 300)
    p = provider_with(FakeDetector([face]), aligner=FakeAligner(blurred=[(400, 300)]))
    outcome = p.enroll_image(FRAME)
    assert outcome.assessment.reason == "blurred"
    assert outcome.embedding is None


def test_an_extreme_pose_is_refused_for_enrolment():
    face = _face(400, 300, 300)
    lm = face.landmarks
    turned = RawDetection(
        box=face.box,
        score=face.score,
        landmarks=lm.model_copy(
            update={"nose_tip": Point(x=lm.nose_tip.x + 110, y=lm.nose_tip.y)}
        ),
    )
    p = provider_with(FakeDetector([turned]))
    outcome = p.enroll_image(FRAME)
    assert "bad_angle" in outcome.assessment.reasons
    assert outcome.embedding is None


def test_invalid_base64_is_a_quality_refusal_not_a_crash():
    p = provider_with(FakeDetector([_face(400, 300, 300)]))
    outcome = p.enroll_image("%%%not base64%%%")
    assert outcome.assessment.reason == "low_quality"
    assert outcome.embedding is None


def test_assess_quality_reports_measured_metrics():
    p = provider_with(FakeDetector([_face(400, 300, 300)]))
    metrics = p.assess_quality(FRAME).metrics
    assert metrics.blur.status == "measured"
    assert metrics.yaw is not None and metrics.yaw.status == "measured"
    assert metrics.occlusion.status == "unavailable"


# ===========================================================================
# Provenance
# ===========================================================================


def test_the_pipeline_describes_every_stage():
    info = OpenCVFaceModelProvider().model_info()
    roles = [s.role for s in info.stages]
    assert roles == ["detector", "aligner", "embedder", "matcher"]
    embedder = info.stages[2]
    assert embedder.embedding_dim == EMBEDDING_DIMENSION
    assert "batch" in embedder.capabilities


def test_yunet_sface_is_not_production_eligible():
    info = OpenCVFaceModelProvider().model_info()
    assert info.production_eligible is False
    by_role = {s.role: s for s in info.stages}
    assert by_role["detector"].commercial_use == "unclear"
    assert by_role["embedder"].commercial_use == "unclear"
    assert not by_role["detector"].production_ready
    assert not by_role["embedder"].production_ready


def test_one_unapproved_stage_makes_the_whole_pipeline_ineligible():
    class Cleared(OpenCVFaceModelProvider):
        commercial_use = "permitted"

    # Headline status says permitted; the detector does not. Ineligible.
    assert Cleared().production_eligible is False

    class AllCleared(Cleared):
        def stage_descriptors(self):
            return tuple(
                StageDescriptor(**{**d.__dict__, "commercial_use": "permitted"})
                if d.commercial_use == "unclear"
                else d
                for d in super().stage_descriptors()
            )

    assert AllCleared().production_eligible is True


# ===========================================================================
# Detection downscale
# ===========================================================================


class _StubYuNet:
    def __init__(self, rows):
        self.rows = rows
        self.sizes = []

    def setInputSize(self, size):
        self.sizes.append(size)

    def detect(self, frame):
        return 1, self.rows


def test_a_large_frame_is_detected_downscaled_and_mapped_back():
    detector = YuNetDetector(None, 0.6, 0.3, 5000, max_detection_edge=1000)
    row = np.array([[100, 50, 40, 40, *range(10), 0.9]], dtype=np.float32)
    detector._detector = _StubYuNet(row.copy())
    out = detector.rows(np.zeros((1000, 2000, 3), np.uint8))
    assert detector._detector.sizes == [(1000, 500)]
    # Coordinates double back into the full frame; the score is untouched.
    assert out[0, :4].tolist() == [200, 100, 80, 80]
    assert out[0, 4:14].tolist() == [2 * v for v in range(10)]
    assert out[0, 14] == pytest.approx(0.9)


def test_a_frame_within_the_limit_is_not_resized():
    detector = YuNetDetector(None, 0.6, 0.3, 5000, max_detection_edge=1920)
    row = np.array([[100, 50, 40, 40, *range(10), 0.9]], dtype=np.float32)
    detector._detector = _StubYuNet(row.copy())
    out = detector.rows(np.zeros((960, 1280, 3), np.uint8))
    assert detector._detector.sizes == [(1280, 960)]
    assert out[0, :4].tolist() == [100, 50, 40, 40]
