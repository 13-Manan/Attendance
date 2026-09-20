"""What the real model actually costs.

``perf.py`` measures the overhead *around* inference — serialisation, request
validation, the candidate scan — against the ``mock`` backend, and says so.
This module measures the thing that overhead is added to: YuNet detection and
SFace embedding, running the real weights.

## What this can honestly measure, and what it cannot

**It measures compute, not accuracy.** No consented dataset exists (see
``bench/README.md``), so nothing here reports detection recall, false
acceptance, or any identification metric. Timing a forward pass needs no
faces; measuring whether it finds the right person needs a great many.

That distinction is load-bearing for the numbers below. A convolutional
forward pass costs the same regardless of what the pixels depict — YuNet at
a given input size does the same arithmetic on an empty frame as on a full
classroom. What *does* vary with content is the post-processing: NMS and the
per-face crop-align-embed loop scale with how many faces were found. So:

- **Detection timings here are a floor.** They are the fixed forward-pass cost
  on synthetic frames containing no faces. A real classroom adds NMS over real
  candidates on top.
- **Embedding timings here are exact.** SFace takes a fixed 112x112 aligned
  crop; its cost does not depend on whose face is in it. Feeding a synthetic
  crop measures precisely what a real one costs.
- **Per-face aggregate cost** is therefore ``detect_floor + n x embed``, and
  that composition is reported rather than a single invented "per classroom"
  number.

Anything this file cannot measure honestly is left out rather than estimated.

## Running it

    cd services/face-ai
    .venv/bin/python -m bench.model_perf --out bench/results

Requires the real artefacts in ``models/`` (SHA-256 verified on load). It does
**not** set ``FACE_AI_REQUIRE_PRODUCTION_MODEL`` and does not touch the
production-eligibility flag: benchmarking a model is not clearing it.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import resource
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

from app.models.model_files import SFACE, YUNET, file_sha256, verify_all
from app.models.opencv_provider import OpenCVFaceModelProvider

HARNESS_VERSION = "1.0.0"


@dataclass
class Stats:
    """A latency distribution. Percentiles, never a lone mean."""

    samples: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    min_ms: float
    max_ms: float
    mean_ms: float

    @classmethod
    def of(cls, durations_ms: list[float]) -> Stats:
        ordered = sorted(durations_ms)
        n = len(ordered)

        def pct(p: float) -> float:
            if n == 0:
                return 0.0
            # Nearest-rank. With 30 samples a p99 is the top sample; reporting
            # it as if it were a converged tail would overstate what was
            # measured, so `samples` travels with every figure.
            index = min(n - 1, max(0, round(p * n) - 1))
            return round(ordered[index], 3)

        return cls(
            samples=n,
            p50_ms=pct(0.50),
            p95_ms=pct(0.95),
            p99_ms=pct(0.99),
            min_ms=round(ordered[0], 3) if n else 0.0,
            max_ms=round(ordered[-1], 3) if n else 0.0,
            mean_ms=round(statistics.fmean(ordered), 3) if n else 0.0,
        )


def rss_mb() -> float:
    """Resident set size. macOS reports bytes, Linux kilobytes."""
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(raw / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def synthetic_frame(width: int, height: int, seed: int = 7) -> str:
    """A JPEG of the right shape, as base64.

    Deliberately noise rather than an attempt at a drawn face: a crude
    synthetic face would either be detected or not for reasons that say
    nothing about real performance, and either outcome would invite reading
    an accuracy claim into a timing run. Noise makes the absence of faces
    unambiguous, so the detection number is plainly a forward-pass floor.
    """
    rng = np.random.default_rng(seed)
    frame = rng.integers(0, 256, size=(height, width, 3), dtype=np.uint8)
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def synthetic_crop(seed: int = 11) -> np.ndarray:
    """A 112x112 BGR crop, the shape SFace consumes after alignment."""
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, size=(112, 112, 3), dtype=np.uint8)


# ---------------------------------------------------------------------------
# Measurements
# ---------------------------------------------------------------------------


def measure_cold_start(model_dir: str) -> dict:
    """Model load, measured once, in a process that has never loaded it.

    Reported separately and never folded into the warm numbers. Cold start
    is what a container's first request pays, and averaging it away is how
    a slow first response becomes invisible in a dashboard.
    """
    before_mb = rss_mb()
    provider = OpenCVFaceModelProvider(model_dir=model_dir)

    started = time.perf_counter()
    provider.load()
    load_ms = (time.perf_counter() - started) * 1000

    after_load_mb = rss_mb()

    # The first inference after load is still not steady state: OpenCV
    # allocates its scratch buffers lazily.
    frame = synthetic_frame(1280, 720)
    started = time.perf_counter()
    provider.detect(frame)
    first_detect_ms = (time.perf_counter() - started) * 1000

    return {
        "loadMs": round(load_ms, 1),
        "firstDetectAfterLoadMs": round(first_detect_ms, 1),
        "rssBeforeLoadMb": before_mb,
        "rssAfterLoadMb": after_load_mb,
        "rssDeltaMb": round(after_load_mb - before_mb, 1),
        "_provider": provider,
    }


def measure_detection(provider: OpenCVFaceModelProvider, iterations: int) -> list[dict]:
    """Detection cost across the resolutions a classroom camera produces."""
    resolutions = [
        (640, 480, "VGA"),
        (1280, 720, "720p"),
        (1920, 1080, "1080p"),
        (2560, 1440, "1440p"),
        (3840, 2160, "4K"),
    ]

    rows: list[dict] = []
    for width, height, label in resolutions:
        frame = synthetic_frame(width, height)
        # Warm this resolution before measuring it: the first call at a new
        # input size reallocates.
        provider.detect(frame)

        durations: list[float] = []
        for _ in range(iterations):
            started = time.perf_counter()
            result = provider.detect(frame)
            durations.append((time.perf_counter() - started) * 1000)

        rows.append(
            {
                "resolution": label,
                "width": width,
                "height": height,
                "facesDetected": len(result.faces),
                "stats": asdict(Stats.of(durations)),
            }
        )
    return rows


def measure_embedding(provider: OpenCVFaceModelProvider, iterations: int) -> dict:
    """SFace cost for one aligned crop.

    Exact rather than a floor: the input is a fixed 112x112 tensor, so a
    synthetic crop costs precisely what a real one does.
    """
    crop = synthetic_crop()
    # `_embed_crop` is the private seam between alignment and the recogniser.
    # Reached directly here because the public path needs a detected face, and
    # a synthetic frame has none — which is the whole reason this is a
    # compute benchmark and not an accuracy one.
    provider._embed_crop(crop)  # warm

    durations: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        vector = provider._embed_crop(crop)
        durations.append((time.perf_counter() - started) * 1000)

    return {
        "embeddingDim": len(vector),
        "stats": asdict(Stats.of(durations)),
    }


def measure_composed_cost(detection_rows: list[dict], embedding: dict) -> list[dict]:
    """detect + n x embed, for classroom-sized face counts.

    Composed arithmetically and labelled as such. Running a synthetic frame
    through the real per-face loop is impossible without real faces, so the
    honest move is to state the composition rather than fabricate a scene.
    """
    by_label = {row["resolution"]: row for row in detection_rows}
    embed_p50 = embedding["stats"]["p50_ms"]

    rows = []
    for label in ("720p", "1080p"):
        row = by_label.get(label)
        if not row:
            continue
        detect_p50 = row["stats"]["p50_ms"]
        for faces in (1, 5, 10, 20, 30, 50):
            rows.append(
                {
                    "resolution": label,
                    "faces": faces,
                    "detectFloorMs": detect_p50,
                    "embedTotalMs": round(embed_p50 * faces, 1),
                    "composedMs": round(detect_p50 + embed_p50 * faces, 1),
                    "basis": (
                        "detect p50 (floor, no faces) + faces x embed p50"
                    ),
                }
            )
    return rows


def measure_stability(provider: OpenCVFaceModelProvider, iterations: int) -> dict:
    """Repeated inference, watching for growth.

    A model that reloads per request, or a buffer that is never released,
    shows up here as RSS climbing with iteration count. The check is coarse
    on purpose — it is looking for a leak, not for allocator noise.
    """
    frame = synthetic_frame(1280, 720)
    crop = synthetic_crop()

    provider.detect(frame)
    start_mb = rss_mb()
    checkpoints: list[dict] = []

    for index in range(1, iterations + 1):
        provider.detect(frame)
        provider._embed_crop(crop)
        if index % max(1, iterations // 5) == 0:
            checkpoints.append({"iteration": index, "rssMb": rss_mb()})

    end_mb = rss_mb()
    return {
        "iterations": iterations,
        "rssStartMb": start_mb,
        "rssEndMb": end_mb,
        "rssGrowthMb": round(end_mb - start_mb, 1),
        "checkpoints": checkpoints,
    }


def measure_concurrency(
    model_dir: str,
    levels: list[int],
    per_worker: int,
) -> list[dict]:
    """Throughput as concurrent callers increase.

    One provider, many threads — which is how the FastAPI service uses it.
    OpenCV releases the GIL inside its own inference calls, so this measures
    whether that actually translates into parallelism on this machine, rather
    than assuming it.
    """
    provider = OpenCVFaceModelProvider(model_dir=model_dir)
    provider.load()
    frame = synthetic_frame(1280, 720)
    provider.detect(frame)  # warm

    def one_call() -> float | None:
        """One detection. Returns its duration, or None if it failed.

        Deliberately returns rather than appending to an enclosing list: a
        closure over a per-iteration collector is the classic way a loop-bound
        benchmark silently attributes one level's samples to another.
        """
        try:
            started = time.perf_counter()
            provider.detect(frame)
            return (time.perf_counter() - started) * 1000
        except Exception:
            return None

    rows: list[dict] = []
    for level in levels:
        wall_start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=level) as pool:
            outcomes = list(pool.map(lambda _: one_call(), range(level * per_worker)))
        wall_ms = (time.perf_counter() - wall_start) * 1000

        durations = [d for d in outcomes if d is not None]
        failures = len(outcomes) - len(durations)
        completed = len(durations)
        rows.append(
            {
                "concurrency": level,
                "requests": level * per_worker,
                "completed": completed,
                "failures": failures,
                "wallMs": round(wall_ms, 1),
                "throughputPerSec": (
                    round(completed / (wall_ms / 1000), 2) if wall_ms else 0.0
                ),
                "stats": asdict(Stats.of(durations)),
                "rssMb": rss_mb(),
            }
        )

    provider.unload()
    return rows


def measure_failure_modes(provider: OpenCVFaceModelProvider) -> list[dict]:
    """What malformed input does.

    The governing rule is Phase 6's: a recognition failure must surface as a
    failure, never as a confident answer. Here that means an exception or an
    empty result — never a fabricated face.
    """
    cases: list[tuple[str, str]] = [
        ("empty_string", ""),
        ("not_base64", "this is not base64 at all!!"),
        ("base64_but_not_an_image", base64.b64encode(b"plain text").decode()),
        ("truncated_jpeg", synthetic_frame(640, 480)[:200]),
        ("one_pixel", synthetic_frame(1, 1)),
    ]

    rows = []
    for name, payload in cases:
        started = time.perf_counter()
        try:
            result = provider.detect(payload)
            outcome = "returned"
            detail = f"{len(result.faces)} faces"
        except Exception as exc:  # classifying the failure, not handling it
            outcome = "raised"
            detail = type(exc).__name__
        rows.append(
            {
                "case": name,
                "outcome": outcome,
                "detail": detail,
                "ms": round((time.perf_counter() - started) * 1000, 2),
                "fabricatedFace": outcome == "returned" and detail != "0 faces",
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def environment(model_dir: str) -> dict:
    paths = verify_all(model_dir)
    return {
        "harnessVersion": HARNESS_VERSION,
        "generatedAt": datetime.now(UTC).isoformat(),
        "python": sys.version.split()[0],
        "opencv": cv2.__version__,
        "numpy": np.__version__,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or platform.machine(),
        "cpuCount": os.cpu_count(),
        "backend": "opencv",
        "artifacts": {
            "detector": {
                "file": YUNET.filename,
                "sha256": file_sha256(paths["detector"]),
                "bytes": paths["detector"].stat().st_size,
            },
            "recognizer": {
                "file": SFACE.filename,
                "sha256": file_sha256(paths["recognizer"]),
                "bytes": paths["recognizer"].stat().st_size,
            },
        },
        "productionEligible": False,
        "licensingNote": (
            "Training-data provenance for YuNet/SFace is unresolved. This run "
            "measures compute only and establishes no commercial or legal "
            "clearance. productionEligible remains false."
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bench.model_perf", description=__doc__)
    parser.add_argument("--out", required=True, help="Directory for model-perf.json")
    parser.add_argument("--model-dir", default="models")
    parser.add_argument("--iterations", type=int, default=30)
    parser.add_argument("--stability-iterations", type=int, default=200)
    parser.add_argument(
        "--concurrency",
        default="1,5,10,25,50",
        help="Comma-separated concurrency levels",
    )
    parser.add_argument("--per-worker", type=int, default=4)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"==> verifying artefacts in {args.model_dir}", file=sys.stderr)
    env = environment(args.model_dir)

    print("==> cold start", file=sys.stderr)
    cold = measure_cold_start(args.model_dir)
    provider = cold.pop("_provider")

    print("==> detection across resolutions", file=sys.stderr)
    detection = measure_detection(provider, args.iterations)

    print("==> embedding", file=sys.stderr)
    embedding = measure_embedding(provider, args.iterations)

    print("==> stability", file=sys.stderr)
    stability = measure_stability(provider, args.stability_iterations)

    print("==> failure modes", file=sys.stderr)
    failures = measure_failure_modes(provider)

    provider.unload()

    levels = [int(x) for x in args.concurrency.split(",") if x.strip()]
    print(f"==> concurrency {levels}", file=sys.stderr)
    concurrency = measure_concurrency(args.model_dir, levels, args.per_worker)

    payload = {
        "environment": env,
        "disclaimer": (
            "Compute only. Detection figures are a forward-pass FLOOR measured "
            "on synthetic frames containing no faces; a real scene adds NMS and "
            "per-face work. Embedding figures are exact (fixed 112x112 input). "
            "NO accuracy, recall, false-acceptance or identification metric is "
            "reported or implied — that requires a consented dataset, which "
            "does not exist. See bench/README.md."
        ),
        "coldStart": cold,
        "detection": detection,
        "embedding": embedding,
        "composedCost": measure_composed_cost(detection, embedding),
        "stability": stability,
        "failureModes": failures,
        "concurrency": concurrency,
    }

    destination = out_dir / "model-perf.json"
    destination.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"==> wrote {destination}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
