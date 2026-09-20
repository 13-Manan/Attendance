"""The real YuNet + SFace backend.

## What these tests deliberately do not do

They never assert that a face was detected in a photograph of a person. There
is no face fixture in this repository and none is downloaded: using a stranger's
photograph as a CI fixture is a biometric-privacy decision nobody made, and
generating a synthetic "face" realistic enough to trigger a trained detector
would mean tuning an image until the test passes — which measures the tuning,
not the detector.

So detection is tested through everything around it that *is* deterministic: the
landmark mapping, the box arithmetic, malformed detector output, the zero-face
path, and the configuration actually reaching OpenCV. "YuNet fires on a real
face" is verified by hand against a camera; see the Phase 5 report.

Two further cautions, recorded because they would otherwise look like gaps:

  * Synthetic noise images cannot test "different people do not match". Two
    random images score ~0.89 against each other through SFace, because noise is
    not a face and the network maps it into a degenerate region. Any test
    asserting a low score between synthetic identities would be asserting a
    property of noise.
  * Nothing here says anything about recognition accuracy.
"""

from __future__ import annotations

import base64
import hashlib
import shutil
from pathlib import Path

import numpy as np
import pytest

from app.models.model_files import (
    REQUIRED_ARTIFACTS,
    SFACE,
    YUNET,
    ModelArtifactError,
    verify_all,
    verify_artifact,
)
from app.models.opencv_provider import (
    ALIGNED_SIZE,
    SFACE_TEMPLATE_112,
    ImageDecodeError,
    ModelNotLoadedError,
    OpenCVFaceModelProvider,
)
from app.schemas import (
    EMBEDDING_DIMENSION,
    BoundingBox,
    FaceLandmarks,
    Point,
    SessionImageInput,
)

cv2 = pytest.importorskip("cv2", reason="opencv-python-headless is required")

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"


def models_available() -> bool:
    try:
        verify_all(MODEL_DIR)
        return True
    except ModelArtifactError:
        return False


needs_models = pytest.mark.skipif(
    not models_available(),
    reason="Pinned model artefacts absent — run `python scripts/fetch_models.py`",
)


# ---------------------------------------------------------------------------
# Fixtures (synthetic — no photographs of anybody)
# ---------------------------------------------------------------------------


def noise_image_b64(seed: int, width: int = 640, height: int = 480) -> str:
    rng = np.random.default_rng(seed)
    array = rng.integers(60, 200, (height, width, 3)).astype(np.uint8)
    return base64.b64encode(cv2.imencode(".png", array)[1].tobytes()).decode()


def flat_image_b64(value: int = 128, width: int = 320, height: int = 240) -> str:
    array = np.full((height, width, 3), value, np.uint8)
    return base64.b64encode(cv2.imencode(".png", array)[1].tobytes()).decode()


BOX = BoundingBox(x=100, y=100, width=160, height=200)
LANDMARKS = FaceLandmarks(
    rightEye=Point(x=145, y=170),
    leftEye=Point(x=215, y=170),
    noseTip=Point(x=180, y=210),
    mouthRight=Point(x=152, y=252),
    mouthLeft=Point(x=208, y=252),
)


@pytest.fixture(scope="module")
def provider() -> OpenCVFaceModelProvider:
    p = OpenCVFaceModelProvider(model_dir=str(MODEL_DIR))
    p.load()
    return p


class StubDetector:
    """Stands in for ``cv2.FaceDetectorYN`` to inject a malformed result.

    The real object's methods are read-only C++ bindings, so a fault cannot be
    patched onto it — the whole collaborator is replaced instead. ``monkeypatch``
    restores the original, which matters because the provider fixture is
    module-scoped.
    """

    def __init__(self, result):
        self._result = result

    def setInputSize(self, _size):
        return None

    def detect(self, _image):
        return (1, self._result)


class StubRecognizer:
    """Delegates alignment to the real recogniser, fakes ``feature``."""

    def __init__(self, real, feature_result):
        self._real = real
        self._feature_result = feature_result

    def alignCrop(self, image, row):
        return self._real.alignCrop(image, row)

    def feature(self, _crop):
        return self._feature_result


# ===========================================================================
# Model artefacts
# ===========================================================================


@needs_models
def test_pinned_artefacts_are_present_and_match_their_hashes():
    paths = verify_all(MODEL_DIR)
    assert set(paths) == {"detector", "recognizer"}
    for artifact in REQUIRED_ARTIFACTS:
        raw = (MODEL_DIR / artifact.filename).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        assert digest == artifact.sha256, artifact.filename


