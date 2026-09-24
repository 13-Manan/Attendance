"""Compose a synthetic "class photo" from single portraits.

Used by the opt-in real-model group-photo test and by ``bench.group_perf``.
Neither the portraits nor the composed images are ever written into the
repository: the caller points at a directory outside it (FACE_QA_CORPUS).

A composed photo is a grid of head-and-shoulders crops, each scaled so its
face is ``face_px`` across — the shape of a classroom photo (many faces of
similar size) without claiming its realism (no occlusion, uniform lighting,
no perspective). Results from it measure the pipeline, not the classroom.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class Placed:
    identity: str
    #: Face centre in the composed frame, for matching detections back.
    centre: tuple[float, float]


def load_pairs(corpus: Path) -> list[tuple[str, Path, Path]]:
    out = []
    for enrol in sorted(corpus.glob("*_enroll.jpg")):
        ident = enrol.name[: -len("_enroll.jpg")]
        probe = corpus / f"{ident}_probe.jpg"
        if probe.exists():
            out.append((ident, enrol, probe))
    return out


#: Portraits are letterboxed to this square before detection. The detector
#: reallocates for every new input size, so feeding it each portrait at its own
#: size inflates peak RSS by hundreds of MB — a harness artefact that would
#: otherwise land in bench.group_perf's memory figures.
PORTRAIT_EDGE = 800


def _letterbox(frame: np.ndarray, edge: int = PORTRAIT_EDGE) -> np.ndarray:
    import cv2

    scale = min(1.0, edge / max(frame.shape[:2]))
    if scale < 1.0:
        frame = cv2.resize(
            frame,
            (round(frame.shape[1] * scale), round(frame.shape[0] * scale)),
            interpolation=cv2.INTER_AREA,
        )
    out = np.zeros((edge, edge, 3), np.uint8)
    out[: frame.shape[0], : frame.shape[1]] = frame
    return out


def head_crop(detector, frame: np.ndarray) -> tuple[np.ndarray, float] | None:
    """The largest face with a margin, and its face size in that crop."""
    frame = _letterbox(frame)
    found = detector.detect_frame(frame)
    if not found:
        return None
    face = max(found, key=lambda f: f.box.width * f.box.height)
    b = face.box
    margin = 0.6 * max(b.width, b.height)
    x0 = int(max(0, b.x - margin))
    y0 = int(max(0, b.y - margin))
    x1 = int(min(frame.shape[1], b.x + b.width + margin))
    y1 = int(min(frame.shape[0], b.y + b.height + margin))
    return frame[y0:y1, x0:x1].copy(), float(min(b.width, b.height))


def compose(
    heads: list[tuple[str, np.ndarray, float]],
    face_px: int,
    background: int = 118,
) -> tuple[np.ndarray, list[Placed]]:
    import cv2

    scaled = []
    for ident, crop, size in heads:
        s = face_px / size
        scaled.append(
            (
                ident,
                cv2.resize(
                    crop,
                    (
                        max(1, round(crop.shape[1] * s)),
                        max(1, round(crop.shape[0] * s)),
                    ),
                    interpolation=cv2.INTER_AREA,
                ),
            )
        )
    cell_w = max(img.shape[1] for _, img in scaled) + 8
    cell_h = max(img.shape[0] for _, img in scaled) + 8
    cols = max(1, math.ceil(math.sqrt(len(scaled) * 4 / 3)))
    rows = math.ceil(len(scaled) / cols)
    frame = np.full((rows * cell_h, cols * cell_w, 3), background, np.uint8)
    placed = []
    for index, (ident, img) in enumerate(scaled):
        r, c = divmod(index, cols)
        y0 = r * cell_h + (cell_h - img.shape[0]) // 2
        x0 = c * cell_w + (cell_w - img.shape[1]) // 2
        frame[y0 : y0 + img.shape[0], x0 : x0 + img.shape[1]] = img
        placed.append(Placed(ident, (x0 + img.shape[1] / 2, y0 + img.shape[0] / 2)))
    return frame, placed


def nearest(placed: list[Placed], x: float, y: float) -> Placed:
    return min(placed, key=lambda p: (p.centre[0] - x) ** 2 + (p.centre[1] - y) ** 2)
