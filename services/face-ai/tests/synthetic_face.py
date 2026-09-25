"""A drawn face, for testing measurements that need a face's structure.

Not a photograph of anybody, and deliberately so: the repository commits no
photographs (docs/CALIBRATION.md). But a sharpness measure cannot be tested
on noise — noise has no eyelids, brows or lips, and those strong edges are
exactly what the enrolment gate measures. So this draws them: brows, eyes
with lids and irises, nostrils and lips on a skin-toned head with a little
texture, placed exactly where ``face_landmarks`` says Azure found them.

Drawn at four times the size and reduced with area averaging, so edges are
as sharp as a well-focused camera would record and no sharper. Deterministic:
the same arguments always give the same pixels.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np

from tests.test_dlib_recognition import landmarks as face_landmarks

#: Face box to inter-ocular distance, as in the provider tests' ``face()``.
IOD_PER_BOX = 0.45
_SUPERSAMPLE = 4


def _pt(cx: float, cy: float, iod: float, x: float, y: float) -> tuple[int, int]:
    s = _SUPERSAMPLE
    return (round((cx + x * iod) * s), round((cy + y * iod) * s))


def _axes(iod: float, a: float, b: float) -> tuple[int, int]:
    s = _SUPERSAMPLE
    return (max(1, round(a * iod * s)), max(1, round(b * iod * s)))


def render_face(
    face_px: float,
    *,
    width: int = 1280,
    height: int = 720,
    background: str = "flat",
    seed: int = 3,
    eyes: str = "open",
) -> tuple[np.ndarray, dict[str, Any]]:
    """A BGR frame with one face whose box is ``face_px`` wide, and the Azure
    detect entry for it (box, 27-point landmark names, clean attributes).

    ``eyes="closed"`` draws the lids shut — skin where the eye was, a lash
    line across it — with the corners where they were, as Azure still finds
    them on a blink."""
    iod = face_px * IOD_PER_BOX
    cx, cy = width / 2.0, height / 2.0
    s = _SUPERSAMPLE
    canvas = np.empty((height * s, width * s, 3), np.uint8)
    rng = np.random.default_rng(seed)
    if background == "flat":
        canvas[:] = (205, 205, 200)
    elif background == "textured":
        # Hard-edged, high-contrast clutter: a bookshelf, a patterned wall.
        small = rng.integers(0, 256, (height // 6 + 1, width // 6 + 1, 3), np.uint8)
        canvas[:] = cv2.resize(
            small, (width * s, height * s), interpolation=cv2.INTER_NEAREST
        )
    else:
        raise ValueError(background)

    def p(x: float, y: float) -> tuple[int, int]:
        return _pt(cx, cy, iod, x, y)

    def ax(a: float, b: float) -> tuple[int, int]:
        return _axes(iod, a, b)

    def px(fraction: float) -> int:
        return max(1, round(fraction * iod * s))

    aa = cv2.LINE_AA
    skin, dark, lid = (120, 150, 200), (40, 45, 55), (60, 70, 95)
    white, iris, pupil = (235, 238, 240), (40, 70, 110), (15, 15, 15)
    nostril, alar = (50, 60, 90), (90, 110, 160)
    cv2.ellipse(canvas, p(0, 0.18), ax(0.98, 1.3), 0, 0, 360, skin, -1, aa)
    cv2.ellipse(canvas, p(0, -0.72), ax(1.02, 0.62), 0, 180, 360, dark, -1, aa)
    for side in (-1, 1):
        eye = p(side * 0.5, -0.15)
        brow = p(side * 0.5, -0.36)
        cv2.ellipse(canvas, brow, ax(0.27, 0.09), 0, 190, 350, dark, px(0.075), aa)
        if eyes == "closed":
            cv2.ellipse(canvas, eye, ax(0.17, 0.075), 0, 0, 180, lid, px(0.03), aa)
        elif eyes == "open":
            cv2.ellipse(canvas, eye, ax(0.17, 0.075), 0, 0, 360, white, -1, aa)
            cv2.circle(canvas, eye, px(0.068), iris, -1, aa)
            cv2.circle(canvas, eye, px(0.03), pupil, -1, aa)
            cv2.ellipse(canvas, eye, ax(0.17, 0.075), 0, 180, 360, lid, px(0.025), aa)
        else:
            raise ValueError(eyes)
        nose = p(side * 0.11, 0.37)
        cv2.ellipse(canvas, nose, ax(0.055, 0.03), side * 20, 0, 360, nostril, -1, aa)
        wing = p(side * 0.16, 0.31)
        start_deg, end_deg = 90 - side * 70, 90 + side * 70
        cv2.ellipse(
            canvas, wing, ax(0.06, 0.07), 0, start_deg, end_deg, alar, px(0.02), aa
        )
    cv2.ellipse(canvas, p(0, 0.65), ax(0.3, 0.075), 0, 0, 360, (80, 80, 170), -1, aa)
    cv2.line(canvas, p(-0.3, 0.65), p(0.3, 0.65), (45, 40, 90), px(0.02), aa)

    frame = cv2.resize(canvas, (width, height), interpolation=cv2.INTER_AREA)
    # A little skin texture and sensor noise, as any camera records.
    noise = rng.normal(0.0, 3.0, frame.shape)
    frame = np.clip(frame.astype(np.float64) + noise, 0, 255).astype(np.uint8)

    box = face_px
    detection = {
        "faceRectangle": {
            "left": cx - box / 2, "top": cy - box / 2, "width": box, "height": box,
        },
        "faceLandmarks": face_landmarks(cx=cx, cy=cy, iod=iod),
        "faceAttributes": {
            "headPose": {"pitch": 0.0, "roll": 0.0, "yaw": 0.0},
            "blur": {"blurLevel": "low", "value": 0.0},
            "exposure": {"exposureLevel": "goodExposure", "value": 0.5},
            "occlusion": {
                "foreheadOccluded": False,
                "eyeOccluded": False,
                "mouthOccluded": False,
            },
            "mask": {"type": "noMask", "noseAndMouthCovered": False},
            "qualityForRecognition": "high",
        },
    }
    return frame, detection


def recogniser_scale(face_px: float) -> float:
    """Source pixels per pixel of the recogniser's 150px chip, for a face of
    this box size: the outer eye corners are 1.32 inter-ocular distances
    apart here, and 73.9 chip pixels apart in dlib's template."""
    return (1.32 * face_px * IOD_PER_BOX) / 73.9


