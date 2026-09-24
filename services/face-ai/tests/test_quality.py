"""app/quality.py — measurement, pose estimation and the two profiles.

Everything here is synthetic: landmark geometry built by hand, crops made of
noise or flat colour. That is enough to pin the arithmetic (which check fires,
in what order, with what score); whether the *thresholds* are right for SFace
is a calibration question, answered by bench/calibrate_quality.py against a
corpus that never enters the repository.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.quality import (
    ENROLLMENT_PROFILE,
    GROUP_PROFILE,
    MIN_EMBEDDABLE_FACE_PX,
    FaceMeasurements,
    estimate_pose,
    evaluate,
    measure,
    metrics_from,
)
from app.schemas import BoundingBox, FaceLandmarks, Point

cv2 = pytest.importorskip("cv2", reason="opencv-python-headless is required")

# A level, frontal face in a 200px box: eyes 70px apart, nose at the
# calibrated frontal position between the eye line and the mouth line.
EYE_Y, MOUTH_Y = 170.0, 250.0
FRONTAL_NOSE_Y = EYE_Y + 0.59 * (MOUTH_Y - EYE_Y)
BOX = BoundingBox(x=80, y=100, width=200, height=200)


def landmarks(nose_dx: float = 0.0, nose_y: float = FRONTAL_NOSE_Y, tilt: float = 0.0):
    """Frontal landmarks, with the nose shifted sideways (yaw), up/down
    (pitch), or the whole face rotated in the image plane (roll)."""
    centre = (180.0, 210.0)

    def rot(x: float, y: float) -> Point:
        a = math.radians(tilt)
        dx, dy = x - centre[0], y - centre[1]
        return Point(
            x=centre[0] + dx * math.cos(a) - dy * math.sin(a),
            y=centre[1] + dx * math.sin(a) + dy * math.cos(a),
        )

    return FaceLandmarks(
        rightEye=rot(145, EYE_Y),
        leftEye=rot(215, EYE_Y),
        noseTip=rot(180 + nose_dx, nose_y),
        mouthRight=rot(152, MOUTH_Y),
        mouthLeft=rot(208, MOUTH_Y),
    )


def textured_crop(seed: int = 0, level: int = 128, spread: int = 60) -> np.ndarray:
    rng = np.random.default_rng(seed)
    lo, hi = max(0, level - spread), min(255, level + spread)
    return rng.integers(lo, hi + 1, (112, 112, 3)).astype(np.uint8)


def good(**overrides) -> FaceMeasurements:
    values = dict(
        detection_confidence=0.95,
        face_size_px=200.0,
        inter_eye_px=70.0,
        sharpness=900.0,
        brightness=140.0,
        underexposed_fraction=0.0,
        overexposed_fraction=0.0,
        yaw_deg=0.0,
        pitch_deg=0.0,
        roll_deg=0.0,
        landmarks_plausible=True,
    )
    values.update(overrides)
    return FaceMeasurements(**values)


# ===========================================================================
# Pose
# ===========================================================================


def test_a_frontal_face_reads_as_frontal():
    yaw, pitch, roll, inter_eye, plausible = estimate_pose(landmarks())
    assert abs(yaw) < 1 and abs(pitch) < 1 and abs(roll) < 1
    assert inter_eye == pytest.approx(70.0)
    assert plausible


def test_yaw_sign_follows_the_nose_across_the_image():
    # Positive: nose toward the image's right, i.e. the subject has turned to
    # their own left. Verified by eye on calibration portraits.
    assert estimate_pose(landmarks(nose_dx=+20))[0] > 15
    assert estimate_pose(landmarks(nose_dx=-20))[0] < -15


def test_pitch_sign_follows_the_nose_toward_the_mouth():
    assert estimate_pose(landmarks(nose_y=FRONTAL_NOSE_Y + 20))[1] > 15
    assert estimate_pose(landmarks(nose_y=FRONTAL_NOSE_Y - 20))[1] < -15


def test_in_plane_rotation_is_roll_not_yaw():
    yaw, pitch, roll, _, _ = estimate_pose(landmarks(tilt=25))
    assert roll == pytest.approx(25, abs=0.5)
    assert abs(yaw) < 1 and abs(pitch) < 1


def test_a_mouth_above_the_eyes_is_implausible():
    upside_down = FaceLandmarks(
        rightEye=Point(x=145, y=250),
        leftEye=Point(x=215, y=250),
        noseTip=Point(x=180, y=220),
        mouthRight=Point(x=152, y=170),
        mouthLeft=Point(x=208, y=170),
    )
    assert estimate_pose(upside_down)[4] is False


def test_coincident_eyes_do_not_divide_by_zero():
    collapsed = FaceLandmarks(
        rightEye=Point(x=180, y=170),
        leftEye=Point(x=180, y=170),
        noseTip=Point(x=180, y=210),
        mouthRight=Point(x=170, y=250),
        mouthLeft=Point(x=190, y=250),
    )
    assert estimate_pose(collapsed) == (0.0, 0.0, 0.0, 0.0, False)


# ===========================================================================
# Measurement
# ===========================================================================


def test_measure_reports_every_metric_it_can_support():
    m = measure(0.93, BOX, landmarks(), textured_crop())
    assert m.face_size_px == 200
    assert m.inter_eye_px == pytest.approx(70.0)
    assert m.sharpness is not None and m.sharpness > 100
    assert 100 < m.brightness < 160
    assert m.landmarks_plausible is True


def test_blur_lowers_the_measured_sharpness():
    crop = textured_crop()
    sharp = measure(0.9, BOX, landmarks(), crop).sharpness
    blurred = measure(
        0.9, BOX, landmarks(), cv2.GaussianBlur(crop, (0, 0), 3)
    ).sharpness
    assert blurred < sharp / 10


def test_sharpness_is_measured_at_a_fixed_size():
    # The same content at 224px and 112px must measure alike, or a threshold
    # would mean different things for near and far faces.
    crop = cv2.GaussianBlur(textured_crop(), (0, 0), 1.0)
    big = cv2.resize(crop, (224, 224), interpolation=cv2.INTER_CUBIC)
    a = measure(0.9, BOX, landmarks(), crop).sharpness
    b = measure(0.9, BOX, landmarks(), big).sharpness
    assert b == pytest.approx(a, rel=0.35)


def test_without_a_crop_or_landmarks_the_metrics_are_unavailable_not_zero():
    m = measure(0.9, BOX, None, None)
    assert m.sharpness is None and m.brightness is None
    assert m.yaw_deg is None and m.landmarks_plausible is None
    wire = metrics_from(m)
    assert wire.blur.status == "unavailable"
    assert wire.pose.status == "unavailable"
    assert wire.face_size.status == "measured"


def test_occlusion_is_never_reported_as_measured():
    wire = metrics_from(measure(0.9, BOX, landmarks(), textured_crop()))
    assert wire.occlusion.status == "unavailable"
    assert wire.pose.unit == "degrees_estimate"


def test_clipped_pixels_are_counted():
    dark = measure(0.9, BOX, landmarks(), np.full((112, 112, 3), 5, np.uint8))
    bright = measure(0.9, BOX, landmarks(), np.full((112, 112, 3), 252, np.uint8))
    assert dark.underexposed_fraction == 1.0
    assert bright.overexposed_fraction == 1.0


# ===========================================================================
# Evaluation
# ===========================================================================


def test_a_good_face_passes_both_profiles_with_a_high_score():
    for profile in (ENROLLMENT_PROFILE, GROUP_PROFILE):
        verdict = evaluate(good(), profile)
        assert verdict.ok, profile.name
        assert verdict.score >= 0.9


@pytest.mark.parametrize(
    "overrides, reason",
    [
        ({"face_size_px": 40.0}, "face_too_small"),
        ({"sharpness": 20.0}, "blurred"),
        ({"brightness": 30.0}, "too_dark"),
        ({"underexposed_fraction": 0.5}, "too_dark"),
        ({"brightness": 235.0}, "too_bright"),
        ({"overexposed_fraction": 0.4}, "too_bright"),
        ({"yaw_deg": 50.0}, "bad_angle"),
        ({"pitch_deg": -45.0}, "bad_angle"),
        ({"roll_deg": 60.0}, "bad_angle"),
        ({"detection_confidence": 0.5}, "occluded"),
        ({"landmarks_plausible": False}, "low_quality"),
    ],
)
def test_each_enrolment_check_fires_on_its_own(overrides, reason):
    verdict = evaluate(good(**overrides), ENROLLMENT_PROFILE)
    assert verdict.reasons == [reason]
    assert verdict.score <= 0.49


def test_every_failure_is_reported_most_actionable_first():
    verdict = evaluate(
        good(face_size_px=30.0, sharpness=5.0, brightness=20.0, yaw_deg=60.0),
        ENROLLMENT_PROFILE,
    )
    assert verdict.reasons == ["face_too_small", "bad_angle", "too_dark", "blurred"]
    assert verdict.primary == "face_too_small"


def test_the_group_profile_is_more_lenient_than_enrolment():
    # A back-row face: acceptable in a group photo, refused as a template.
    back_row = good(face_size_px=40.0, sharpness=40.0, brightness=45.0)
    assert not evaluate(back_row, ENROLLMENT_PROFILE).ok
    assert evaluate(back_row, GROUP_PROFILE).ok


def test_a_small_but_passing_face_scores_lower_than_a_large_one():
    small = evaluate(good(face_size_px=34.0), GROUP_PROFILE)
    large = evaluate(good(face_size_px=120.0), GROUP_PROFILE)
    assert small.ok and large.ok
    assert small.score < large.score


def test_the_embeddable_floor_is_below_the_group_flag():
    # A face between the two is embedded *and* flagged, so it is matched but
    # only ever sent to review. Below the floor it is not embedded at all.
    assert MIN_EMBEDDABLE_FACE_PX < GROUP_PROFILE.min_face_px


def test_profiles_are_internally_consistent():
    for p in (ENROLLMENT_PROFILE, GROUP_PROFILE):
        assert p.min_face_px < p.good_face_px
        assert p.min_sharpness < p.good_sharpness
        assert p.min_detection_confidence < p.good_detection_confidence
        assert p.min_brightness < p.max_brightness
