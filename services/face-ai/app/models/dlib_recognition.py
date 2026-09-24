"""Face recognition with dlib's ResNet, aligned on Azure Face's landmarks.

The ``azure_detection_own_recognition`` backend splits the work. Azure Face
finds each face and returns 27 landmarks for it. Everything that decides who
a face belongs to happens here, in this process: the face is aligned on
those landmarks, cut from the ORIGINAL image, and turned into a 128-d
descriptor by dlib's ResNet v1 (``dlib_face_recognition_resnet_model_v1``).
The weights are public domain; docs/MODEL_LICENSES.md has the evidence.

## Alignment

The network was trained on 150x150 chips aligned by dlib's own 5-point
landmark model: the outer and inner corner of each eye, and the base of the
nose. A chip means what the network expects only if those five points land
where they did in training. Azure supplies the four eye corners directly.
It has no point at the base of the nose, so the fifth point is the midpoint
of the two alar out-tips moved by ``NOSE_OFFSET``, a fixed offset measured
along and across the eye line. The offset is the median over 151 public-domain
portraits of dlib's own nose point relative to that midpoint. On 61 held-out
portraits it cut the median nose error from 0.161 to 0.032 inter-eye
distances (docs/CALIBRATION.md).

Azure names landmarks from the viewer's side: ``eyeLeftOuter`` is on the
image's left, which is the subject's right eye. dlib's part 0 is the
subject's left eye outer corner, on the image's right. So dlib's order,
expressed in Azure's names, is eyeRightOuter, eyeRightInner, eyeLeftOuter,
eyeLeftInner, nose. That was checked on all 212 evaluation portraits.

Landmarks that are not a plausible face (corners out of order, the nose
above the eyes, eyes a few pixels apart) are refused with ``LandmarkError``.
The face is then reported as ``alignment_failed``. It is never warped anyway
and never replaced by an unaligned crop: a chip the network did not expect
yields a vector that is confidently wrong.

## Determinism

``num_jitters=0``: no random augmentation, so the same chip always gives
the same vector. A batch of chips and the same chips one at a time agree to
within 4e-7. At load the network is run on a fixed synthetic chip and
compared with pinned values (``GOLDEN_*``). A dlib build that computes
something else, whether a different BLAS, a miscompiled SIMD path or other
weights, then fails startup. It does not quietly write templates that
nothing else can match.

dlib picks SSE4/AVX when the machine that built it supports them. Every x86
host Azure Container Apps runs on has AVX. A host without it would stop the
process with SIGILL during ``load()``. That is loud, and it happens at startup.

## Threads

dlib's network objects are not thread-safe, and a call holds the GIL for
its whole run. One lock per embedder serialises calls. Parallelism comes
from gunicorn's worker processes, each of which has its own network.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

#: Bumped whenever the landmarks used, NOSE_OFFSET, the template, the chip
#: size or the padding changes. Every stored template becomes incomparable.
ALIGNMENT_VERSION = "1"

#: Side of the square chip the network takes, in pixels.
CHIP_SIZE = 150
#: Border around the landmark template, as a fraction of its size. dlib's
#: own face-recognition example uses 0.25, and the network was trained on it.
CHIP_PADDING = 0.25

#: dlib's 5-point template on the unit square (``get_face_chip_details`` in
#: dlib/image_transforms/interpolation.h). Order: subject's left eye outer and
#: inner corner, subject's right eye outer and inner corner, base of the nose.
TEMPLATE5: tuple[tuple[float, float], ...] = (
    (0.8595674595992, 0.2134981538014),
    (0.6460604764104, 0.2289674387677),
    (0.1205750620789, 0.2137274526848),
    (0.3340850613712, 0.2290642403242),
    (0.4901123135679, 0.6277975316475),
)

#: Where dlib's nose point sits relative to the midpoint of Azure's alar
#: out-tips, in inter-eye distances: (along the eye line, down the face).
NOSE_OFFSET: tuple[float, float] = (-0.001100807018308061, 0.16405299261139153)

#: Below this (the shorter side of Azure's face box, in pixels) a face is not
#: embedded at all. Upscaling a smaller face to 150px invents the detail the
#: network keys on. At 36px, Azure's own floor, genuine scores already
#: overlap impostors (docs/CALIBRATION.md).
MIN_EMBEDDABLE_FACE_PX = 32.0

#: Chips per call into the network. Bounds the memory one call can take.
EMBED_BATCH = 16

#: The six Azure landmarks alignment reads.
REQUIRED_LANDMARKS = (
    "eyeLeftOuter",
    "eyeLeftInner",
    "eyeRightInner",
    "eyeRightOuter",
    "noseLeftAlarOutTip",
    "noseRightAlarOutTip",
)

#: Eyes closer together than this (pixels, or this fraction of the face box)
#: are not a face that can be aligned.
MIN_EYE_DISTANCE_PX = 3.0
MIN_EYE_DISTANCE_FRACTION = 0.1

#: The network's output on ``golden_chip()``, computed with dlib 20.0.1 and
#: the pinned weights. Unnormalised. Checked at every load.
GOLDEN_NORM = 1.298208669789581
GOLDEN_HEAD: tuple[float, ...] = (
    -0.063602917, 0.129760623, 0.072018318, 0.002636777,
    -0.063974276, -0.038465153, -0.068588816, 0.001012176,
    0.090841495, 0.002325958, 0.241057768, -0.02888887,
    -0.249031261, -0.017964661, -0.027559403, 0.095145784,
)
#: Loose enough for another BLAS or SIMD path, tight enough to catch a real
#: fault. Swapping the chip's colour order moves the head by 0.105;
#: transposing it moves it by 0.104.
GOLDEN_MAX_ABS_DIFF = 2e-3
GOLDEN_MIN_COSINE = 0.9999
GOLDEN_NORM_RTOL = 1e-3


class LandmarkError(ValueError):
    """The landmarks cannot align this face."""


class RecognizerSelfTestError(RuntimeError):
    """dlib computed something other than the pinned output. The build or
    the weights are not what was validated."""


def golden_chip() -> np.ndarray:
    """A fixed 150x150 RGB pattern with structure in every channel."""
    y, x, c = np.mgrid[0:CHIP_SIZE, 0:CHIP_SIZE, 0:3]
    return ((x * 7 + y * 13 + c * 50) % 256).astype(np.uint8)


def _point(landmarks: Mapping[str, Any], name: str) -> np.ndarray:
    try:
        raw = landmarks[name]
        point = np.array([float(raw["x"]), float(raw["y"])], dtype=np.float64)
    except (KeyError, TypeError, ValueError) as error:
        raise LandmarkError(f"landmark {name} is missing or malformed") from error
    if not np.all(np.isfinite(point)):
        raise LandmarkError(f"landmark {name} is not a finite point")
    return point


def five_points(
    landmarks: Mapping[str, Any], face_size: float
) -> list[tuple[float, float]]:
    """dlib's five alignment points, in image pixels, from Azure's landmarks.

    Checked in the face's own frame, so the checks hold at any roll: x runs
    along the eye line from the image-left eye to the image-right eye, and y
    runs down the face. Raises ``LandmarkError`` if the points are not
    plausibly a face.
    """
    p = {name: _point(landmarks, name) for name in REQUIRED_LANDMARKS}
    left_eye = (p["eyeLeftOuter"] + p["eyeLeftInner"]) / 2.0
    right_eye = (p["eyeRightOuter"] + p["eyeRightInner"]) / 2.0
    across = right_eye - left_eye
    eye_distance = float(np.linalg.norm(across))
    if eye_distance < max(MIN_EYE_DISTANCE_PX, MIN_EYE_DISTANCE_FRACTION * face_size):
        raise LandmarkError("the eyes are too close together to align")
    ex = across / eye_distance
    ey = np.array([-ex[1], ex[0]])

    def along(name: str) -> float:
        return float((p[name] - left_eye) @ ex)

    # Outer corner, inner corner, inner corner, outer corner, left to right.
    if not (
        along("eyeLeftOuter")
        < along("eyeLeftInner")
        < along("eyeRightInner")
        < along("eyeRightOuter")
    ):
        raise LandmarkError("the eye corners are not in a face's order")

    alar_mid = (p["noseLeftAlarOutTip"] + p["noseRightAlarOutTip"]) / 2.0
    if float((alar_mid - left_eye) @ ey) <= 0.0:
        raise LandmarkError("the nose is not below the eyes")
    nose_along = float((alar_mid - left_eye) @ ex)
    if not along("eyeLeftOuter") < nose_along < along("eyeRightOuter"):
        raise LandmarkError("the nose is outside the span of the eyes")

    nose = alar_mid + (NOSE_OFFSET[0] * ex + NOSE_OFFSET[1] * ey) * eye_distance
    ordered = (
        p["eyeRightOuter"],
        p["eyeRightInner"],
        p["eyeLeftOuter"],
        p["eyeLeftInner"],
        nose,
    )
    return [(float(point[0]), float(point[1])) for point in ordered]


def _unit(vector: Sequence[float], expected_dim: int) -> list[float]:
    values = np.asarray(vector, dtype=np.float64).reshape(-1)
    if values.shape[0] != expected_dim:
        raise RecognizerSelfTestError(
            f"the recogniser returned {values.shape[0]} values; "
            f"{expected_dim} were expected"
        )
    if not np.all(np.isfinite(values)):
        raise ValueError("the recogniser returned a non-finite value")
    norm = float(np.linalg.norm(values))
    if norm == 0.0:
        raise ValueError("the recogniser returned a zero vector")
    return (values / norm).tolist()


class DlibResNetEmbedder:
    """Chips in, unit-length 128-d descriptors out."""

    EMBEDDING_DIM = 128

    def __init__(self, weights_path: str | Path) -> None:
        self._weights_path = Path(weights_path)
        self._net: Any = None
        self._chip_points: Any = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._net is not None

    def load(self) -> None:
        """Load the network and prove it computes the pinned output.

        dlib is imported here, not at module import, so the other backends,
        and the tests that never embed, do not need it installed.
        """
        import dlib

        net = dlib.face_recognition_model_v1(str(self._weights_path))
        pad = CHIP_PADDING
        self._chip_points = dlib.dpoints(
            [
                dlib.dpoint(
                    (pad + x) / (2 * pad + 1) * CHIP_SIZE,
                    (pad + y) / (2 * pad + 1) * CHIP_SIZE,
                )
                for x, y in TEMPLATE5
            ]
        )
        self._check_golden(net)
        self._net = net

    @staticmethod
    def _check_golden(net: Any) -> None:
        output = np.asarray(
            net.compute_face_descriptor(golden_chip(), 0), dtype=np.float64
        )
        head = output[: len(GOLDEN_HEAD)]
        expected = np.asarray(GOLDEN_HEAD, dtype=np.float64)
        norm = float(np.linalg.norm(output))
        max_diff = float(np.max(np.abs(head - expected)))
        norms = np.linalg.norm(head) * np.linalg.norm(expected)
        cosine = float(head @ expected / norms)
        if (
            output.shape != (DlibResNetEmbedder.EMBEDDING_DIM,)
            or not math.isfinite(norm)
            or abs(norm - GOLDEN_NORM) > GOLDEN_NORM_RTOL * GOLDEN_NORM
            or max_diff > GOLDEN_MAX_ABS_DIFF
            or cosine < GOLDEN_MIN_COSINE
        ):
            raise RecognizerSelfTestError(
                "dlib's output on the golden chip does not match the pinned "
                f"values (max difference {max_diff:.2e}, cosine {cosine:.6f}, "
                f"norm {norm:.6f} against {GOLDEN_NORM:.6f}). Refusing to "
                "serve: this build would write templates that match nothing "
                "enrolled under the validated one."
            )

    def _require(self) -> tuple[Any, Any]:
        if self._net is None:
            raise RuntimeError("the dlib recogniser was used before load()")
        return self._net, self._chip_points

    def extract_chip(
        self, rgb: np.ndarray, points: Sequence[tuple[float, float]]
    ) -> np.ndarray:
        """The 150x150 aligned chip for one face, sampled from ``rgb``.

        ``rgb`` is the original decoded image, RGB, uint8, HxWx3. The chip is
        sampled straight from it with one similarity transform, so the face
        is never resized twice.
        """
        import dlib

        _, chip_points = self._require()
        details = dlib.chip_details(
            chip_points,
            dlib.dpoints([dlib.dpoint(x, y) for x, y in points]),
            dlib.chip_dims(CHIP_SIZE, CHIP_SIZE),
        )
        return np.ascontiguousarray(dlib.extract_image_chip(rgb, details))

    def embed(self, chips: Sequence[np.ndarray]) -> list[list[float] | None]:
        """One unit-length descriptor per chip, in order.

        None for a chip whose output has no direction (non-finite or zero),
        so that one unusable face does not fail a whole classroom photo. A
        wrong-sized output still raises: that is the network, not the face.
        """
        net, _ = self._require()
        for chip in chips:
            if chip.shape != (CHIP_SIZE, CHIP_SIZE, 3) or chip.dtype != np.uint8:
                raise ValueError(
                    f"a chip must be {CHIP_SIZE}x{CHIP_SIZE}x3 uint8, "
                    f"got {chip.shape} {chip.dtype}"
                )
        vectors: list[list[float] | None] = []
        for start in range(0, len(chips), EMBED_BATCH):
            batch = [
                np.ascontiguousarray(c) for c in chips[start : start + EMBED_BATCH]
            ]
            with self._lock:
                raw = net.compute_face_descriptor(batch, 0)
            if len(raw) != len(batch):
                raise RecognizerSelfTestError(
                    f"the recogniser returned {len(raw)} descriptors "
                    f"for {len(batch)} chips"
                )
            for values in raw:
                # RecognizerSelfTestError is not a ValueError, so a wrong
                # dimension still propagates.
                try:
                    vectors.append(_unit(values, self.EMBEDDING_DIM))
                except ValueError:
                    vectors.append(None)
        return vectors
