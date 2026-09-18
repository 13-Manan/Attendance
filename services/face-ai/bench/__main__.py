"""CLI entry point: `python -m bench --manifest <path> --out <dir>`.

Two modes, because they answer different questions:

    --in-process  (default)  load the backend directly. Fastest, and the
                             latency numbers exclude HTTP, so this is the mode
                             for threshold work.
    --http URL               drive a running service over the v1 contract.
                             Slower, and the only mode whose latency numbers
                             mean anything to a faculty member waiting on a
                             progress bar.

Re-analysing an existing run needs no model at all:

    python -m bench --analyze runs/2026-09-15/raw.json --out runs/2026-09-15
"""

from __future__ import annotations

import argparse
import json
import sys

from bench.manifest import assess_coverage, load_manifest
from bench.metrics import (
    DEFAULT_EVALUATION_POLICY,
    EvaluationPolicy,
    evaluate,
    recommend_operating_point,
    sweep,
)
from bench.report import write_reports
from bench.results import RawBenchmarkRun
from bench.runner import HttpClient, InProcessClient, run_benchmark


def _frange(start: float, stop: float, step: float) -> tuple[float, ...]:
    values: list[float] = []
    current = start
    while current <= stop + 1e-9:
        values.append(round(current, 4))
        current += step
    return tuple(values)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bench", description=__doc__)
    parser.add_argument("--manifest", help="Path to a benchmark manifest.json")
    parser.add_argument(
        "--analyze",
        help="Path to a previously written raw.json; skips all inference",
    )
    parser.add_argument("--out", required=True, help="Output directory for the reports")
    parser.add_argument("--http", help="Benchmark a running service at this base URL")
    parser.add_argument(
        "--present-min", type=float, default=DEFAULT_EVALUATION_POLICY.present_min
    )
    parser.add_argument(
        "--review-min", type=float, default=DEFAULT_EVALUATION_POLICY.review_min
    )
    parser.add_argument(
        "--ambiguity-margin",
        type=float,
        default=DEFAULT_EVALUATION_POLICY.ambiguity_margin,
    )
    parser.add_argument(
        "--min-detection-confidence",
        type=float,
        default=DEFAULT_EVALUATION_POLICY.min_detection_confidence,
    )
    parser.add_argument(
        "--sweep",
        action="store_true",
        help="Also re-score across a threshold grid and recommend an operating point",
    )
    parser.add_argument(
        "--max-false-acceptance",
        type=float,
        default=0.01,
        help=(
            "False-acceptance budget for the recommendation, as a fraction. "
            "There is no safe default; 0.01 is a placeholder an institution "
            "must replace with its own policy."
        ),
    )
    parser.add_argument(
        "--check-coverage-only",
        action="store_true",
        help="Validate the manifest and print coverage gaps without running the model",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.manifest and not args.analyze:
        print("error: one of --manifest or --analyze is required", file=sys.stderr)
        return 2

    policy = EvaluationPolicy(
        present_min=args.present_min,
        review_min=args.review_min,
        ambiguity_margin=args.ambiguity_margin,
        min_detection_confidence=args.min_detection_confidence,
    )

    if args.analyze:
        run = RawBenchmarkRun.from_dict(json.loads(open(args.analyze).read()))
    else:
        manifest = load_manifest(args.manifest)
        coverage = assess_coverage(manifest)
        if args.check_coverage_only:
            print(f"Cohort sizes present: {list(coverage.cohort_sizes)}")
            if coverage.complete:
                print("Coverage complete.")
            else:
                for gap in coverage.gaps:
                    print(f"GAP  {gap.dimension}: {', '.join(gap.missing)}")
            return 0 if coverage.complete else 1

        client = HttpClient(args.http) if args.http else InProcessClient.from_settings()
        try:
            run = run_benchmark(manifest, client)
        finally:
            close = getattr(client, "close", None)
            if close:
                close()

    evaluation = evaluate(run, policy)
    points = None
    recommendation = None
    if args.sweep:
        points = sweep(
            run,
            policy,
            present_grid=_frange(0.30, 0.90, 0.05),
            review_grid=_frange(0.20, 0.80, 0.05),
        )
        recommendation = recommend_operating_point(points, args.max_false_acceptance)

    raw_path, json_path, md_path = write_reports(
        args.out, run, evaluation, points, recommendation, args.max_false_acceptance
    )
    print(f"raw:      {raw_path}")
    print(f"json:     {json_path}")
    print(f"markdown: {md_path}")

    if not run.production_eligible:
        print(
            "\nWARNING: the backend under test is not licence-cleared for "
            "production. These numbers describe the harness, not a deployable "
            "system.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