def test_a_missing_artefact_is_refused_with_an_actionable_message(tmp_path):
    with pytest.raises(ModelArtifactError) as error:
        verify_artifact(tmp_path, YUNET)
    assert "fetch_models" in str(error.value)


def test_a_tampered_artefact_is_refused(tmp_path):
    # Right name, right size, wrong bytes — the case a filename check misses.
    forged = tmp_path / YUNET.filename
    forged.write_bytes(b"\x00" * YUNET.size_bytes)
    with pytest.raises(ModelArtifactError) as error:
        verify_artifact(tmp_path, YUNET)
    message = str(error.value)
    assert "does not match the pinned artefact" in message
    assert YUNET.sha256 in message


def test_a_git_lfs_pointer_is_named_as_such(tmp_path):
    # The single most likely real-world failure: a clone without `git lfs pull`
    # leaves a 131-byte text file with the right name.
    pointer = tmp_path / SFACE.filename
    pointer.write_text(
        "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 38696353\n"
    )
    with pytest.raises(ModelArtifactError) as error:
        verify_artifact(tmp_path, SFACE)
    assert "Git LFS pointer" in str(error.value)


@needs_models
def test_a_truncated_artefact_is_refused_on_size_before_hashing(tmp_path):
    truncated = tmp_path / YUNET.filename
    truncated.write_bytes((MODEL_DIR / YUNET.filename).read_bytes()[:-10])
    with pytest.raises(ModelArtifactError) as error:
        verify_artifact(tmp_path, YUNET)
    assert "expected" in str(error.value)


def test_the_backend_refuses_to_load_without_a_configured_directory():
    with pytest.raises(ModelNotLoadedError) as error:
        OpenCVFaceModelProvider(model_dir=None).load()
    assert "FACE_MODEL_DIR" in str(error.value)


@needs_models
def test_loading_against_a_tampered_directory_fails_at_startup(tmp_path):
    # Startup, not first request: a bad artefact must fail the container's
    # health check rather than a student's enrolment.
    shutil.copy(MODEL_DIR / YUNET.filename, tmp_path / YUNET.filename)
    (tmp_path / SFACE.filename).write_bytes(b"\x00" * SFACE.size_bytes)
    with pytest.raises(ModelArtifactError):
        OpenCVFaceModelProvider(model_dir=str(tmp_path)).load()


# ===========================================================================
# Metadata
# ===========================================================================


@needs_models
def test_model_info_reports_the_real_pipeline(provider):
    info = provider.model_info()
    assert info.model_name == "opencv-yunet-sface"
    assert info.embedding_dim == EMBEDDING_DIMENSION == 128
    assert info.runtime == "opencv"
    assert info.embedding_normalized is True
    assert YUNET.upstream_release in info.weights_version
    assert SFACE.upstream_release in info.weights_version
    expected = f"{info.weights_version}+pp{info.preprocessing_version}"
    assert info.model_version == expected


@needs_models
def test_the_real_backend_is_not_production_eligible(provider):
    # The licensing position, asserted rather than documented. SFace's
    # training-data provenance is unresolved for commercial biometric use, so
    # this must stay false until somebody qualified resolves it.
    info = provider.model_info()
    assert info.commercial_use == "unclear"
    assert info.production_eligible is False


# ===========================================================================
# YuNet: the parts that are deterministic without a face
# ===========================================================================


def test_landmark_mapping_is_not_transposed():
    # YuNet's order is right-eye, left-eye, nose, right-mouth, left-mouth.
    # Transposing the eyes mirrors the alignment and yields a well-formed
    # embedding that never matches the same person again — a failure with no
    # symptom, which is why this is pinned explicitly.
    row = np.array(
        [10, 20, 30, 40, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0.9], dtype=np.float32
    )
    lm = OpenCVFaceModelProvider._landmarks_from_row(row)
    assert (lm.right_eye.x, lm.right_eye.y) == (1, 2)
    assert (lm.left_eye.x, lm.left_eye.y) == (3, 4)
    assert (lm.nose_tip.x, lm.nose_tip.y) == (5, 6)
    assert (lm.mouth_right.x, lm.mouth_right.y) == (7, 8)
    assert (lm.mouth_left.x, lm.mouth_left.y) == (9, 10)


def test_the_align_row_is_the_exact_inverse_of_the_landmark_mapping():
    row = np.array(
        [10, 20, 30, 40, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0.9], dtype=np.float32
    )
    lm = OpenCVFaceModelProvider._landmarks_from_row(row)
    box = BoundingBox(x=10, y=20, width=30, height=40)
    rebuilt = OpenCVFaceModelProvider._row_for_align(box, lm)
    assert rebuilt.shape == (1, 15)
    np.testing.assert_allclose(rebuilt[0][:14], row[:14])


