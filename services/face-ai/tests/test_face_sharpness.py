"""The enrolment blur measure: the properties it was calibrated to have.

The calibration itself used 346 real portraits (docs/CALIBRATION.md,
bench/enrollment_sharpness.py) and is not repeated here: the repository
commits no photographs. These tests pin the properties on a drawn face
instead — a sharp face passes whatever the resolution, compression,
exposure or background; a blurred or shaken one does not — and the
calibrated constants, so that changing either is a deliberate act.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.models.dlib_recognition import five_points
from app.models.face_sharpness import (
    MAX_ENROLLMENT_BLUR,
    MEASURE_VERSION,
    blur_effect,
    face_mask,
    measure_blur,
)
from tests.synthetic_face import (
    gaussian_blur,
    head_mask,
    jpeg,
    motion_blur,
    render_face,
)

SIZES = (110, 160, 240, 400)


def blur_of(frame: np.ndarray, detection: dict) -> float:
    box = detection["faceRectangle"]["width"]
    points = five_points(detection["faceLandmarks"], box)
    return measure_blur(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), points)


def test_the_threshold_and_measure_are_the_calibrated_ones():
    # A new number without a new calibration is a guess wearing a decimal
    # point. Change these together with docs/CALIBRATION.md, or not at all.
    assert MAX_ENROLLMENT_BLUR == 0.65
    assert MEASURE_VERSION == "1"


@pytest.mark.parametrize("face_px", SIZES)
@pytest.mark.parametrize("background", ["flat", "textured"])
def test_a_sharp_face_is_accepted(face_px, background):
    frame, detection = render_face(face_px, background=background)
    assert blur_of(jpeg(frame, 92), detection) <= MAX_ENROLLMENT_BLUR


@pytest.mark.parametrize("face_px", SIZES)
def test_a_genuinely_blurred_face_is_refused(face_px):
    # 2.5 recogniser pixels: on real portraits every capture this blurred was
    # refused, and it cost the template 0.016 of genuine similarity.
    frame, detection = render_face(face_px)
    blurred = jpeg(gaussian_blur(frame, face_px, 2.5), 92)
    assert blur_of(blurred, detection) > MAX_ENROLLMENT_BLUR


@pytest.mark.parametrize("angle", [0, 45, 90, 135])
def test_camera_shake_is_refused_in_any_direction(angle):
    # Measured along the axes alone, an 8px diagonal shake on real faces was
    # caught 70% of the time against 100% horizontally. Diagonals now count.
    frame, detection = render_face(200)
    shaken = jpeg(motion_blur(frame, 200, 16, angle), 92)
    assert blur_of(shaken, detection) > MAX_ENROLLMENT_BLUR


@pytest.mark.parametrize("quality", [92, 75, 50])
def test_browser_jpeg_compression_does_not_read_as_blur(quality):
    # The camera path encodes at 0.92; uploads arrive at whatever the phone
    # chose. Neither may turn a sharp face into a blurred one.
    frame, detection = render_face(180)
    reference = blur_of(jpeg(frame, 92), detection)
    compressed = blur_of(jpeg(frame, quality), detection)
    assert compressed <= MAX_ENROLLMENT_BLUR
    assert abs(compressed - reference) < 0.02


def test_resolution_does_not_change_the_decision():
    # The same face, captured closer or further, gets the same verdict: the
    # measure works at the recogniser's scale, reached by area averaging.
    sharp = [blur_of(jpeg(render_face(px)[0], 92), render_face(px)[1]) for px in SIZES]
    blurred = []
    for px in SIZES:
        frame, detection = render_face(px)
        blurred.append(blur_of(jpeg(gaussian_blur(frame, px, 2.5), 92), detection))
    assert max(sharp) <= MAX_ENROLLMENT_BLUR < min(blurred)
    assert max(sharp) - min(sharp) < 0.05
    assert max(blurred) - min(blurred) < 0.05


def test_a_plain_or_busy_background_does_not_decide():
    # The old failure mode of whole-image sharpness: a plain wall makes a
    # sharp face "blurred", a bookshelf makes a blurred face "sharp".
    plain, detection = render_face(240, background="flat")
    busy, _ = render_face(240, background="textured")
    on_plain = blur_of(jpeg(plain, 92), detection)
    on_busy = blur_of(jpeg(busy, 92), detection)
    assert abs(on_plain - on_busy) < 0.01

    # A blurred face in front of a pin-sharp, high-contrast background.
    blurred = gaussian_blur(busy, 240, 2.5)
    inside = head_mask(detection, busy.shape)
    composite = np.where(inside[..., None], blurred, busy)
    assert blur_of(jpeg(composite, 92), detection) > MAX_ENROLLMENT_BLUR


@pytest.mark.parametrize("gain, offset", [(0.45, 0), (1.3, 25)])
def test_lighting_does_not_read_as_blur(gain, offset):
    # Exposure has its own check and its own message.
    frame, detection = render_face(200)
    lit = np.clip(frame.astype(np.float64) * gain + offset, 0, 255).astype(np.uint8)
    assert blur_of(jpeg(lit, 92), detection) <= MAX_ENROLLMENT_BLUR


def test_the_measure_is_deterministic():
    frame, detection = render_face(200)
    image = jpeg(gaussian_blur(frame, 200, 1.0), 92)
    assert blur_of(image, detection) == blur_of(image, detection)


def test_a_region_with_nothing_in_it_is_fully_blurred():
    assert blur_effect(np.full((97, 90), 128.0)) == 1.0


def test_the_face_mask_leaves_out_the_jaw_corners():
    mask = face_mask((97, 90))
    assert mask[48, 45]  # the middle of the face
    assert not mask[96, 0] and not mask[96, 89]  # below the jaw, at the sides
    assert 0.6 < mask.mean() < 0.9
