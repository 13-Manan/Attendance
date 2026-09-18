"""Latency and scaling measurements for `services/face-ai`.

    python -m bench.perf --http http://127.0.0.1:8099 --out bench/results

This is the *performance* half of Phase 12, and it is deliberately separate
from the accuracy harness in `runner.py`/`metrics.py`. The two ask different
questions and have very different prerequisites:

    runner.py   "how often is it right?"  — needs a licensed model and a
                dataset of real, consented faces. Neither exists in this
                repository, which is why that harness has never produced a
                number worth quoting.

    perf.py     "how long does it take?"  — needs neither. Serialisation,
                transfer, request validation and the candidate scan cost
                what they cost regardless of which model is behind them.

So the timings here are real measurements of real code paths. What they are
*not* is a claim about model inference time: with the `mock` backend the
per-face compute is a hash, so every number below should be read as the
**floor** — the overhead a real model's inference time is added to, not a
prediction of total latency. That distinction is repeated in the output,
because a floor quoted as a total is how a benchmark becomes a lie.

Three things are measured:

1. `score_candidates` against 50 / 100 / 500 / 2000 / 5000 candidates,
   in-process. This is the class-scoped search question.
2. `POST /v1/detect-embed` over HTTP with 1, 2 and 3 classroom-sized images.
   This is the request a faculty member waits on.
3. `POST /v1/match` over HTTP at 10 / 20 / 50 / 100 candidates — the cohort
   sizes the brief names.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from app.matching import score_candidates
from app.schemas import DEFAULT_MATCH_THRESHOLDS, MatchCandidate

# Cohort sizes from the brief, plus two stress points beyond any real class.
CANDIDATE_COUNTS = (10, 20, 50, 100, 500, 2000, 5000)
COHORT_SIZES = (10, 20, 50, 100)
IMAGE_COUNTS = (1, 2, 3)
EMBEDDING_DIM = 512


@dataclass
class Timing:
    """A latency sample set. `p95` is reported everywhere `mean` is, because
    the person who abandons the page is the one in the tail."""

    count: int
    mean_ms: float
    p50_ms: float
    p95_ms: float
    max_ms: float

    @staticmethod
    def of(samples: list[float]) -> Timing:
        if not samples:
            return Timing(0, 0.0, 0.0, 0.0, 0.0)
        ordered = sorted(samples)
        idx = max(0, min(len(ordered) - 1, round(0.95 * len(ordered)) - 1))
        return Timing(
            count=len(ordered),
            mean_ms=statistics.fmean(ordered),
            p50_ms=statistics.median(ordered),
            p95_ms=ordered[idx],
            max_ms=ordered[-1],
        )


def _unit_vectors(rng: np.random.Generator, n: int, dim: int) -> np.ndarray:
    v = rng.standard_normal((n, dim))
    return v / np.linalg.norm(v, axis=1, keepdims=True)


# ---------------------------------------------------------------------------
# 1. Candidate scan
# ---------------------------------------------------------------------------


def bench_score_candidates(iterations: int = 30) -> list[dict]:
    """Time the in-process scan.

    `score_candidates` is a Python loop that calls `cosine_similarity` once
    per candidate, and `cosine_similarity` re-runs `np.asarray` and both
    norms on every call. That is a lot of per-candidate constant, and the
    point of measuring it at 5,000 is to find out whether it matters at the
    sizes this system actually uses — not to justify rewriting it.

    Note that 5,000 cannot be reached over HTTP at all:
    `face_ai_max_match_candidates` caps a request at 2,000. That cap is a
    deliberate restatement of "search must remain class-scoped", so the
    5,000 row exists only as an in-process stress point.
    """
    rng = np.random.default_rng(20260917)
    rows: list[dict] = []

    for count in CANDIDATE_COUNTS:
        vectors = _unit_vectors(rng, count, EMBEDDING_DIM)
        candidates = [
            MatchCandidate(studentId=f"stu-{i}", embedding=vectors[i].tolist())
            for i in range(count)
        ]
        probe = _unit_vectors(rng, 1, EMBEDDING_DIM)[0].tolist()

        for _ in range(3):  # warm-up
            score_candidates(probe, candidates, DEFAULT_MATCH_THRESHOLDS, EMBEDDING_DIM)

        samples: list[float] = []
        for _ in range(iterations):
            start = time.perf_counter()
            score_candidates(probe, candidates, DEFAULT_MATCH_THRESHOLDS, EMBEDDING_DIM)
            samples.append((time.perf_counter() - start) * 1000.0)

        timing = Timing.of(samples)
        rows.append(
            {
                "candidates": count,
                "reachableOverHttp": count <= 2000,
                "perCallUs": round(timing.mean_ms * 1000.0 / count, 3),
                **{k: round(v, 4) for k, v in asdict(timing).items() if k != "count"},
                "samples": timing.count,
            }
        )
    return rows


# ---------------------------------------------------------------------------
# 2 & 3. HTTP paths
# ---------------------------------------------------------------------------


def _classroom_jpeg(rng: np.random.Generator, width: int, height: int) -> str:
    """A JPEG of the right *size*, not of a classroom.

    Structured noise rather than flat colour on purpose: a blank image
    compresses to a few kilobytes and would make the transfer look free.
    Smooth gradients plus per-pixel noise lands in the few-hundred-KB range a
    phone photograph actually occupies, which is what the serialisation and
    transfer measurements need.
    """
    from PIL import Image

    y = np.linspace(0, 255, height, dtype=np.float32)[:, None]
    x = np.linspace(0, 255, width, dtype=np.float32)[None, :]
    base = (0.5 * y + 0.5 * x)[:, :, None] * np.array([1.0, 0.9, 0.8], dtype=np.float32)
    noise = rng.integers(0, 70, size=(height, width, 3)).astype(np.float32)
    pixels = np.clip(base + noise, 0, 255).astype(np.uint8)

    buffer = io.BytesIO()
    Image.fromarray(pixels, mode="RGB").save(buffer, format="JPEG", quality=85)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def bench_http(base_url: str, token: str | None, iterations: int = 15) -> dict:
    import httpx

    rng = np.random.default_rng(4242)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    client = httpx.Client(base_url=base_url.rstrip("/"), timeout=180.0, headers=headers)

    try:
        info = client.get("/v1/model-info")
        info.raise_for_status()
        model_info = info.json()

        # One 1600x1200 frame ~ a compressed phone photograph of a room.
        image = _classroom_jpeg(rng, 1600, 1200)
        image_kb = round(len(image) * 3 / 4 / 1024, 1)

        detect_rows: list[dict] = []
        for image_count in IMAGE_COUNTS:
            payload = {
                "sessionId": "bench-session",
                "images": [
                    {"sequenceNumber": i + 1, "imageBase64": image}
                    for i in range(image_count)
                ],
            }
            body_kb = round(len(json.dumps(payload)) / 1024, 1)

            for _ in range(2):
                client.post("/v1/detect-embed", json=payload).raise_for_status()

            samples: list[float] = []
            for _ in range(iterations):
                start = time.perf_counter()
                response = client.post("/v1/detect-embed", json=payload)
                response.raise_for_status()
                samples.append((time.perf_counter() - start) * 1000.0)

            timing = Timing.of(samples)
            detect_rows.append(
                {
                    "images": image_count,
                    "imageKb": image_kb,
                    "requestBodyKb": body_kb,
                    **{
                        k: round(v, 3)
                        for k, v in asdict(timing).items()
                        if k != "count"
                    },
                    "samples": timing.count,
                }
            )

        match_image = _classroom_jpeg(rng, 640, 640)
        match_rows: list[dict] = []
        for cohort in COHORT_SIZES:
            vectors = _unit_vectors(rng, cohort, EMBEDDING_DIM)
            payload = {
                "imageBase64": match_image,
                "candidates": [
                    {"studentId": f"stu-{i}", "embedding": vectors[i].tolist()}
                    for i in range(cohort)
                ],
                "thresholds": {"matchThreshold": 0.62, "reviewThreshold": 0.45},
            }
            body_kb = round(len(json.dumps(payload)) / 1024, 1)

            for _ in range(2):
                client.post("/v1/match", json=payload).raise_for_status()

            samples = []
            for _ in range(iterations):
                start = time.perf_counter()
                response = client.post("/v1/match", json=payload)
                response.raise_for_status()
                samples.append((time.perf_counter() - start) * 1000.0)

            timing = Timing.of(samples)
            match_rows.append(
                {
                    "cohortSize": cohort,
                    "requestBodyKb": body_kb,
                    **{
                        k: round(v, 3)
                        for k, v in asdict(timing).items()
                        if k != "count"
                    },
                    "samples": timing.count,
                }
            )

        return {
            "modelInfo": model_info,
            "detectEmbed": detect_rows,
            "match": match_rows,
        }
    finally:
        client.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bench.perf", description=__doc__)
    parser.add_argument("--http", help="Base URL of a running face-ai service")
    parser.add_argument("--token", help="Value for the Authorization: Bearer header")
    parser.add_argument("--out", required=True, help="Directory for perf.json")
    parser.add_argument("--iterations", type=int, default=15)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    print("face-ai performance benchmark")
    print("candidate scan (in-process) …")
    scan = bench_score_candidates()
    for row in scan:
        reach = "" if row["reachableOverHttp"] else "  [over the HTTP cap]"
        print(
            f"  n={row['candidates']:>5}  mean={row['mean_ms']:8.3f}ms  "
            f"p95={row['p95_ms']:8.3f}ms  "
            f"per-candidate={row['perCallUs']:6.2f}us{reach}"
        )

    http_results = None
    if args.http:
        print(f"\nHTTP against {args.http} …")
        http_results = bench_http(args.http, args.token, args.iterations)
        eligible = http_results["modelInfo"].get("productionEligible")
        print(
            f"  backend: {http_results['modelInfo'].get('modelName')} "
            f"{http_results['modelInfo'].get('modelVersion')} "
            f"(productionEligible={eligible})"
        )
        for row in http_results["detectEmbed"]:
            print(
                f"  detect-embed images={row['images']}  "
                f"body={row['requestBodyKb']:>7.1f}KB  "
                f"mean={row['mean_ms']:8.2f}ms  p95={row['p95_ms']:8.2f}ms"
            )
        for row in http_results["match"]:
            print(
                f"  match cohort={row['cohortSize']:>4}  "
                f"body={row['requestBodyKb']:>7.1f}KB  "
                f"mean={row['mean_ms']:8.2f}ms  p95={row['p95_ms']:8.2f}ms"
            )
    else:
        print("\n(no --http given; skipping the service measurements)")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "python": sys.version.split()[0],
        "disclaimer": (
            "Measured against the `mock` backend, whose per-face compute is a hash. "
            "These are overhead floors, not total recognition latency. No model in "
            "this repository is licensed for production use."
        ),
        "candidateScan": scan,
        "http": http_results,
    }
    (out_dir / "perf.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"\nwrote {out_dir / 'perf.json'}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
