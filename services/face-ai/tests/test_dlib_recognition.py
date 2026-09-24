"""The recogniser: alignment from Azure's landmarks, and dlib's descriptors.

Two layers. The landmark geometry is pure arithmetic and always runs. The
network tests need dlib and the pinned weights; they skip when those are
absent, unless ``FACE_AI_REQUIRE_DLIB=1``, which CI sets so that a missing
artefact is a failure there rather than a quiet pass.

Nothing here is a photograph of anybody. Faces are synthetic landmark sets
and chips are noise.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np
import pytest

from app.models.dlib_recognition import (
    CHIP_SIZE,
    MIN_EMBEDDABLE_FACE_PX,
    NOSE_OFFSET,
    DlibResNetEmbedder,
    LandmarkError,
    RecognizerSelfTestError,
    _unit,
    five_points,
    golden_chip,
)
from app.models.model_files import (
    DLIB_ARTIFACTS,
    DLIB_RESNET,
    ModelArtifactError,
    verify_all,
)

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"
REQUIRED = os.environ.get("FACE_AI_REQUIRE_DLIB") == "1"


def _why_not() -> str:
    try:
        import dlib  # noqa: F401
    except ImportError:
        return "dlib is not installed"
    try:
        verify_all(MODEL_DIR, DLIB_ARTIFACTS)
    except ModelArtifactError as error:
        return f"the pinned recogniser is absent or altered: {error}"
    return ""


_MISSING = _why_not()

if REQUIRED and _MISSING:
    # The production image bakes both in. A skip here would mean the image
    # could ship with a recogniser nothing had ever run.
    raise RuntimeError(
        f"FACE_AI_REQUIRE_DLIB=1 but {_MISSING}. Run "
        "`python scripts/fetch_models.py --set dlib` and install dlib."
    )

needs_dlib = pytest.mark.skipif(bool(_MISSING), reason=_MISSING or "")


# ---------------------------------------------------------------------------
# Synthetic landmarks
# ---------------------------------------------------------------------------


def landmarks(
    *,
    cx: float = 100.0,
    cy: float = 100.0,
    iod: float = 40.0,
    roll_deg: float = 0.0,
) -> dict[str, dict[str, float]]:
    """A plausible upright face, optionally rolled about its centre.

    Azure names from the viewer's side: ``eyeLeft*`` is on the image's left.
    """
    half = iod / 2.0
    inner = iod * 0.16
    points = {
        "eyeLeftOuter": (-half - inner, -iod * 0.15),
        "eyeLeftInner": (-half + inner, -iod * 0.15),
        "eyeRightInner": (half - inner, -iod * 0.15),
        "eyeRightOuter": (half + inner, -iod * 0.15),
        "noseLeftAlarOutTip": (-iod * 0.18, iod * 0.35),
        "noseRightAlarOutTip": (iod * 0.18, iod * 0.35),
        "pupilLeft": (-half, -iod * 0.15),
        "pupilRight": (half, -iod * 0.15),
        "noseTip": (0.0, iod * 0.3),
        "mouthLeft": (-iod * 0.3, iod * 0.65),
        "mouthRight": (iod * 0.3, iod * 0.65),
    }
    angle = math.radians(roll_deg)
    cos, sin = math.cos(angle), math.sin(angle)
    return {
        name: {"x": cx + x * cos - y * sin, "y": cy + x * sin + y * cos}
        for name, (x, y) in points.items()
    }


# ---------------------------------------------------------------------------
# Alignment geometry
# ---------------------------------------------------------------------------


def test_the_five_points_are_in_dlibs_order_not_azures():
    # dlib's part 0 is the subject's LEFT eye outer corner, which is on the
    # image's RIGHT. Getting this backwards mirrors every chip, and the
    # descriptors would be self-consistent and wrong.
    marks = landmarks()
    points = five_points(marks, 80.0)

    assert points[0] == (marks["eyeRightOuter"]["x"], marks["eyeRightOuter"]["y"])
    assert points[1] == (marks["eyeRightInner"]["x"], marks["eyeRightInner"]["y"])
    assert points[2] == (marks["eyeLeftOuter"]["x"], marks["eyeLeftOuter"]["y"])
    assert points[3] == (marks["eyeLeftInner"]["x"], marks["eyeLeftInner"]["y"])
    assert points[0][0] > points[2][0]


def test_the_nose_point_is_the_alar_midpoint_moved_by_the_measured_offset():
    marks = landmarks(cx=200.0, cy=150.0, iod=40.0)
    nose = five_points(marks, 80.0)[4]

    left, right = marks["noseLeftAlarOutTip"], marks["noseRightAlarOutTip"]
    alar_mid_x = (left["x"] + right["x"]) / 2
    alar_mid_y = (left["y"] + right["y"]) / 2
    assert nose[0] == pytest.approx(alar_mid_x + NOSE_OFFSET[0] * 40.0)
    assert nose[1] == pytest.approx(alar_mid_y + NOSE_OFFSET[1] * 40.0)


def test_the_offset_follows_the_face_when_the_head_is_rolled():
    # The offset is measured in the face's own frame. If it were applied in
    # image coordinates, a rolled head would put the nose point off the nose.
    upright = np.array(five_points(landmarks(), 80.0))
    rolled = np.array(five_points(landmarks(roll_deg=35.0), 80.0))

    angle = math.radians(35.0)
    rotation = np.array(
        [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
    )
    centre = np.array([100.0, 100.0])
    expected = (upright - centre) @ rotation.T + centre
    assert np.allclose(rolled, expected, atol=1e-9)


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda m: m.pop("noseLeftAlarOutTip"), "missing or malformed"),
        (lambda m: m.__setitem__("eyeLeftOuter", {"x": 1.0}), "missing or malformed"),
        (
            lambda m: m.__setitem__("eyeLeftOuter", {"x": "a", "y": 1.0}),
            "missing or malformed",
        ),
        (
            lambda m: m.__setitem__("eyeRightInner", {"x": float("nan"), "y": 1.0}),
            "not a finite point",
        ),
    ],
)
def test_landmarks_that_are_not_points_are_refused(mutate, message):
    marks = landmarks()
    mutate(marks)
    with pytest.raises(LandmarkError, match=message):
        five_points(marks, 80.0)


def test_eyes_too_close_together_are_refused():
    # A detection collapsed onto a few pixels would otherwise be warped into
    # a 150px chip of nothing in particular.
    with pytest.raises(LandmarkError, match="too close together"):
        five_points(landmarks(iod=2.0), 8.0)


def test_eyes_too_close_relative_to_the_face_box_are_refused():
    # Absolutely large enough, but a tenth of the face box: not a face.
    with pytest.raises(LandmarkError, match="too close together"):
        five_points(landmarks(iod=20.0), 400.0)


def test_eye_corners_out_of_order_are_refused():
    marks = landmarks()
    marks["eyeLeftOuter"], marks["eyeLeftInner"] = (
        marks["eyeLeftInner"],
        marks["eyeLeftOuter"],
    )
    with pytest.raises(LandmarkError, match="not in a face's order"):
        five_points(marks, 80.0)


def test_a_nose_above_the_eyes_is_refused():
    marks = landmarks()
    for name in ("noseLeftAlarOutTip", "noseRightAlarOutTip"):
        marks[name]["y"] = marks["eyeLeftOuter"]["y"] - 10.0
    with pytest.raises(LandmarkError, match="not below the eyes"):
        five_points(marks, 80.0)


def test_a_nose_outside_the_span_of_the_eyes_is_refused():
    marks = landmarks()
    for name in ("noseLeftAlarOutTip", "noseRightAlarOutTip"):
        marks[name]["x"] += 200.0
    with pytest.raises(LandmarkError, match="outside the span"):
        five_points(marks, 80.0)


def test_geometry_alone_cannot_tell_an_upside_down_face():
    """A known limit, recorded rather than discovered later.

    Every check runs in the face's own frame, which is derived from the eye
    line, so a 180-degree roll is internally consistent and passes. Two other
    things stop it becoming attendance: the quality profile flags any roll
    beyond its limit, which sends the match to a teacher; and if Azure's
    labels follow the inverted face, the chip is mirrored and matches nobody.
    """
    assert len(five_points(landmarks(roll_deg=180.0), 80.0)) == 5


# ---------------------------------------------------------------------------
# Vector hygiene
# ---------------------------------------------------------------------------


def test_a_descriptor_is_returned_at_unit_length():
    values = _unit([3.0] + [0.0] * 127, 128)
    assert len(values) == 128
    assert values[0] == pytest.approx(1.0)
    assert math.isclose(sum(v * v for v in values), 1.0, rel_tol=1e-12)


def test_a_wrong_sized_output_is_a_self_test_failure_not_a_bad_face():
    # 64 values means the wrong network, not an awkward photograph, so it
    # must not be swallowed as "this face could not be embedded".
    with pytest.raises(RecognizerSelfTestError):
        _unit([0.1] * 64, 128)
    assert not issubclass(RecognizerSelfTestError, ValueError)


@pytest.mark.parametrize(
    "values, message",
    [
        ([float("nan")] + [0.1] * 127, "non-finite"),
        ([0.0] * 128, "zero vector"),
    ],
)
def test_a_directionless_output_is_refused(values, message):
    with pytest.raises(ValueError, match=message):
        _unit(values, 128)


def test_the_golden_chip_is_fixed():
    first, second = golden_chip(), golden_chip()
    assert first.shape == (CHIP_SIZE, CHIP_SIZE, 3)
    assert first.dtype == np.uint8
    assert np.array_equal(first, second)
    # Structure in all three channels: a flat or grey pattern would not
    # notice a swapped colour order.
    assert len({first[..., c].std() for c in range(3)}) >= 1
    assert first.std() > 10


def test_the_small_face_floor_is_above_azures_own():
    # Azure will return a 36px face. The evaluation showed genuine and
    # impostor scores overlapping there, so this service refuses lower.
    assert MIN_EMBEDDABLE_FACE_PX >= 32.0


# ---------------------------------------------------------------------------
# The network itself
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def embedder() -> DlibResNetEmbedder:
    loaded = DlibResNetEmbedder(verify_all(MODEL_DIR, DLIB_ARTIFACTS)[DLIB_RESNET.role])
    loaded.load()
    return loaded


def noise_chip(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, (CHIP_SIZE, CHIP_SIZE, 3), dtype=np.uint8)


@needs_dlib
def test_loading_runs_the_golden_self_test(embedder):
    # If this fails, this build of dlib computes something other than the
    # build the thresholds were calibrated on.
    assert embedder.loaded


@needs_dlib
def test_a_recogniser_that_computes_something_else_fails_to_load(monkeypatch):
    import app.models.dlib_recognition as module

    monkeypatch.setattr(module, "GOLDEN_NORM", 2.0)
    broken = DlibResNetEmbedder(verify_all(MODEL_DIR, DLIB_ARTIFACTS)[DLIB_RESNET.role])
    with pytest.raises(RecognizerSelfTestError, match="Refusing to serve"):
        broken.load()
    assert not broken.loaded


@needs_dlib
def test_an_unloaded_embedder_refuses_to_embed():
    with pytest.raises(RuntimeError, match="before load"):
        DlibResNetEmbedder(MODEL_DIR / DLIB_RESNET.filename).embed([noise_chip(1)])


@needs_dlib
def test_descriptors_are_unit_length_and_deterministic(embedder):
    chips = [noise_chip(1), noise_chip(2)]
    first = embedder.embed(chips)
    second = embedder.embed(chips)

    assert [len(v) for v in first] == [128, 128]
    for vector in first:
        assert math.isclose(sum(v * v for v in vector), 1.0, rel_tol=1e-9)
    assert first == second


@needs_dlib
def test_a_batch_and_one_at_a_time_agree(embedder):
    # The classroom path embeds in batches and enrolment embeds one face.
    # A student enrolled by one route is matched by the other.
    chips = [noise_chip(s) for s in range(5)]
    batched = embedder.embed(chips)
    singly = [embedder.embed([chip])[0] for chip in chips]
    for a, b in zip(batched, singly, strict=True):
        assert float(np.dot(a, b)) > 1 - 1e-6


@needs_dlib
def test_a_batch_longer_than_one_network_call_keeps_its_order(embedder):
    # EMBED_BATCH is 16; 20 chips means two calls, and a face must not come
    # back attached to another face's vector.
    chips = [noise_chip(s) for s in range(20)]
    many = embedder.embed(chips)
    assert len(many) == 20
    for index in (0, 15, 16, 19):
        assert float(np.dot(many[index], embedder.embed([chips[index]])[0])) > 1 - 1e-6


@needs_dlib
def test_different_chips_give_different_vectors(embedder):
    # Only that the network responds to its input. Noise is not a face, and
    # the network maps non-faces close together, so nothing is asserted about
    # the *size* of the gap here. Separation between real people is measured
    # on portraits, in docs/CALIBRATION.md.
    a, b = embedder.embed([noise_chip(1), noise_chip(2)])
    assert a != b


@needs_dlib
@pytest.mark.parametrize(
    "chip",
    [
        np.zeros((100, 100, 3), np.uint8),
        np.zeros((CHIP_SIZE, CHIP_SIZE), np.uint8),
        np.zeros((CHIP_SIZE, CHIP_SIZE, 3), np.float32),
    ],
)
def test_a_chip_of_the_wrong_shape_is_refused(embedder, chip):
    with pytest.raises(ValueError, match="must be 150x150x3 uint8"):
        embedder.embed([chip])


@needs_dlib
def test_extracting_a_chip_samples_the_original_image(embedder):
    rng = np.random.default_rng(7)
    image = rng.integers(0, 256, (400, 500, 3), dtype=np.uint8)
    points = five_points(landmarks(cx=250.0, cy=200.0, iod=80.0), 160.0)

    chip = embedder.extract_chip(image, points)
    assert chip.shape == (CHIP_SIZE, CHIP_SIZE, 3)
    assert chip.dtype == np.uint8
    assert np.array_equal(chip, embedder.extract_chip(image, points))


@needs_dlib
def test_the_same_face_in_a_larger_image_gives_the_same_descriptor(embedder):
    # The chip is a similarity transform of the original pixels, so padding
    # the image must not move the face in the chip.
    rng = np.random.default_rng(11)
    image = rng.integers(0, 256, (400, 400, 3), dtype=np.uint8)
    padded = np.zeros((600, 600, 3), np.uint8)
    padded[100:500, 100:500] = image

    at_200 = five_points(landmarks(cx=200, cy=200, iod=60), 120)
    at_300 = five_points(landmarks(cx=300, cy=300, iod=60), 120)
    here = embedder.embed([embedder.extract_chip(image, at_200)])[0]
    there = embedder.embed([embedder.extract_chip(padded, at_300)])[0]
    assert float(np.dot(here, there)) > 0.999


@needs_dlib
def test_an_empty_batch_asks_the_network_nothing(embedder):
    assert embedder.embed([]) == []