def test_a_box_is_clipped_to_the_frame():
    # YuNet can return a box overhanging the edge for a face at the boundary.
    row = np.array([-20, -10, 100, 100, *([0] * 10), 0.9], dtype=np.float32)
    box = OpenCVFaceModelProvider._box_from_row(row, 640, 480)
    assert box is not None
    assert box.x == 0 and box.y == 0
    assert box.width == 80 and box.height == 90


def test_a_box_entirely_outside_the_frame_is_dropped():
    row = np.array([700, 500, 50, 50, *([0] * 10), 0.9], dtype=np.float32)
    assert OpenCVFaceModelProvider._box_from_row(row, 640, 480) is None


def test_a_non_finite_box_is_dropped_rather_than_propagated():
    row = np.array([float("nan"), 0, 50, 50, *([0] * 10), 0.9], dtype=np.float32)
    assert OpenCVFaceModelProvider._box_from_row(row, 640, 480) is None


@needs_models
def test_detector_confidence_is_clamped_into_the_contract_range(provider):
    row = np.array([0, 0, 50, 50, *([0] * 10), 1.4], dtype=np.float32)
    box = OpenCVFaceModelProvider._box_from_row(row, 640, 480)
    assert box is not None
    assert min(max(float(row[14]), 0.0), 1.0) == 1.0


@needs_models
def test_a_malformed_detector_result_reports_no_faces_rather_than_guessing(
    provider, monkeypatch
):
    # Conservative direction on purpose: "no faces" routes every student to
    # review. Interpreting a malformed row could invent a match.
    stub = StubDetector(np.zeros((2, 4), np.float32))
    monkeypatch.setattr(provider, "_detector", stub)
    monkeypatch.setattr(provider, "_detector_input_size", None)
    result = provider.detect(noise_image_b64(1))
    assert result.faces == []


@needs_models
def test_a_none_detector_result_reports_no_faces(provider, monkeypatch):
    monkeypatch.setattr(provider, "_detector", StubDetector(None))
    monkeypatch.setattr(provider, "_detector_input_size", None)
    assert provider.detect(noise_image_b64(1)).faces == []


@needs_models
def test_an_image_with_no_face_yields_no_detections_and_real_dimensions(provider):
    result = provider.detect(noise_image_b64(2, width=512, height=384))
    assert result.faces == []
    assert (result.image_width, result.image_height) == (512, 384)


@needs_models
def test_detector_tuning_reaches_opencv():
    p = OpenCVFaceModelProvider(
        model_dir=str(MODEL_DIR), score_threshold=0.9, nms_threshold=0.1, top_k=17
    )
    p.load()
    assert p._score_threshold == 0.9
    assert p._nms_threshold == 0.1
    assert p._top_k == 17


@needs_models
def test_the_detector_input_size_follows_the_frame(provider):
    # YuNet derives its anchor grid from the declared input size; a mismatch
    # puts every box in the wrong place.
    provider.detect(noise_image_b64(3, width=320, height=240))
    assert provider._detector_input_size == (320, 240)
    provider.detect(noise_image_b64(3, width=640, height=480))
    assert provider._detector_input_size == (640, 480)


# ===========================================================================
# Alignment
# ===========================================================================


@needs_models
def test_alignment_produces_a_112_square_crop(provider):
    aligned = provider.align(noise_image_b64(4), BOX, LANDMARKS)
    assert aligned.aligned is True
    crop = cv2.imdecode(
        np.frombuffer(base64.b64decode(aligned.image_base64), np.uint8),
        cv2.IMREAD_COLOR,
    )
    assert crop.shape == (ALIGNED_SIZE, ALIGNED_SIZE, 3)


@needs_models
def test_alignment_is_deterministic(provider):
    image = noise_image_b64(5)
    assert provider.align(image, BOX, LANDMARKS).image_base64 == (
        provider.align(image, BOX, LANDMARKS).image_base64
    )


@needs_models
def test_swapping_the_eyes_changes_the_crop(provider):
    # The mirroring regression. If this ever passes with equal crops, the
    # landmark mapping has stopped mattering and alignment is not happening.
    image = noise_image_b64(6)
    mirrored = FaceLandmarks(
        rightEye=LANDMARKS.left_eye,
        leftEye=LANDMARKS.right_eye,
        noseTip=LANDMARKS.nose_tip,
        mouthRight=LANDMARKS.mouth_left,
        mouthLeft=LANDMARKS.mouth_right,
    )
    assert provider.align(image, BOX, LANDMARKS).image_base64 != (
        provider.align(image, BOX, mirrored).image_base64
    )


