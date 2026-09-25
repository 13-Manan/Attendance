"""How blurred a face is, measured at the scale the recogniser sees it.

Used by the ``azure_detection_own_recognition`` backend's enrolment gate. It
replaces Azure's ``blur`` attribute for that decision, for a measured reason:
Azure's blur rating rises as a face gets *smaller*, whether or not it is
blurred. On the calibration portraits, sharp faces merely resampled to 96px
were rated "low" (the only level enrolment accepted) 37% of the time, and at
64px never. The enrolment size floor is 100px, so ordinary webcam captures
from a little way back were refused with "hold the camera steady" when there
was nothing to hold steady (docs/CALIBRATION.md, "Enrolment sharpness").

## What is measured

1. **The face, not the photograph.** The five alignment points place the face
   in dlib's template frame, and only an ellipse inside it — brows to mouth,
   cheek to cheek — is measured. A rectangle is not enough: its lower corners
   reach past the jaw, and a sharp, busy background there moved the measure
   of the same face by 0.06; inside the ellipse, by 0.002. Background texture
   cannot make a blurred face pass, and a plain wall cannot make a sharp face
   fail.
2. **At the recogniser's scale.** The recogniser sees the face in a 150px
   chip, so that is the scale that matters: blur a camera spreads over two
   pixels of a 600px face is invisible to it. The face is reduced to that
   scale with area averaging *before* it is rotated into place. dlib's own
   chip extraction does not do this — it samples from a power-of-two pyramid
   level — and a measure taken on its chip steps with face size (on the
   calibration set the Laplacian variance of the chip went 243, 769, 227 at
   faces of 100, 200 and 256px), which is a measurement of the resampler.
3. **The blur effect** (Crete-Roffet et al., "The Blur Effect", SPIE 2007):
   how much of the face's gradient survives being blurred again. A sharp face
   loses most of it; an already-blurred one loses little. It is a ratio of
   the image with itself, so a darker, brighter or lower-contrast photograph
   of the same face scores the same.
4. **Over the strongest edges only** — the top tenth of gradients: eyelids,
   brows, nostrils, lips. Skin texture and sensor noise make up the rest.
   Measured over every pixel, the effect read smooth skin (a phone's beauty
   mode, and very likely a child's face) as blur 17% of the time, and let
   42% of noisy low-light blur through; over the strongest edges, 4% and 4%.
5. **In four directions**, the worst of which decides — see ``_directions``.

Deterministic: closed-form alignment, fixed filters, no randomness.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from functools import lru_cache

import numpy as np

from app.models.dlib_recognition import CHIP_PADDING, CHIP_SIZE, TEMPLATE5

#: Bump when anything below changes what a number means: the region, the
#: filters, the edge fraction or the resampling. The threshold is calibrated
#: against one version and is meaningless against another.
MEASURE_VERSION = "1"

#: Rows and columns of the aligned 150px face that are measured: eyebrows to
#: mouth, and cheek to cheek. The corners are hair, ears and background.
REGION_ROWS = (0.20, 0.85)
REGION_COLS = (0.20, 0.80)

#: Within that rectangle, only an ellipse is counted: centred 45% of the way
#: down, reaching the sides at mid-height and the bottom at the centre, so
#: the jaw's corners — where the background shows — are left out.
MASK_CENTRE_ROW = 0.45
MASK_HALF_HEIGHT = 0.55
MASK_HALF_WIDTH = 0.50

#: Length of the line the face is re-blurred along, in recogniser pixels:
#: 7 taps along the axes, 5 along the diagonals (5 diagonal steps are 7.1px).
REBLUR_PX = 7
_REBLUR_DIAGONAL_TAPS = 5

#: Fraction of the region's strongest gradients the measure is taken over.
EDGE_FRACTION = 0.10

#: Above this the face is too blurred to enrol.
#:
#: Calibrated, not chosen: 346 portraits at face sizes 100 to 400px, JPEG
#: quality 50 to 92, under 20 conditions, through this exact code. The
#: criterion was fixed before the number: refuse 95% of captures blurred by
#: 1.5 recogniser pixels, the first level that costs a template more than
#: 0.005 of genuine similarity (6.6 points of present-rate). That lands at
#: 0.6525. At 0.65:
#:   * blur of 1.5px is refused 96% of the time, 2px and above always, 8px
#:     camera shake in any direction 99.5%, 2.5px defocus 89%, blur under
#:     sensor noise 96%;
#:   * a clean capture is refused 0.5% of the time, and every one of those
#:     came from two source photographs that are themselves soft — one Azure
#:     also rates blurred — refused alike at every size;
#:   * face size, JPEG quality and exposure do not move the decision.
#: The numbers, and what they do not establish, are in docs/CALIBRATION.md.
MAX_ENROLLMENT_BLUR = 0.65

#: dlib's five template points in chip pixels — the same frame
#: DlibResNetEmbedder aligns into.
_TEMPLATE_CHIP = np.array(
    [
        (
            (CHIP_PADDING + x) / (2 * CHIP_PADDING + 1) * CHIP_SIZE,
            (CHIP_PADDING + y) / (2 * CHIP_PADDING + 1) * CHIP_SIZE,
        )
        for x, y in TEMPLATE5
    ],
    dtype=np.float64,
)


def _similarity(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """The least-squares similarity transform taking ``src`` onto ``dst``,
    as a 2x3 matrix (Umeyama, 1991). Closed form, so the same points always
    give the same transform — a robust estimator's random sampling would not.
    """
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    s, d = src - mu_s, dst - mu_d
    var_s = float((s**2).sum()) / len(src)
    u, sigma, vt = np.linalg.svd(d.T @ s / len(src))
    flip = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        flip[1, 1] = -1.0
    rotation = u @ flip @ vt
    scale = float(np.trace(np.diag(sigma) @ flip)) / var_s
    translation = mu_d - scale * rotation @ mu_s
    return np.hstack([scale * rotation, translation[:, None]])


def canonical_face(
    rgb: np.ndarray, points: Sequence[tuple[float, float]]
) -> np.ndarray:
    """The measured region of the face, grey, at the recogniser's scale.

    ``rgb`` is the decoded original (HxWx3 uint8); ``points`` are the five
    alignment points in dlib's order, in its pixels — what
    ``dlib_recognition.five_points`` returns.
    """
    import cv2

    src = np.asarray(points, dtype=np.float64)
    transform = _similarity(src, _TEMPLATE_CHIP)
    scale = math.hypot(transform[0, 0], transform[1, 0])  # chip px per source px
    image = rgb
    if scale < 1.0:
        # Reduce first, by area averaging, so every source pixel counts once
        # and nothing aliases. Only the neighbourhood of the face is reduced.
        half = 0.75 * CHIP_SIZE / scale
        cx, cy = src.mean(axis=0)
        x0, y0 = max(0, math.floor(cx - half)), max(0, math.floor(cy - half))
        x1 = min(rgb.shape[1], math.ceil(cx + half))
        y1 = min(rgb.shape[0], math.ceil(cy + half))
        crop = rgb[y0:y1, x0:x1]
        width = max(1, round(crop.shape[1] * scale))
        height = max(1, round(crop.shape[0] * scale))
        image = cv2.resize(crop, (width, height), interpolation=cv2.INTER_AREA)
        reduced = (src - (x0, y0)) * (width / crop.shape[1], height / crop.shape[0])
        transform = _similarity(reduced, _TEMPLATE_CHIP)
    face = cv2.warpAffine(
        image,
        transform,
        (CHIP_SIZE, CHIP_SIZE),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT,
    )
    grey = cv2.cvtColor(face, cv2.COLOR_RGB2GRAY)
    r0, r1 = (int(CHIP_SIZE * f) for f in REGION_ROWS)
    c0, c1 = (int(CHIP_SIZE * f) for f in REGION_COLS)
    return grey[r0:r1, c0:c1].astype(np.float64)


@lru_cache(maxsize=8)
def face_mask(shape: tuple[int, int]) -> np.ndarray:
    """The elliptical part of a measured region that is face, as booleans."""
    height, width = shape
    rows, cols = np.mgrid[0:height, 0:width]
    return (
        ((rows - MASK_CENTRE_ROW * height) / (MASK_HALF_HEIGHT * height)) ** 2
        + ((cols - width / 2.0) / (MASK_HALF_WIDTH * width)) ** 2
    ) <= 1.0


def _directions() -> tuple[tuple[np.ndarray, np.ndarray], ...]:
    """(derivative kernel, re-blur kernel) for each direction measured.

    Four, not two. Camera shake is as often diagonal as not, and measured
    along the axes alone an 8px diagonal shake was caught 70% of the time
    against 100% for the same shake horizontally. The derivative kernels are
    Sobel's, and its 45-degree rotations; each re-blur runs along the same
    direction as its derivative.
    """
    sobel_x = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], np.float64)
    down_right = np.array([[-2, -1, 0], [-1, 0, 1], [0, 1, 2]], np.float64)
    up_right = np.array([[0, 1, 2], [-1, 0, 1], [-2, -1, 0]], np.float64)
    taps = _REBLUR_DIAGONAL_TAPS
    return (
        (sobel_x, np.full((1, REBLUR_PX), 1.0 / REBLUR_PX)),
        (sobel_x.T.copy(), np.full((REBLUR_PX, 1), 1.0 / REBLUR_PX)),
        (down_right, np.eye(taps) / taps),
        (up_right, np.fliplr(np.eye(taps)).copy() / taps),
    )


_DIRECTIONS = _directions()


def blur_effect(region: np.ndarray) -> float:
    """0 for a perfectly sharp region, towards 1 as it blurs.

    Per direction: the gradient of the region, against the gradient of the
    region blurred again along that direction, over the pixels inside the
    face mask where the original gradient is in the strongest
    ``EDGE_FRACTION``. The worst of the four directions is the answer, so
    motion blur in any direction counts. A region with no gradient at all
    has nothing sharp in it and scores 1.
    """
    import cv2

    mask = face_mask(region.shape[:2])[2:-1, 2:-1]
    worst = 0.0
    for derivative, reblur in _DIRECTIONS:
        sharp = np.abs(cv2.filter2D(region, cv2.CV_64F, derivative))[2:-1, 2:-1]
        reblurred = cv2.filter2D(region, cv2.CV_64F, reblur)
        soft = np.abs(cv2.filter2D(reblurred, cv2.CV_64F, derivative))[2:-1, 2:-1]
        cutoff = np.percentile(sharp[mask], 100.0 * (1.0 - EDGE_FRACTION))
        edges = mask & (sharp >= cutoff)
        total = float(sharp[edges].sum())
        if not total > 0.0:
            return 1.0
        kept = float(np.maximum(0.0, sharp - soft)[edges].sum())
        worst = max(worst, (total - kept) / total)
    return worst


def measure_blur(rgb: np.ndarray, points: Sequence[tuple[float, float]]) -> float:
    """The blur of the face at ``points`` in ``rgb``. Compare with
    ``MAX_ENROLLMENT_BLUR``."""
    return blur_effect(canonical_face(rgb, points))


def face_core_outside(
    points: Sequence[tuple[float, float]], width: int, height: int
) -> float:
    """The share of the face's core that lies outside the photograph.

    The core is dlib's template square — eyes, nose and mouth, without the
    chip's padding — mapped back into the photograph from the five points.
    Azure clamps a face *rectangle* to the edge of the image, so the rectangle
    cannot say a face was cut off; its landmarks, though, are extrapolated
    beyond the edge, so the points can. Measured on an 11x11 grid: coarse,
    exact enough for "is a real part of this face missing", and cheap.
    """
    src = np.asarray(points, dtype=np.float64)
    to_photo = _similarity(_TEMPLATE_CHIP, src)
    lo = CHIP_PADDING / (2 * CHIP_PADDING + 1) * CHIP_SIZE
    hi = (1 + CHIP_PADDING) / (2 * CHIP_PADDING + 1) * CHIP_SIZE
    grid = np.linspace(lo, hi, 11)
    xs, ys = np.meshgrid(grid, grid)
    square = np.stack([xs.ravel(), ys.ravel(), np.ones(xs.size)])
    px, py = to_photo @ square
    outside = (px < 0) | (py < 0) | (px >= width) | (py >= height)
    return float(outside.mean())