def gaussian_blur(
    frame: np.ndarray, face_px: float, sigma_chip: float
) -> np.ndarray:
    """Blur of ``sigma_chip`` pixels as the recogniser would experience it."""
    return cv2.GaussianBlur(frame, (0, 0), sigma_chip * recogniser_scale(face_px))


def motion_blur(
    frame: np.ndarray, face_px: float, length_chip: float, angle: float = 30.0
) -> np.ndarray:
    """Camera shake of ``length_chip`` recogniser pixels at ``angle`` degrees."""
    length = length_chip * recogniser_scale(face_px)
    n = max(3, math.ceil(length) | 1)
    kernel = np.zeros((n, n), np.float32)
    c = n // 2
    a = math.radians(angle)
    for t in np.linspace(-length / 2, length / 2, max(2, int(length * 4))):
        kernel[round(c + t * math.sin(a)), round(c + t * math.cos(a))] = 1.0
    return cv2.filter2D(frame, -1, kernel / kernel.sum())


def jpeg(frame: np.ndarray, quality: int) -> np.ndarray:
    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return cv2.imdecode(buffer, cv2.IMREAD_COLOR)


def head_mask(detection: dict[str, Any], shape: tuple[int, ...]) -> np.ndarray:
    """Where the drawn head is, as booleans — to blur the face and keep the
    background sharp, or the other way round."""
    rect = detection["faceRectangle"]
    iod = rect["width"] * IOD_PER_BOX
    cx = rect["left"] + rect["width"] / 2.0
    cy = rect["top"] + rect["height"] / 2.0 + 0.18 * iod
    rows, cols = np.mgrid[0 : shape[0], 0 : shape[1]]
    return ((cols - cx) / (0.98 * iod)) ** 2 + ((rows - cy) / (1.3 * iod)) ** 2 <= 1.0
