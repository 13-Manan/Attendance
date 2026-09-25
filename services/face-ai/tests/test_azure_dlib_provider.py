"""The ``azure_detection_own_recognition`` backend, against a fake Azure.

Azure Face is replaced by an ``httpx.MockTransport`` that answers only
``/detect``. Any other path returns 404 and fails the test that provoked it,
which is how this file enforces the central claim of the backend: it never
calls Identify, Verify or a PersonGroup, so nothing it does waits on
Microsoft's Limited Access approval.

The recogniser is a stand-in for most tests, because what is under test there
is the provider's plumbing rather than dlib's arithmetic (that is
test_dlib_recognition.py). A few tests do run the real recogniser and skip
without it.

Nothing here is a photograph of anybody: images are gradients and noise, and
the fake decides which faces are "in" them.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import logging
import math
import os
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.azure_face import (
    AzureFaceAuthError,
    AzureFaceBadImageError,
    AzureFaceClient,
    AzureFaceRateLimitedError,
    AzureFaceUnavailableError,
)
from app.config import MODEL_REGISTRY, Settings, build_provider, get_model
from app.main import app
from app.models.azure_dlib_provider import (
    AZURE_MAX_IMAGE_SIDE,
    DLIB_CALIBRATION,
    AzureDetectionOwnRecognitionProvider,
    prepare_image,
)
from app.models.dlib_recognition import CHIP_SIZE, DlibResNetEmbedder
from app.models.model_files import (
    DLIB_ARTIFACTS,
    DLIB_RESNET,
    ModelArtifactError,
    verify_all,
)
from app.models.opencv_provider import ImageDecodeError, ModelNotLoadedError
from app.schemas import BoundingBox, SessionImageInput
from tests.synthetic_face import gaussian_blur as blur_face
from tests.synthetic_face import render_face
from tests.test_dlib_recognition import landmarks as face_landmarks

ENDPOINT = "https://unit-test-face.cognitiveservices.azure.com/"
DUMMY_KEY = "dummy-key-for-unit-tests-0123456789abcdef"
MODEL_DIR = Path(__file__).resolve().parents[1] / "models"


def _dlib_missing() -> str:
    try:
        import dlib  # noqa: F401
    except ImportError:
        return "dlib is not installed"
    try:
        verify_all(MODEL_DIR, DLIB_ARTIFACTS)
    except ModelArtifactError as error:
        return f"the pinned recogniser is absent or altered: {error}"
    return ""


_MISSING = _dlib_missing()
if os.environ.get("FACE_AI_REQUIRE_DLIB") == "1" and _MISSING:
    raise RuntimeError(f"FACE_AI_REQUIRE_DLIB=1 but {_MISSING}.")

needs_dlib = pytest.mark.skipif(bool(_MISSING), reason=_MISSING or "")


# ---------------------------------------------------------------------------
# Synthetic images and faces
# ---------------------------------------------------------------------------


def photo(width: int = 640, height: int = 480, seed: int = 1) -> str:
    """A base64 JPEG with enough detail to survive re-encoding."""
    rng = np.random.default_rng(seed)
    array = rng.integers(40, 220, (height, width, 3), dtype=np.uint8)
    return base64.b64encode(cv2.imencode(".jpg", array)[1].tobytes()).decode()


def face(
    *,
    cx: float = 200.0,
    cy: float = 200.0,
    size: float = 120.0,
    quality: str = "high",
    blur: str = "low",
    exposure: str = "goodExposure",
    yaw: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    occluded: bool = False,
    drop: str | None = None,
) -> dict[str, Any]:
    """One Azure detect entry, with the 27-point landmark names this
    backend aligns on. ``drop`` removes a landmark, which is how a face that
    cannot be aligned is simulated."""
    marks = face_landmarks(cx=cx, cy=cy, iod=size * 0.45, roll_deg=roll)
    if drop is not None:
        marks.pop(drop)
    return {
        "faceRectangle": {
            "left": cx - size / 2,
            "top": cy - size / 2,
            "width": size,
            "height": size,
        },
        "faceLandmarks": marks,
        "faceAttributes": {
            "headPose": {"pitch": pitch, "roll": roll, "yaw": yaw},
            "blur": {"blurLevel": blur, "value": 0.1},
            "exposure": {"exposureLevel": exposure, "value": 0.5},
            "occlusion": {
                "foreheadOccluded": False,
                "eyeOccluded": occluded,
                "mouthOccluded": False,
            },
            "mask": {"type": "noMask", "noseAndMouthCovered": False},
            "qualityForRecognition": quality,
        },
    }


# ---------------------------------------------------------------------------
# The fake service
# ---------------------------------------------------------------------------


class FakeDetect:
    """Answers ``/detect`` and nothing else.

    Faces are configured per test rather than keyed by image bytes, because
    this backend re-encodes before sending and the bytes Azure sees are
    deliberately not the bytes that arrived.
    """

    def __init__(self) -> None:
        self.key = DUMMY_KEY
        self.faces: list[dict[str, Any]] = []
        #: Statuses to answer before behaving normally.
        self.fail: list[int] = []
        #: Azure's own error code returned with those statuses.
        self.error_code = "Whatever"
        self.requests: list[httpx.Request] = []
        self.other_paths: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/face/v1.0")
        if request.headers.get("Ocp-Apim-Subscription-Key") != self.key:
            return httpx.Response(401, json={"error": {"code": "401", "message": "no"}})
        if path != "/detect":
            self.other_paths.append(path)
            return httpx.Response(
                404, json={"error": {"code": "NotFound", "message": "no"}}
            )
        self.requests.append(request)
        if self.fail:
            status = self.fail.pop(0)
            return httpx.Response(
                status, json={"error": {"code": self.error_code, "message": "no"}}
            )
        return httpx.Response(200, json=self.faces)

    @property
    def sent(self) -> bytes:
        return self.requests[-1].content


class StubEmbedder:
    """Stands in for dlib: chips in, deterministic unit vectors out."""

    EMBEDDING_DIM = 128

    def __init__(self) -> None:
        self._loaded = False
        self.loads = 0
        self.chips: list[np.ndarray] = []
        self.batches: list[int] = []
        #: Chip indices (within a call) to return None for.
        self.unusable: set[int] = set()

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        self._loaded = True
        self.loads += 1

    def extract_chip(
        self, rgb: np.ndarray, points: list[tuple[float, float]]
    ) -> np.ndarray:
        assert rgb.ndim == 3 and rgb.shape[2] == 3, "chips come from a colour image"
        digest = hashlib.sha256(np.asarray(points).tobytes()).digest()
        chip = np.frombuffer(digest * (CHIP_SIZE * CHIP_SIZE * 3 // 32 + 1), np.uint8)
        return chip[: CHIP_SIZE * CHIP_SIZE * 3].reshape(CHIP_SIZE, CHIP_SIZE, 3).copy()

    def embed(self, chips: list[np.ndarray]) -> list[list[float] | None]:
        self.batches.append(len(chips))
        out: list[list[float] | None] = []
        for index, chip in enumerate(chips):
            self.chips.append(chip)
            if index in self.unusable:
                out.append(None)
                continue
            seed = int.from_bytes(hashlib.sha256(chip.tobytes()).digest()[:8], "big")
            vector = np.random.default_rng(seed).normal(size=128)
            out.append((vector / np.linalg.norm(vector)).tolist())
        return out


def make_provider(
    fake: FakeDetect, embedder: Any = None, **kwargs: Any
) -> AzureDetectionOwnRecognitionProvider:
    provider = AzureDetectionOwnRecognitionProvider(
        model_dir=None,
        endpoint=ENDPOINT,
        key=DUMMY_KEY,
        client_factory=lambda: AzureFaceClient(
            ENDPOINT,
            DUMMY_KEY,
            transport=httpx.MockTransport(fake.handler),
            sleep=lambda _s: None,
        ),
        embedder=embedder if embedder is not None else StubEmbedder(),
        **kwargs,
    )
    provider.load()
    fake.requests.clear()
    return provider


def session_image(image_base64: str, sequence: int = 1) -> SessionImageInput:
    return SessionImageInput(sequenceNumber=sequence, imageBase64=image_base64)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


def test_startup_checks_the_credential_with_a_detect_call_not_identify():
    fake = FakeDetect()
    provider = AzureDetectionOwnRecognitionProvider(
        model_dir=None,
        endpoint=ENDPOINT,
        key=DUMMY_KEY,
        client_factory=lambda: AzureFaceClient(
            ENDPOINT, DUMMY_KEY, transport=httpx.MockTransport(fake.handler)
        ),
        embedder=StubEmbedder(),
    )
    provider.load()

    assert len(fake.requests) == 1
    assert fake.requests[0].url.params["returnFaceId"] == "false"
    # Not one Limited Access endpoint was touched, so approval is irrelevant
    # to whether this backend starts.
    assert fake.other_paths == []


def test_a_rejected_key_stops_startup():
    fake = FakeDetect()
    fake.key = "some-other-key"
    provider = AzureDetectionOwnRecognitionProvider(
        model_dir=None,
        endpoint=ENDPOINT,
        key=DUMMY_KEY,
        client_factory=lambda: AzureFaceClient(
            ENDPOINT, DUMMY_KEY, transport=httpx.MockTransport(fake.handler)
        ),
        embedder=StubEmbedder(),
    )
    with pytest.raises(AzureFaceAuthError) as excinfo:
        provider.load()
    assert DUMMY_KEY not in str(excinfo.value)


def test_an_unreachable_azure_only_warns_at_startup(caplog):
    # A detector that is down comes back. Refusing to start would turn a
    # transient outage into a deployment that cannot roll forward; requests
    # answer 503 until it returns.
    fake = FakeDetect()
    fake.fail = [500, 500, 500]
    with caplog.at_level(logging.WARNING):
        provider = make_provider(fake)

    assert provider.calibration() is DLIB_CALIBRATION
    assert "azure_face_unavailable" in caplog.text
    assert DUMMY_KEY not in caplog.text


def test_the_startup_check_sends_a_synthetic_pattern_not_a_photograph():
    fake = FakeDetect()
    AzureDetectionOwnRecognitionProvider(
        model_dir=None,
        endpoint=ENDPOINT,
        key=DUMMY_KEY,
        client_factory=lambda: AzureFaceClient(
            ENDPOINT, DUMMY_KEY, transport=httpx.MockTransport(fake.handler)
        ),
        embedder=StubEmbedder(),
    ).load()

    sent = fake.requests[0].content
    assert sent.startswith(b"\xff\xd8")  # JPEG
    assert len(sent) >= 1024  # Azure's floor


def test_the_recogniser_is_loaded_before_azure_is_contacted():
    fake = FakeDetect()
    embedder = StubEmbedder()
    make_provider(fake, embedder)
    assert embedder.loads == 1


def test_a_missing_model_directory_fails_startup_with_the_fetch_command():
    provider = AzureDetectionOwnRecognitionProvider(
        model_dir=None, endpoint=ENDPOINT, key=DUMMY_KEY
    )
    with pytest.raises(ModelNotLoadedError, match="fetch_models"):
        provider.load()


def test_using_the_provider_before_load_is_an_error():
    provider = AzureDetectionOwnRecognitionProvider(
        model_dir=None, endpoint=ENDPOINT, key=DUMMY_KEY, embedder=StubEmbedder()
    )
    with pytest.raises(ModelNotLoadedError, match="before load"):
        provider.detect(photo())


# ---------------------------------------------------------------------------
# What Azure receives
# ---------------------------------------------------------------------------


def test_azure_receives_re_encoded_pixels_not_the_uploaded_bytes():
    fake = FakeDetect()
    provider = make_provider(fake)
    image = photo()
    provider.detect(image)

    assert fake.sent != base64.b64decode(image)
    assert fake.sent.startswith(b"\xff\xd8")


def test_exif_never_reaches_azure():
    # A phone photo's EXIF can carry GPS and the device identity. It is also
    # an orientation hazard: OpenCV applies it, and a detector that did not
    # would return landmarks in another frame from the pixels the chip is
    # cut from.
    pytest.importorskip("PIL", reason="Pillow is needed to write EXIF")
    from PIL import Image

    rng = np.random.default_rng(3)
    array = rng.integers(40, 220, (200, 300, 3), dtype=np.uint8)
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90
    exif[0x8825] = {}  # GPS block
    Image.fromarray(array).save(buffer, "JPEG", exif=exif, quality=95)
    raw = buffer.getvalue()
    assert b"Exif" in raw

    fake = FakeDetect()
    make_provider(fake).detect(base64.b64encode(raw).decode())

    assert b"Exif" not in fake.sent
    assert b"GPS" not in fake.sent


def test_an_image_larger_than_azure_accepts_is_scaled_down_for_detection():
    fake = FakeDetect()
    provider = make_provider(fake)
    provider.detect(photo(width=5000, height=2500, seed=5))

    sent = cv2.imdecode(np.frombuffer(fake.sent, np.uint8), cv2.IMREAD_COLOR)
    assert max(sent.shape[:2]) <= AZURE_MAX_IMAGE_SIDE
    assert len(fake.sent) <= 6 * 1024 * 1024


def test_coordinates_come_back_in_the_original_images_pixels():
    # Azure sees a scaled copy. If its coordinates were passed through, every
    # box and every chip would be cut from the wrong part of the photograph.
    fake = FakeDetect()
    provider = make_provider(fake)
    scale = 5000 / AZURE_MAX_IMAGE_SIDE
    fake.faces = [face(cx=1000.0, cy=500.0, size=200.0)]

    result = provider.detect(photo(width=5000, height=2500, seed=5))

    assert result.image_width == 5000
    assert result.image_height == 2500
    box = result.faces[0].bounding_box
    assert box.x == pytest.approx((1000 - 100) * scale, rel=1e-3)
    assert box.width == pytest.approx(200 * scale, rel=1e-3)


def test_a_face_id_is_never_requested():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face()]
    image = photo()

    provider.detect(image)
    provider.analyze_image(session_image(image))
    provider.assess_quality(image)
    provider.enroll_image(image)
    provider.embed(image)

    assert fake.requests
    for request in fake.requests:
        assert request.url.params["returnFaceId"] == "false"
    assert fake.other_paths == []


@pytest.mark.parametrize(
    "payload, message",
    [
        ("", "No image data"),
        ("not base64!!", "not valid base64"),
        (base64.b64encode(b"").decode(), "No image data"),
        (base64.b64encode(b"nonsense").decode(), "could not be decoded"),
    ],
)
def test_an_unreadable_payload_never_leaves_the_process(payload, message):
    fake = FakeDetect()
    provider = make_provider(fake)
    with pytest.raises(ImageDecodeError, match=message):
        provider.detect(payload)
    assert fake.requests == []


def test_an_image_smaller_than_azures_floor_is_refused_locally():
    fake = FakeDetect()
    provider = make_provider(fake)
    tiny = base64.b64encode(
        cv2.imencode(".png", np.zeros((20, 20, 3), np.uint8))[1].tobytes()
    ).decode()
    with pytest.raises(ImageDecodeError, match="at least 36px"):
        provider.detect(tiny)
    assert fake.requests == []


def test_a_blank_frame_is_refused_here_rather_than_by_azure():
    # Azure rejects anything under a kilobyte. A frame that compresses that
    # small holds no face, and this service can say so without a round trip.
    blank = base64.b64encode(
        cv2.imencode(".png", np.full((64, 64, 3), 128, np.uint8))[1].tobytes()
    ).decode()
    with pytest.raises(ImageDecodeError, match="too little detail"):
        prepare_image(blank)


def test_a_real_photograph_is_sent_within_azures_size_limits():
    prepared = prepare_image(photo(width=320, height=240, seed=9))
    assert 1024 <= len(prepared.payload) <= 6 * 1024 * 1024
    assert prepared.scale_x == 1.0 and prepared.scale_y == 1.0
    assert prepared.rgb.shape == (240, 320, 3)


# ---------------------------------------------------------------------------
# The classroom path
# ---------------------------------------------------------------------------


def test_every_usable_face_is_embedded_and_the_rest_are_reported():
    fake = FakeDetect()
    embedder = StubEmbedder()
    provider = make_provider(fake, embedder)
    fake.faces = [
        face(cx=100.0, cy=100.0, size=120.0),
        face(cx=300.0, cy=100.0, size=20.0),  # too small to embed
        face(cx=500.0, cy=100.0, size=120.0, drop="noseLeftAlarOutTip"),
    ]

    analysis = provider.analyze_image(session_image(photo()))

    assert len(analysis.faces) == 1
    assert {r.reason for r in analysis.rejected} == {
        "face_too_small",
        "alignment_failed",
    }
    assert analysis.summary.detected_faces == 3
    assert analysis.summary.embedded_faces == 1
    assert analysis.summary.rejected_faces == 2
    assert analysis.faces[0].aligned is True
    assert len(analysis.faces[0].embedding) == 128
    assert analysis.timings.detect_ms >= 0.0
    # Only the face that could be aligned was ever given to the recogniser.
    assert embedder.batches == [1]


def test_a_face_the_recogniser_cannot_use_is_rejected_not_invented():
    fake = FakeDetect()
    embedder = StubEmbedder()
    embedder.unusable = {0}
    provider = make_provider(fake, embedder)
    fake.faces = [face()]

    analysis = provider.analyze_image(session_image(photo()))

    assert analysis.faces == []
    assert [r.reason for r in analysis.rejected] == ["embedding_failed"]
    assert analysis.summary.embedded_faces == 0


def test_a_rejected_face_still_says_where_it_was():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(cx=300.0, cy=200.0, size=20.0)]

    rejected = provider.analyze_image(session_image(photo())).rejected[0]

    assert rejected.sequence_number == 1
    assert rejected.bounding_box.x == pytest.approx(290.0)
    assert rejected.face_size == pytest.approx(20.0)


def test_a_low_quality_face_is_flagged_but_still_embedded():
    # Refusing it outright would make a poor capture of a student
    # indistinguishable from an absent one. Flagged, it reaches a teacher.
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(quality="low", blur="high")]

    analysis = provider.analyze_image(session_image(photo()))

    assert len(analysis.faces) == 1
    assert "low_quality" in analysis.faces[0].quality_flags
    # Azure's blur rating alone no longer flags a classroom face: it tracks
    # face size and darkness as much as focus. This photograph is sharp, and
    # blur is now judged from its pixels (see the classroom tests below).
    assert "blurred" not in analysis.faces[0].quality_flags


def test_a_heavily_rolled_face_is_flagged():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(roll=60.0)]

    analysis = provider.analyze_image(session_image(photo()))

    assert "bad_angle" in analysis.faces[0].quality_flags


def test_an_outage_is_an_outage_and_never_an_empty_classroom():
    # The failure mode this guards: Azure 503s, the provider returns no
    # faces, and apps/web records a room in which nobody was present.
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.fail = [503, 503, 503]

    with pytest.raises(AzureFaceUnavailableError):
        provider.analyze_image(session_image(photo()))


@pytest.mark.parametrize(
    "status, code, expected",
    [
        (401, "401", AzureFaceAuthError),
        (429, "TooManyRequests", AzureFaceRateLimitedError),
        (400, "InvalidImage", AzureFaceBadImageError),
    ],
)
def test_azures_own_refusals_propagate(status, code, expected):
    # Each one becomes a specific status at the route. None of them becomes
    # a classroom photograph with no faces in it.
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.error_code = code
    fake.fail = [status] * 4
    with pytest.raises(expected):
        provider.analyze_image(session_image(photo()))


def test_the_same_photograph_gives_the_same_vectors():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(), face(cx=400.0)]
    image = photo()

    first = provider.analyze_image(session_image(image))
    second = provider.analyze_image(session_image(image))

    assert [f.embedding for f in first.faces] == [f.embedding for f in second.faces]


def test_detect_and_embed_is_the_faces_from_analyze_image():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face()]
    image = session_image(photo())

    assert [f.embedding for f in provider.detect_and_embed(image)] == [
        f.embedding for f in provider.analyze_image(image).faces
    ]


def test_a_photograph_with_no_faces_is_not_an_error():
    fake = FakeDetect()
    provider = make_provider(fake)
    analysis = provider.analyze_image(session_image(photo()))

    assert analysis.faces == []
    assert analysis.rejected == []
    assert analysis.summary.detected_faces == 0


# ---------------------------------------------------------------------------
# Enrolment
# ---------------------------------------------------------------------------


def test_enrolment_returns_one_embedding_for_one_good_face():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(size=200.0)]

    outcome = provider.enroll_image(photo())

    assert outcome.assessment.reason == "ok"
    assert outcome.aligned is True
    assert len(outcome.embedding) == 128


@pytest.mark.parametrize(
    "faces, reason",
    [
        ([], "no_face"),
        ([face(size=200.0), face(cx=400.0, size=200.0)], "multiple_faces"),
        ([face(size=200.0, quality="low")], "low_quality"),
        ([face(size=40.0)], "face_too_small"),
    ],
)
def test_enrolment_refuses_without_an_embedding(faces, reason):
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = faces

    outcome = provider.enroll_image(photo())

    assert outcome.assessment.reason == reason
    assert outcome.embedding is None
    assert outcome.aligned is False


def test_enrolment_refuses_a_face_it_cannot_align():
    # Quality says yes, geometry says no. The refusal must not carry a
    # vector cut from an unaligned crop.
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(size=200.0, drop="eyeLeftInner")]

    outcome = provider.enroll_image(photo())

    assert outcome.assessment.reason == "low_quality"
    assert "could not be aligned" in (outcome.assessment.detail or "")
    assert outcome.embedding is None


def test_enrolment_refuses_a_face_the_recogniser_cannot_use():
    fake = FakeDetect()
    embedder = StubEmbedder()
    embedder.unusable = {0}
    provider = make_provider(fake, embedder)
    fake.faces = [face(size=200.0)]

    outcome = provider.enroll_image(photo())

    assert outcome.assessment.reason == "low_quality"
    assert outcome.embedding is None


def test_an_unreadable_enrolment_photo_is_a_refusal_not_a_crash():
    fake = FakeDetect()
    provider = make_provider(fake)

    outcome = provider.enroll_image(base64.b64encode(b"nonsense").decode())

    assert outcome.assessment.reason == "low_quality"
    assert "could not be decoded" in (outcome.assessment.detail or "")
    assert outcome.embedding is None


def test_assess_quality_reports_a_decode_failure_rather_than_raising():
    fake = FakeDetect()
    provider = make_provider(fake)

    assessment = provider.assess_quality(base64.b64encode(b"nonsense").decode())

    assert assessment.reason == "low_quality"
    assert assessment.face_count == 0


# ---------------------------------------------------------------------------
# Single-face routes
# ---------------------------------------------------------------------------


def test_embedding_by_bounding_box_picks_that_face():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(cx=100.0, cy=100.0), face(cx=400.0, cy=300.0)]

    first = provider.embed(photo(), BoundingBox(x=40, y=40, width=120, height=120))
    second = provider.embed(photo(), BoundingBox(x=340, y=240, width=120, height=120))

    assert first != second


def test_a_bounding_box_matching_no_detected_face_is_refused():
    # Better an explicit refusal than an embedding of whoever happened to be
    # nearest, attributed to the student the caller asked about.
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(cx=100.0, cy=100.0)]

    with pytest.raises(ImageDecodeError, match="matches the supplied bounding box"):
        provider.embed(photo(), BoundingBox(x=500, y=400, width=60, height=60))


def test_without_a_bounding_box_the_largest_face_is_used():
    fake = FakeDetect()
    provider = make_provider(fake)
    small, large = face(cx=100.0, size=60.0), face(cx=400.0, size=200.0)
    fake.faces = [small, large]

    chosen = provider.embed(photo())
    fake.faces = [large]
    assert chosen == provider.embed(photo())


def test_embedding_an_image_with_no_face_is_refused():
    fake = FakeDetect()
    provider = make_provider(fake)
    with pytest.raises(ImageDecodeError, match="No face was found"):
        provider.embed(photo())


def test_align_returns_the_chip_the_recogniser_sees():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(size=200.0)]

    aligned = provider.align(photo(), None, None)

    chip = cv2.imdecode(
        np.frombuffer(base64.b64decode(aligned.image_base64), np.uint8),
        cv2.IMREAD_COLOR,
    )
    assert aligned.aligned is True
    assert chip.shape == (CHIP_SIZE, CHIP_SIZE, 3)


def test_align_refuses_a_face_it_cannot_align():
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [face(size=200.0, drop="eyeRightOuter")]

    with pytest.raises(ImageDecodeError, match="could not be aligned"):
        provider.align(photo(), None, None)


# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------


def test_the_model_reports_every_stage_it_runs():
    fake = FakeDetect()
    provider = make_provider(fake)
    stages = {s.role: s for s in provider.stage_descriptors()}

    assert set(stages) == {"detector", "aligner", "embedder", "matcher"}
    assert stages["detector"].name == "azure-face-detect"
    assert stages["embedder"].embedding_dim == 128
    assert stages["embedder"].required_assets == (DLIB_RESNET.filename,)
    # Every stage that could carry a licence is cleared. The matcher is
    # arithmetic, so it carries none.
    assert stages["matcher"].commercial_use == "not-applicable"
    assert all(
        stages[role].commercial_use == "permitted"
        for role in ("detector", "aligner", "embedder")
    )


def test_the_version_names_the_alignment_because_it_changes_every_template():
    fake = FakeDetect()
    provider = make_provider(fake)
    info = provider.model_info()

    assert info.alignment_version == provider.alignment_version
    assert "+al" in info.model_version
    assert info.embedding_dim == 128
    assert info.template_kind == "embedding"


def test_the_calibration_is_published_with_the_model():
    # apps/web refuses this backend's scores without it: raw dlib cosines and
    # the product's thresholds are different scales, and comparing them
    # directly would mark strangers present.
    fake = FakeDetect()
    provider = make_provider(fake)
    calibration = provider.model_info().calibration

    assert calibration is not None
    assert calibration.id == DLIB_CALIBRATION.id
    assert calibration.raw_ambiguity_margin == 0.01
    assert [(k.raw, k.calibrated) for k in calibration.knots] == [
        (-1.0, -1.0),
        (0.93, 0.45),
        (0.955, 0.62),
        (1.0, 1.0),
    ]


def test_identification_is_not_something_this_backend_offers():
    fake = FakeDetect()
    provider = make_provider(fake)
    assert provider.identification_status() == "not_applicable"


def test_the_backend_is_registered_and_production_eligible():
    registration = MODEL_REGISTRY["azure_detection_own_recognition"]
    assert registration.provider_cls is AzureDetectionOwnRecognitionProvider
    assert registration.commercial_use == "permitted"

    built = build_provider(
        Settings(
            face_model_backend="azure_detection_own_recognition",
            face_ai_require_production_model=True,
            face_model_dir="models",
            azure_face_endpoint=ENDPOINT,
            azure_face_key=DUMMY_KEY,
        )
    )
    assert isinstance(built, AzureDetectionOwnRecognitionProvider)


def test_the_key_is_not_stored_where_it_can_be_printed():
    fake = FakeDetect()
    provider = make_provider(fake)
    assert DUMMY_KEY not in repr(provider.model_info())
    assert DUMMY_KEY not in repr(provider.stage_descriptors())


# ---------------------------------------------------------------------------
# With the real recogniser
# ---------------------------------------------------------------------------


@pytest.fixture
def real_provider(request):
    fake = FakeDetect()
    weights = verify_all(MODEL_DIR, DLIB_ARTIFACTS)[DLIB_RESNET.role]
    return fake, make_provider(fake, DlibResNetEmbedder(weights))


@needs_dlib
def test_the_real_recogniser_embeds_a_detected_face(real_provider):
    fake, provider = real_provider
    fake.faces = [face(cx=200.0, cy=200.0, size=160.0)]

    analysis = provider.analyze_image(session_image(photo()))

    assert len(analysis.faces) == 1
    vector = analysis.faces[0].embedding
    assert len(vector) == 128
    assert float(np.dot(vector, vector)) == pytest.approx(1.0, rel=1e-9)


@needs_dlib
def test_the_real_recogniser_is_deterministic_across_calls(real_provider):
    fake, provider = real_provider
    fake.faces = [face(cx=200.0, cy=200.0, size=160.0)]
    image = photo()

    first = provider.analyze_image(session_image(image)).faces[0].embedding
    second = provider.analyze_image(session_image(image)).faces[0].embedding
    assert first == second


@needs_dlib
def test_enrolment_and_the_classroom_path_agree_on_the_same_face(real_provider):
    # A student enrolled through /v1/enroll is matched from a vector produced
    # by /v1/detect-embed. If the two paths aligned differently, every match
    # would be against a template nothing can reach.
    fake, provider = real_provider
    fake.faces = [face(cx=200.0, cy=200.0, size=200.0)]
    image = photo()

    enrolled = provider.enroll_image(image).embedding
    detected = provider.analyze_image(session_image(image)).faces[0].embedding

    assert float(np.dot(enrolled, detected)) > 0.9999


# ---------------------------------------------------------------------------
# Through the HTTP contract
# ---------------------------------------------------------------------------


@pytest.fixture
def routed():
    """The app serving this backend, with Azure faked and dlib stubbed."""
    fake = FakeDetect()
    provider = make_provider(fake)
    app.dependency_overrides[get_model] = lambda: provider
    try:
        yield fake, TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_model_info_tells_apps_web_which_engine_wrote_a_template(routed):
    _, client = routed
    info = client.get("/v1/model-info").json()

    assert info["modelName"] == "dlib-resnet-v1"
    assert info["alignmentVersion"] == "1.detection_03"
    assert info["modelVersion"].endswith("+al1.detection_03")
    assert info["productionEligible"] is True
    assert info["identification"] == "not_applicable"
    assert info["calibration"]["id"] == DLIB_CALIBRATION.id
    assert [s["role"] for s in info["stages"]] == [
        "detector",
        "aligner",
        "embedder",
        "matcher",
    ]
    # Neither the key nor the endpoint is anywhere in what a caller can see.
    assert DUMMY_KEY not in client.get("/v1/model-info").text
    assert "cognitiveservices" not in client.get("/v1/model-info").text


def test_detect_embed_returns_one_face_per_student_with_its_reasons(routed):
    fake, client = routed
    fake.faces = [face(cx=150.0), face(cx=400.0, size=20.0)]

    body = client.post(
        "/v1/detect-embed",
        json={
            "sessionId": "s1",
            "images": [{"sequenceNumber": 1, "imageBase64": photo()}],
        },
    ).json()

    assert len(body["faces"]) == 1
    assert len(body["faces"][0]["embedding"]) == 128
    assert body["rejectedFaces"][0]["reason"] == "face_too_small"
    assert body["images"][0]["detectedFaces"] == 2


def test_an_azure_outage_is_a_503_and_not_an_empty_room(routed):
    fake, client = routed
    fake.fail = [503] * 4

    response = client.post(
        "/v1/detect-embed",
        json={
            "sessionId": "s1",
            "images": [{"sequenceNumber": 1, "imageBase64": photo()}],
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "azure_face_unavailable"}


def test_match_applies_this_backends_calibration_not_the_raw_cosine(routed):
    # 0.94 raw is two different people for this recogniser. Read as though it
    # were already on the product's scale it would be a confident match.
    fake, client = routed
    fake.faces = [face(size=200.0)]
    probe = client.post(
        "/v1/embed", json={"imageBase64": photo()}
    ).json()["embedding"]
    candidate = _at_cosine(probe, 0.94)

    body = client.post(
        "/v1/match",
        json={
            "imageBase64": photo(),
            "candidates": [
                {"studentId": "stu-1", "embedding": candidate, "modelVersion": None}
            ],
        },
    ).json()

    assert body["scores"][0]["rawSimilarity"] == pytest.approx(0.94, abs=1e-6)
    assert body["scores"][0]["similarity"] < 0.62
    assert body["status"] == "UNCERTAIN"


def _at_cosine(vector: list[float], target: float) -> list[float]:
    """A unit vector at exactly ``target`` cosine from ``vector``."""
    base = np.asarray(vector, dtype=np.float64)
    other = np.zeros_like(base)
    other[0] = 1.0
    perpendicular = other - base * float(base @ other)
    perpendicular /= np.linalg.norm(perpendicular)
    out = target * base + math.sqrt(1 - target**2) * perpendicular
    return (out / np.linalg.norm(out)).tolist()


# ---------------------------------------------------------------------------
# The enrolment blur gate, end to end
# ---------------------------------------------------------------------------
#
# The regression this section exists for: enrolment used to refuse any face
# Azure did not rate blur "low", and Azure's rating rises as a face gets
# smaller whatever its focus — so ordinary webcam captures were refused with
# "hold the camera steady". Blur is now measured on the face itself
# (app/models/face_sharpness.py). Azure is faked; the pixels are real.


def encoded(frame: np.ndarray, quality: int = 92) -> str:
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return base64.b64encode(buffer.tobytes()).decode()


def as_azure_rates_it(
    detection: dict[str, Any],
    *,
    blur: tuple[str, float] = ("low", 0.0),
    quality: str = "high",
    exposure: str = "goodExposure",
    yaw: float = 0.0,
) -> dict[str, Any]:
    rated = copy.deepcopy(detection)
    attributes = rated["faceAttributes"]
    attributes["blur"] = {"blurLevel": blur[0], "value": blur[1]}
    attributes["qualityForRecognition"] = quality
    attributes["exposure"]["exposureLevel"] = exposure
    attributes["headPose"]["yaw"] = yaw
    return rated


def test_a_sharp_face_azure_rates_blurred_is_enrolled():
    # A 130px face: the size where Azure rated sharp faces "medium" most of
    # the time. This is the capture that used to be refused.
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(130)
    fake.faces = [as_azure_rates_it(detection, blur=("medium", 0.45))]

    outcome = provider.enroll_image(encoded(frame))

    assert outcome.assessment.reason == "ok"
    assert outcome.embedding is not None and len(outcome.embedding) == 128
    blur = outcome.assessment.metrics.blur
    assert blur.status == "measured" and blur.unit == "blur_effect_v1"
    assert blur.value <= 0.65


def test_a_blurred_face_is_refused_even_when_azure_rates_it_sharp():
    # The gate was not loosened, it was moved: this one only a measurement
    # of the face itself catches.
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(220)
    fake.faces = [as_azure_rates_it(detection, blur=("low", 0.0))]

    outcome = provider.enroll_image(encoded(blur_face(frame, 220, 2.5)))

    assert outcome.assessment.reason == "blurred"
    assert outcome.embedding is None
    assert outcome.assessment.metrics.blur.value > 0.65


def test_camera_shake_is_refused():
    from tests.synthetic_face import motion_blur

    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(220)
    fake.faces = [detection]

    outcome = provider.enroll_image(encoded(motion_blur(frame, 220, 16, 45)))

    assert outcome.assessment.reason == "blurred"


def test_a_small_face_is_told_to_move_closer_not_to_hold_still():
    # Blurred AND small. "Hold the camera steady" does not fix a face that
    # is too far away; "move closer" fixes both — so blur is not judged.
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(80)
    fake.faces = [as_azure_rates_it(detection, blur=("high", 0.9))]

    outcome = provider.enroll_image(encoded(blur_face(frame, 80, 2.5)))

    assert outcome.assessment.reasons == ["face_too_small"]
    assert outcome.assessment.metrics.blur.status == "unavailable"


@pytest.mark.parametrize(
    "rating, reason",
    [
        ({"quality": "medium"}, "low_quality"),
        ({"exposure": "underExposure"}, "too_dark"),
        ({"exposure": "overExposure"}, "too_bright"),
        ({"yaw": 45.0}, "bad_angle"),
    ],
)
def test_every_other_enrolment_check_still_applies(rating, reason):
    # Only the blur decision moved. Azure's recognition-quality rating, which
    # also falls for real blur, still has to be "high" to enrol.
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(200)
    fake.faces = [as_azure_rates_it(detection, **rating)]

    outcome = provider.enroll_image(encoded(frame))

    assert outcome.assessment.reason == reason
    assert outcome.embedding is None


def test_two_faces_are_still_refused_before_anything_is_measured():
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(200)
    fake.faces = [detection, copy.deepcopy(detection)]

    outcome = provider.enroll_image(encoded(frame))

    assert outcome.assessment.reason == "multiple_faces"


@pytest.mark.parametrize("sigma", [0.0, 2.5])
def test_the_quality_check_and_enrolment_agree(sigma):
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(180)
    fake.faces = [detection]
    image = encoded(blur_face(frame, 180, sigma) if sigma else frame)

    assert provider.assess_quality(image).reason == (
        provider.enroll_image(image).assessment.reason
    )


def test_each_enrolment_decision_is_logged_without_biometric_data(caplog):
    fake = FakeDetect()
    provider = make_provider(fake)
    frame, detection = render_face(200)
    fake.faces = [as_azure_rates_it(detection, blur=("medium", 0.31))]
    image = encoded(blur_face(frame, 200, 2.5))

    with caplog.at_level(logging.INFO, logger="app.models.azure_dlib_provider"):
        provider.enroll_image(image)

    messages = [record.getMessage() for record in caplog.records]
    lines = [m for m in messages if "enrolment quality" in m]
    assert len(lines) == 1
    line = lines[0]
    for expected in (
        "route=enroll",
        "decision=blurred",
        "image=1280x720",
        "sent=1280x720",
        "face=200x200",
        "max_blur=0.65",
        "measure=v1",
        "azure_blur=medium(0.31)",
        "azure_quality=high",
    ):
        assert expected in line, expected
    # What it must never carry: the key, the pixels, the landmark positions.
    assert DUMMY_KEY not in line
    assert image[:40] not in line
    for name, point in detection["faceLandmarks"].items():
        assert name not in line
        assert f"{point['x']:.1f}" not in line


def test_the_enroll_route_reports_blur_and_accepts_a_sharp_face(routed):
    fake, client = routed
    frame, detection = render_face(160)
    fake.faces = [as_azure_rates_it(detection, blur=("medium", 0.4))]

    sharp = client.post("/v1/enroll", json={"imageBase64": encoded(frame)}).json()
    assert sharp["accepted"] is True

    blurred_image = encoded(blur_face(frame, 160, 2.5))
    blurred = client.post("/v1/enroll", json={"imageBase64": blurred_image}).json()
    assert blurred["accepted"] is False
    assert blurred["assessment"]["reason"] == "blurred"
    assert "embedding" not in blurred


# ---------------------------------------------------------------------------
# Classroom quality flags (dlib backend)
# ---------------------------------------------------------------------------
#
# A flag caps a classroom match at "needs review". It should fire only when a
# face is outside the conditions the thresholds were validated on — not, as
# Azure's blur and exposure ratings did, on dark, backlit or small faces the
# recogniser matches correctly (docs/CALIBRATION.md, "Classroom quality").


def classroom_flags_for(frame, detection):
    fake = FakeDetect()
    provider = make_provider(fake)
    fake.faces = [detection]
    analysis = provider.analyze_image(session_image(encoded(frame, 82)))
    assert len(analysis.faces) == 1, "the face is still embedded, whatever its flags"
    return analysis.faces[0].quality_flags


def test_the_severe_blur_threshold_rises_for_faces_smaller_than_the_chip():
    from app.models.azure_dlib_provider import severe_blur_threshold

    assert severe_blur_threshold(200) == pytest.approx(0.72)
    assert severe_blur_threshold(80) == pytest.approx(0.72)
    assert severe_blur_threshold(60) == pytest.approx(0.75)
    assert severe_blur_threshold(40) == pytest.approx(0.78)
    assert severe_blur_threshold(20) == pytest.approx(0.78)


@pytest.mark.parametrize("face_px", [60, 100, 200])
def test_a_sharp_classroom_face_is_not_flagged(face_px):
    frame, detection = render_face(face_px)
    assert classroom_flags_for(frame, detection) == []


@pytest.mark.parametrize("face_px", [100, 200])
def test_azures_blur_and_exposure_ratings_no_longer_flag_a_good_face(face_px):
    # What Azure says about small or dark faces: blurred, underexposed. The
    # pixels say otherwise, and the pixels decide.
    frame, detection = render_face(face_px)
    rated = as_azure_rates_it(detection, blur=("high", 0.9), exposure="underExposure")
    assert classroom_flags_for(frame, rated) == []


@pytest.mark.parametrize("gain", [0.45, 0.3])
def test_a_dark_face_is_not_flagged(gain):
    # Darkened to x0.3 the recogniser still matched as reliably as clean.
    frame, detection = render_face(160)
    dark = np.clip(frame.astype(np.float64) * gain, 0, 255).astype(np.uint8)
    assert classroom_flags_for(dark, detection) == []


def test_a_face_darker_than_anything_validated_is_flagged():
    frame, detection = render_face(160)
    black = np.clip(frame.astype(np.float64) * 0.08, 0, 255).astype(np.uint8)
    assert "too_dark" in classroom_flags_for(black, detection)


def test_a_blown_out_face_is_flagged():
    frame, detection = render_face(160)
    blown = np.clip(frame.astype(np.float64) * 3.0 + 60, 0, 255).astype(np.uint8)
    assert "too_bright" in classroom_flags_for(blown, detection)


@pytest.mark.parametrize("face_px", [60, 100, 200])
def test_severe_blur_is_flagged_at_every_size(face_px):
    frame, detection = render_face(face_px)
    assert "blurred" in classroom_flags_for(blur_face(frame, face_px, 3.0), detection)


def test_severe_camera_shake_is_flagged():
    from tests.synthetic_face import motion_blur

    frame, detection = render_face(160)
    assert "blurred" in classroom_flags_for(motion_blur(frame, 160, 16, 45), detection)


@pytest.mark.parametrize("sigma", [0.5, 1.0])
def test_mild_blur_is_left_to_the_score(sigma):
    # Mild blur costs the match a little; it does not make it unsafe. The
    # score falls by itself — the flag is for when the evidence is too poor
    # to trust whatever the score says.
    frame, detection = render_face(160)
    assert "blurred" not in classroom_flags_for(blur_face(frame, 160, sigma), detection)


def _cut_left(frame, detection, fraction):
    """The face with ``fraction`` of its box cut off by the left edge, and
    what Azure reports for it: the rectangle clamped to the photograph, the
    landmarks extrapolated beyond it (as observed live)."""
    rect = detection["faceRectangle"]
    offset = int(rect["left"] + fraction * rect["width"])
    cut = frame[:, offset:].copy()
    shifted = copy.deepcopy(detection)
    r = shifted["faceRectangle"]
    left = r["left"] - offset
    r["left"], r["width"] = max(0.0, left), r["width"] + min(0.0, left)
    for point in shifted["faceLandmarks"].values():
        point["x"] -= offset
    return cut, shifted


def test_a_face_cut_off_by_the_frame_edge_is_sent_to_review():
    frame, detection = render_face(200)
    cut, reported = _cut_left(frame, detection, 0.35)
    assert reported["faceRectangle"]["left"] == 0.0
    assert min(p["x"] for p in reported["faceLandmarks"].values()) < 0
    assert "occluded" in classroom_flags_for(cut, reported)


def test_a_whole_face_touching_the_frame_edge_is_not_flagged():
    frame, detection = render_face(200)
    cut, reported = _cut_left(frame, detection, 0.0)
    assert "occluded" not in classroom_flags_for(cut, reported)


@pytest.mark.parametrize(
    "rating, flag",
    [
        ({"yaw": 60.0}, "bad_angle"),
        ({"quality": "low"}, "low_quality"),
    ],
)
def test_the_other_classroom_flags_are_unchanged(rating, flag):
    frame, detection = render_face(160)
    assert flag in classroom_flags_for(frame, as_azure_rates_it(detection, **rating))


def test_an_occluded_face_is_still_flagged():
    frame, detection = render_face(160)
    covered = copy.deepcopy(detection)
    covered["faceAttributes"]["occlusion"]["eyeOccluded"] = True
    assert "occluded" in classroom_flags_for(frame, covered)
