"""What a class photo costs, by the number of faces in it.

    FACE_QA_CORPUS=/path/outside/repo/pairs \\
        .venv/bin/python -m bench.group_perf --out bench/results

``model_perf.py`` times detection on face-less noise and embedding on one
synthetic crop, and composes the two. That is exact for the forward passes but
says nothing about the per-face work in between — alignment, quality
measurement, batching — because a frame with no faces never reaches it. This
harness closes that gap: every frame is a composed class photo
(``bench.group_compose``) with a known number of real faces, pasted onto a
fixed 1920x1440 canvas — the size the capture screen sends — so detection cost
is the same forward pass at every count and only the per-face work grows.

Faces are repeated when the corpus has fewer identities than the count asked
for; identity does not change compute. The corpus never enters the repository
and nothing but timings is written.

Each count is measured in a fresh child process that loads the model and
analyses only its own photo, so ``peak_rss_mb`` is what one worker needs for a
photo with that many faces — not inflated by composing the photos, or by the
counts measured before it (``ru_maxrss`` only ever grows). The composed photos
go through a temporary directory that is deleted afterwards.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

from app.models.opencv_provider import EMBED_BATCH_SIZE, OpenCVFaceModelProvider
from app.schemas import SessionImageInput
from bench.group_compose import compose, head_crop, load_pairs
from bench.model_perf import Stats, rss_mb

FACE_COUNTS = (5, 10, 20, 30, 40, 50)
STAGES = ("decode", "detect", "align", "quality", "embed")
CANVAS = (1440, 1920)  # height, width: the capture screen's long edge


def class_photo(heads, count: int, face_px: int) -> str:
    picked = [heads[i % len(heads)] for i in range(count)]
    grid, _ = compose(picked, face_px)
    canvas = np.full((*CANVAS, 3), 118, np.uint8)
    h, w = grid.shape[:2]
    if h > CANVAS[0] or w > CANVAS[1]:
        raise SystemExit(f"{count} faces at {face_px}px do not fit; lower --face-px")
    y0, x0 = (CANVAS[0] - h) // 2, (CANVAS[1] - w) // 2
    canvas[y0 : y0 + h, x0 : x0 + w] = grid
    ok, buffer = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def measure(model_dir: str, photo: Path, count: int, iterations: int) -> dict:
    """Runs in the child process: load, warm, time, report."""
    rss_start = rss_mb()
    provider = OpenCVFaceModelProvider(model_dir=model_dir)
    provider.load()
    rss_loaded = rss_mb()
    image_b64 = photo.read_text()
    request = SessionImageInput(sequenceNumber=1, imageBase64=image_b64)
    provider.analyze_image(request)  # warm: first call at a new input size pays setup
    stages: dict[str, list[float]] = {k: [] for k in STAGES}
    totals, embedded = [], []
    for _ in range(iterations):
        started = time.perf_counter()
        analysis = provider.analyze_image(request)
        totals.append((time.perf_counter() - started) * 1000)
        t = analysis.timings
        for key in stages:
            stages[key].append(getattr(t, f"{key}_ms"))
        embedded.append(analysis.summary.embedded_faces)
    return {
        "faces_in_photo": count,
        "faces_embedded": min(embedded),
        "total": asdict(Stats.of(totals)),
        "stages_p50_ms": {k: Stats.of(v).p50_ms for k, v in stages.items()},
        "rss_mb": {"start": rss_start, "after_load": rss_loaded},
        "peak_rss_mb": rss_mb(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bench.group_perf", description=__doc__)
    parser.add_argument("--out")
    parser.add_argument(
        "--child", nargs=2, metavar=("PHOTO", "COUNT"), help=argparse.SUPPRESS
    )
    parser.add_argument("--model-dir", default="models")
    parser.add_argument("--corpus", default=os.environ.get("FACE_QA_CORPUS"))
    parser.add_argument("--face-px", type=int, default=64)
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args(argv)
    if args.child:
        photo, count = args.child
        row = measure(args.model_dir, Path(photo), int(count), args.iterations)
        print(json.dumps(row))
        return 0
    if not args.out:
        parser.error("--out is required")
    if not args.corpus:
        parser.error("--corpus or FACE_QA_CORPUS (a directory outside the repo)")

    provider = OpenCVFaceModelProvider(model_dir=args.model_dir)
    provider.load()
    heads = []
    for ident, _, probe in load_pairs(Path(args.corpus)):
        head = head_crop(provider.detector, cv2.imread(str(probe)))
        if head is not None:
            heads.append((ident, *head))

    rows = []
    with tempfile.TemporaryDirectory(prefix="group-perf-") as scratch:
        photos = {}
        for count in FACE_COUNTS:
            photos[count] = Path(scratch) / f"{count}.b64"
            photos[count].write_text(class_photo(heads, count, args.face_px))
        provider.unload()
        for count in FACE_COUNTS:
            child = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "bench.group_perf",
                    "--model-dir",
                    args.model_dir,
                    "--iterations",
                    str(args.iterations),
                    "--child",
                    str(photos[count]),
                    str(count),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            rows.append(json.loads(child.stdout.strip().splitlines()[-1]))
    for row in rows:
        count = row["faces_in_photo"]
        total, stage = row["total"], row["stages_p50_ms"]
        print(
            f"{count:>3} faces  embedded {row['faces_embedded']:>3}  "
            f"total p50 {total['p50_ms']:>7.1f} ms  p95 {total['p95_ms']:>7.1f}  "
            f"detect {stage['detect']:>6.1f}  embed {stage['embed']:>6.1f}  "
            f"loaded {row['rss_mb']['after_load']} MB  peak {row['peak_rss_mb']} MB",
            flush=True,
        )

    report = {
        "harness": "bench.group_perf",
        "generated_at": datetime.now(UTC).isoformat(),
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "opencv": cv2.__version__,
            "cv_threads": cv2.getNumThreads(),
        },
        "canvas": {"height": CANVAS[0], "width": CANVAS[1]},
        "face_px": args.face_px,
        "embed_batch_size": EMBED_BATCH_SIZE,
        "iterations": args.iterations,
        "rows": rows,
        "caveat": (
            "Composed grids of studio portraits on a flat background: the compute "
            "is real, the scene is not. One worker process, one request at a time."
        ),
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "group-perf.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
