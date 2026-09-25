"""Calibrate the enrolment blur threshold for the dlib backend.

    python -m bench.calibrate_enrollment_sharpness --model-dir models \\
        --detections /path/outside/repo/azure-detect-json \\
        --out /tmp/sharpness.json

**No photograph enters the repository.** ``--detections`` is a directory of
JSON files, one per photograph, each ``{"path": <image path>, "faces":
[<Azure detect entry>, ...]}`` — the landmarks Azure found, recorded once so
that re-running this makes no Azure calls. Photographs named ``*_enroll.jpg``
with a matching ``*_probe.jpg`` are treated as a genuine pair. Only aggregate
numbers are written: no image, crop or vector.

What it answers, through the exact production code
(``app.models.face_sharpness.measure_blur``, dlib's recogniser):

1. **What does blur cost a template?** Each enrolment photograph is resized
   so its face is a capture-sized 100 to 400px, degraded at that scale,
   JPEG-encoded like a browser, and embedded. The loss of genuine similarity
   against the untouched second photograph defines "genuinely blurred":
   blur that costs the template, not blur that looks bad.
2. **Where does the measure put each condition?** Median, 95th percentile
   and the share refused at ``MAX_ENROLLMENT_BLUR``, per condition and per
   face size. A usable measure refuses damaging blur at every size, and
   refuses clean, compressed, dark or bright captures at none.
3. **What threshold does the criterion give?** The value that refuses 95%
   of captures blurred by 1.5 recogniser pixels — the first level whose cost
   exceeds 0.005 of genuine similarity. Fix the criterion before reading the
   number; do not pick the number and then describe it.

Blur levels are in recogniser pixels (the 150px chip), converted to capture
pixels per photograph, so a level means the same thing at every face size.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

#: (kind, level, JPEG quality). Levels are recogniser pixels, or a gain.
CONDITIONS: tuple[tuple[str, float, int], ...] = (
    ("clean", 0, 92), ("clean", 0, 75), ("clean", 0, 50),
    ("gauss", 0.5, 92), ("gauss", 0.75, 92), ("gauss", 1.0, 92),
    ("gauss", 1.25, 92), ("gauss", 1.5, 92), ("gauss", 2.0, 92),
    ("gauss", 3.0, 92), ("motion", 3, 92), ("motion", 5, 92),
    ("motion", 8, 92), ("defocus", 1.5, 92), ("defocus", 2.5, 92),
    ("dark", 0.45, 92), ("bright", 1.35, 92), ("smooth", 60, 92),
    ("noise", 8, 92),
)
SIZES = (100, 128, 160, 200, 256, 400)
#: Outer-eye-corner distance in dlib's template, in chip pixels.
CHIP_EYE_SPAN = 73.9


def _motion_kernel(length: float, angle_deg: float) -> np.ndarray:
    n = max(3, math.ceil(length) | 1)
    kernel = np.zeros((n, n), np.float32)
    c, a = n // 2, math.radians(angle_deg)
    for t in np.linspace(-length / 2, length / 2, max(2, int(length * 4))):
        kernel[round(c + t * math.sin(a)), round(c + t * math.cos(a))] = 1.0
    return kernel / kernel.sum()


def degrade(
    image: np.ndarray, kind: str, level: float, scale: float, rng: np.random.Generator
) -> np.ndarray:
    """``scale``: capture pixels per recogniser pixel for this photograph."""
    import cv2

    if kind == "clean":
        return image
    if kind == "gauss":
        return cv2.GaussianBlur(image, (0, 0), level * scale)
    if kind == "motion":
        kernel = _motion_kernel(level * scale, rng.uniform(0, 180))
        return cv2.filter2D(image, -1, kernel)
    if kind == "defocus":
        r = max(1, round(level * scale))
        disk = np.zeros((2 * r + 1, 2 * r + 1), np.float32)
        cv2.circle(disk, (r, r), r, 1.0, -1)
        return cv2.filter2D(image, -1, disk / disk.sum())
    if kind == "dark":
        return np.clip(image.astype(np.float32) * level, 0, 255).astype(np.uint8)
    if kind == "bright":
        return np.clip(image.astype(np.float32) * level + 25, 0, 255).astype(np.uint8)
    if kind == "smooth":  # a phone's "beauty" mode; plausibly a child's skin
        return cv2.bilateralFilter(image, 9, level, 7)
    if kind == "noise":  # low-light sensor noise over real blur
        soft = cv2.GaussianBlur(image, (0, 0), 2.0 * scale)
        noisy = soft.astype(np.float32) + rng.normal(0, level, image.shape)
        return np.clip(noisy, 0, 255).astype(np.uint8)
    raise ValueError(kind)


def _eye_span(face: dict[str, Any]) -> float:
    marks = face["faceLandmarks"]
    a, b = marks["eyeRightOuter"], marks["eyeLeftOuter"]
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def run(model_dir: Path, detections: Path) -> dict[str, Any]:
    import cv2

    from app.models.dlib_recognition import (
        DlibResNetEmbedder,
        LandmarkError,
        five_points,
    )
    from app.models.face_sharpness import MAX_ENROLLMENT_BLUR, measure_blur
    from app.models.model_files import DLIB_ARTIFACTS, DLIB_RESNET, verify_all

    weights = verify_all(model_dir, DLIB_ARTIFACTS)[DLIB_RESNET.role]
    embedder = DlibResNetEmbedder(weights)
    embedder.load()

    faces: dict[str, dict[str, Any]] = {}
    for record in sorted(detections.glob("*.json")):
        entry = json.loads(record.read_text())
        if len(entry.get("faces", [])) == 1 and Path(entry["path"]).exists():
            faces[entry["path"]] = entry["faces"][0]

    def load(path: str) -> np.ndarray:
        return cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)

    def box(face: dict[str, Any]) -> float:
        rect = face["faceRectangle"]
        return float(min(rect["width"], rect["height"]))

    def scaled(face: dict[str, Any], f: float) -> dict[str, dict[str, float]]:
        return {
            k: {"x": v["x"] * f, "y": v["y"] * f}
            for k, v in face["faceLandmarks"].items()
        }

    def embed(bgr: np.ndarray, face: dict[str, Any], f: float = 1.0) -> np.ndarray:
        marks = scaled(face, f)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        chip = embedder.extract_chip(rgb, five_points(marks, box(face) * f))
        return np.asarray(embedder.embed([chip])[0])

    rng = np.random.default_rng(7)
    rows: list[dict[str, Any]] = []
    for path, face in sorted(faces.items()):
        bgr = load(path)
        if bgr is None:
            continue
        probe = path.replace("_enroll.jpg", "_probe.jpg")
        paired = path.endswith("_enroll.jpg") and probe in faces
        if paired:
            probe_vec = embed(load(probe), faces[probe])
            reference = float(embed(bgr, face) @ probe_vec)
        for size in SIZES:
            if size > box(face) * 1.02:
                continue  # never upsample: nobody captures that
            f = size / box(face)
            dims = (max(1, round(bgr.shape[1] * f)), max(1, round(bgr.shape[0] * f)))
            small = cv2.resize(bgr, dims, interpolation=cv2.INTER_AREA)
            scale = _eye_span(face) * f / CHIP_EYE_SPAN
            try:
                points = five_points(scaled(face, f), size)
            except LandmarkError:
                continue
            for kind, level, quality in CONDITIONS:
                image = degrade(small, kind, level, scale, rng)
                params = [cv2.IMWRITE_JPEG_QUALITY, quality]
                decoded = cv2.imdecode(cv2.imencode(".jpg", image, params)[1], 1)
                rgb = cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB)
                row = {
                    "size": size, "kind": kind, "level": level, "q": quality,
                    "blur": measure_blur(rgb, points),
                }
                if paired:
                    row["cost"] = float(embed(decoded, face, f) @ probe_vec) - reference
                rows.append(row)

    def summary(selected: list[dict[str, Any]]) -> dict[str, Any]:
        blur = np.array([r["blur"] for r in selected])
        costs = [r["cost"] for r in selected if "cost" in r]
        return {
            "n": len(selected),
            "median": round(float(np.median(blur)), 4),
            "p95": round(float(np.percentile(blur, 95)), 4),
            "refused": round(float(np.mean(blur > MAX_ENROLLMENT_BLUR)), 4),
            "mean_cost": round(float(np.mean(costs)), 5) if costs else None,
        }

    by_condition: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_size: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        name = f"{r['kind']} {r['level']} q{r['q']}"
        by_condition[name].append(r)
        by_size[f"{name} @{r['size']}px"].append(r)
    criterion = [
        r["blur"] for r in rows if r["kind"] == "gauss" and r["level"] == 1.5
    ]
    return {
        "photographs": len(faces),
        "threshold_in_use": MAX_ENROLLMENT_BLUR,
        "criterion": "refuse 95% of captures blurred by 1.5 recogniser pixels",
        "criterion_value": (
            round(float(np.percentile(criterion, 5)), 4) if criterion else None
        ),
        "by_condition": {k: summary(v) for k, v in by_condition.items()},
        "by_size": {k: summary(v) for k, v in by_size.items()},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--detections", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.model_dir, args.detections)
    args.out.write_text(json.dumps(report, indent=1))
    print(f"{report['photographs']} photographs; threshold in use "
          f"{report['threshold_in_use']}; criterion gives {report['criterion_value']}")
    header = ("condition", "n", "median", "p95", "refused", "cost")
    print("{:22s} {:>6} {:>7} {:>6} {:>8} {:>9}".format(*header))
    for name, s in report["by_condition"].items():
        cost = "" if s["mean_cost"] is None else f"{s['mean_cost']:+.4f}"
        print(f"{name:22s} {s['n']:6d} {s['median']:7.3f} {s['p95']:6.3f} "
              f"{s['refused']:8.1%} {cost:>9}")


if __name__ == "__main__":
    main()