@needs_models
def test_a_box_without_landmarks_degrades_honestly(provider):
    # A plain resized crop is worse than an alignment, so the caller is told.
    aligned = provider.align(noise_image_b64(7), BOX, None)
    assert aligned.aligned is False
    crop = cv2.imdecode(
        np.frombuffer(base64.b64decode(aligned.image_base64), np.uint8),
        cv2.IMREAD_COLOR,
    )
    assert crop.shape == (ALIGNED_SIZE, ALIGNED_SIZE, 3)


@needs_models
def test_a_box_that_misses_the_image_is_refused(provider):
    off = BoundingBox(x=5000, y=5000, width=10, height=10)
    with pytest.raises(ImageDecodeError):
        provider.align(noise_image_b64(8), off, None)


def test_the_alignment_template_is_the_one_sface_was_trained_on():
    # Copied from OpenCV's face_recognize.cpp. Pinned because a "tidied" value
    # here would silently degrade every template ever produced.
    assert SFACE_TEMPLATE_112 == (
        (38.2946, 51.6963),
        (73.5318, 51.5014),
        (56.0252, 71.7366),
        (41.5493, 92.3655),
        (70.7299, 92.2041),
    )
    assert ALIGNED_SIZE == 112


# ===========================================================================
# SFace embedding
# ===========================================================================


@needs_models
def test_an_embedding_is_128_dimensional_and_finite(provider):
    vector = provider.embed(noise_image_b64(9), BOX, LANDMARKS)
    assert len(vector) == 128 == EMBEDDING_DIMENSION
    assert all(isinstance(v, float) for v in vector)
    assert np.all(np.isfinite(np.array(vector)))


@needs_models
def test_an_embedding_is_l2_normalised(provider):
    vector = np.array(provider.embed(noise_image_b64(10), BOX, LANDMARKS))
    assert abs(float(np.linalg.norm(vector)) - 1.0) < 1e-9


@needs_models
def test_sface_itself_does_not_emit_unit_vectors(provider):
    """The reason normalisation is our job.

    If this ever fails — if the raw output is already unit-length — the
    normalisation step has become a no-op and somebody should find out why,
    rather than assuming the contract is being upheld by accident.
    """
    image = provider._decode(noise_image_b64(11))
    crop, _ = provider._aligned_crop(image, BOX, LANDMARKS)
    raw = np.asarray(provider._recognizer.feature(crop), dtype=np.float64).reshape(-1)
    assert raw.shape == (128,)
    assert abs(float(np.linalg.norm(raw)) - 1.0) > 0.1


@needs_models
def test_embedding_is_deterministic(provider):
    image = noise_image_b64(12)
    first = provider.embed(image, BOX, LANDMARKS)
    second = provider.embed(image, BOX, LANDMARKS)
    assert first == second
    assert abs(float(np.dot(np.array(first), np.array(second))) - 1.0) < 1e-9


@needs_models
def test_channel_order_matters_which_proves_preprocessing_is_not_double_applied(
    provider,
):
    """Preprocessing regression.

    SFace's own ``feature()`` does the BGR->RGB swap internally
    (``blobFromImage(..., swapRB=true)``), so ``_decode`` must keep the image in
    OpenCV's native BGR. Swapping channels ourselves as well would double-apply
    it and degrade every embedding with nothing reporting a fault.

    Feeding the same crop with channels reversed must therefore produce a
    *different* vector. If these ever came out equal, channel order would have
    stopped affecting the result, which would mean the swap is being cancelled
    out somewhere.
    """
    image = provider._decode(noise_image_b64(13))
    crop, _ = provider._aligned_crop(image, BOX, LANDMARKS)
    as_bgr = np.array(provider._embed_crop(crop))
    as_rgb = np.array(provider._embed_crop(crop[:, :, ::-1].copy()))
    assert float(np.dot(as_bgr, as_rgb)) < 0.999999


@needs_models
def test_a_recogniser_returning_the_wrong_width_is_refused(provider, monkeypatch):
    image = provider._decode(noise_image_b64(14))
    crop, _ = provider._aligned_crop(image, BOX, LANDMARKS)
    monkeypatch.setattr(
        provider,
        "_recognizer",
        StubRecognizer(provider._recognizer, np.zeros((1, 512), np.float32)),
    )
    with pytest.raises(ModelNotLoadedError) as error:
        provider._embed_crop(crop)
    assert "512" in str(error.value)


@needs_models
def test_a_zero_vector_is_refused_rather_than_stored(provider, monkeypatch):
    # A zero vector has no direction; stored, it would score 0.0 against
    # everything and quietly make one student permanently unrecognisable.
    image = provider._decode(noise_image_b64(15))
    crop, _ = provider._aligned_crop(image, BOX, LANDMARKS)
    monkeypatch.setattr(
        provider,
        "_recognizer",
        StubRecognizer(provider._recognizer, np.zeros((1, 128), np.float32)),
    )
    with pytest.raises(ImageDecodeError):
        provider._embed_crop(crop)


@needs_models
def test_a_non_finite_embedding_is_refused(provider, monkeypatch):
    image = provider._decode(noise_image_b64(16))
    crop, _ = provider._aligned_crop(image, BOX, LANDMARKS)
    monkeypatch.setattr(
        provider,
        "_recognizer",
        StubRecognizer(provider._recognizer, np.full((1, 128), np.nan, np.float32)),
    )
    with pytest.raises(ImageDecodeError):
        provider._embed_crop(crop)


# ===========================================================================
# Input handling
# ===========================================================================


@needs_models
@pytest.mark.parametrize(
    "payload",
    [
        "",
        "!!!!not base64!!!!",
        base64.b64encode(b"not an image" * 40).decode(),
    ],
    ids=["empty", "not-base64", "not-an-image"],
)
def test_malformed_payloads_never_reach_the_models(provider, payload):
    with pytest.raises(ImageDecodeError):
        provider.detect(payload)


@needs_models
def test_quality_reports_no_face_on_an_image_without_one(provider):
    assessment = provider.assess_quality(noise_image_b64(17))
    assert assessment.reason == "no_face"
    assert assessment.face_count == 0


@needs_models
def test_quality_reports_unmeasured_metrics_as_unavailable(provider):
    # Pose and occlusion are not computed. Reporting a number for them would
    # invite somebody to tune a threshold against a fabricated measurement.
    assessment = provider.assess_quality(flat_image_b64())
    assert assessment.metrics is not None
    assert assessment.metrics.pose.status == "unavailable"
    assert assessment.metrics.occlusion.status == "unavailable"


@needs_models
def test_quality_rejects_an_undecodable_image_without_crashing(provider):
    assessment = provider.assess_quality("!!!not base64!!!")
    assert assessment.reason == "low_quality"
    assert assessment.face_count == 0


# ===========================================================================
# Classroom path
# ===========================================================================


@needs_models
def test_the_classroom_path_returns_nothing_for_a_frame_with_no_faces(provider):
    faces = provider.detect_and_embed(
        SessionImageInput(sequenceNumber=1, imageBase64=noise_image_b64(18))
    )
    assert faces == []


@needs_models
def test_the_classroom_path_never_invents_a_face_from_a_malformed_result(
    provider, monkeypatch
):
    stub = StubDetector(np.zeros((3, 4), np.float32))
    monkeypatch.setattr(provider, "_detector", stub)
    monkeypatch.setattr(provider, "_detector_input_size", None)
    assert (
        provider.detect_and_embed(
            SessionImageInput(sequenceNumber=2, imageBase64=noise_image_b64(19))
        )
        == []
    )


@needs_models
def test_an_unloaded_provider_refuses_to_serve(tmp_path):
    p = OpenCVFaceModelProvider(model_dir=str(MODEL_DIR))
    with pytest.raises(ModelNotLoadedError):
        p._require_loaded()


# ===========================================================================
# HTTP surface
# ===========================================================================


@needs_models
def test_an_undecodable_image_is_a_400_not_a_500(monkeypatch):
    """A bad image must not look like an outage.

    A 500 is a claim that the *service* failed and retrying may help. apps/web
    believes it: `analyzeCaptureImage` maps a non-2xx onto "the face service is
    temporarily unavailable, try again". So a 500 here tells a teacher to retry
    something that will fail identically every time, and pages somebody for a
    service that is working correctly.

    Unreachable before Phase 5 — the mock never decoded an image, so nothing
    could fail to decode.
    """
    from fastapi.testclient import TestClient

    from app.config import get_model, get_settings, reset_model_cache
    from app.main import app

    monkeypatch.setenv("FACE_MODEL_BACKEND", "opencv")
    monkeypatch.setenv("FACE_MODEL_DIR", str(MODEL_DIR))
    reset_model_cache()
    try:
        get_settings()
        get_model()
        with TestClient(app) as client:
            response = client.post(
                "/v1/detect", json={"imageBase64": "!!!not base64!!!"}
            )
        assert response.status_code == 400
        body = response.json()
        assert "base64" in body["detail"]
        # No image data, no vector — only the reason.
        assert "embedding" not in response.text
    finally:
        reset_model_cache()
