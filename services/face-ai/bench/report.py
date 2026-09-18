"""Render a benchmark run for machines (JSON) and for humans (Markdown).

The Markdown report leads with the caveats rather than burying them. A
benchmark number attached to a model whose licence has not been verified, or
measured on a dataset that never contained a dim back row, is worse than no
number — it gets quoted in a meeting.
"""

from __future__ import annotations

import json
from typing import Any

from bench.metrics import BenchmarkEvaluation, MetricSet, OperatingPoint
from bench.results import RawBenchmarkRun


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _ms(value: float | None) -> str:
    if value is None:
        return "n/a"
    # Sub-millisecond timings only occur with the mock backend, but rendering
    # them as "0 ms" makes a stub look infinitely fast in a table people skim.
    return f"{value:.2f} ms" if value < 10 else f"{value:.0f} ms"


def _metric_row(metrics: MetricSet) -> str:
    return (
        f"| {metrics.label} | {metrics.sample_captures} | {metrics.sample_students} | "
        f"{_pct(metrics.detection_rate)} | {_pct(metrics.accuracy)} | "
        f"{_pct(metrics.false_acceptance_rate)} | "
        f"{_pct(metrics.false_rejection_rate)} | "
        f"{_pct(metrics.review_rate)} | {_ms(metrics.latency_p50_ms)} | "
        f"{_ms(metrics.latency_p95_ms)} |"
    )


_TABLE_HEADER = (
    "| Slice | Captures | Student decisions | Detection rate | Accuracy | "
    "False acceptance | False rejection | Review rate | p50 | p95 |\n"
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
)


def to_json(
    run: RawBenchmarkRun,
    evaluation: BenchmarkEvaluation,
    sweep_points: list[OperatingPoint] | None = None,
    recommendation: OperatingPoint | None = None,
) -> dict[str, Any]:
    return {
        "dataset": run.dataset_id,
        "generatedAt": run.generated_at,
        "model": {
            "modelName": run.model_name,
            "modelVersion": run.model_version,
            "runtime": run.runtime,
            "commercialUse": run.commercial_use,
            "productionEligible": run.production_eligible,
        },
        "galleryTemplateCount": run.gallery_template_count,
        "coverageGaps": run.coverage_gaps,
        "evaluation": evaluation.as_dict(),
        "sweep": [p.as_dict() for p in sweep_points] if sweep_points else [],
        "recommendedOperatingPoint": (
            recommendation.as_dict() if recommendation else None
        ),
        "notes": run.notes,
    }


def render_markdown(
    run: RawBenchmarkRun,
    evaluation: BenchmarkEvaluation,
    sweep_points: list[OperatingPoint] | None = None,
    recommendation: OperatingPoint | None = None,
    max_false_acceptance: float | None = None,
) -> str:
    lines: list[str] = []
    lines.append(f"# Face recognition benchmark — {run.dataset_id}")
    lines.append("")
    lines.append(f"Generated: {run.generated_at}")
    lines.append(
        f"Model: `{run.model_name}` `{run.model_version}` on `{run.runtime}` "
        f"(commercial use: **{run.commercial_use}**)"
    )
    lines.append(f"Gallery templates: {run.gallery_template_count}")
    lines.append("")

    if not run.production_eligible:
        lines.append(
            "> **These numbers do not describe a deployable system.** The "
            f"backend under test reports `commercialUse: {run.commercial_use}` "
            "and is not licence-cleared for production. Treat this run as a "
            "harness check, not as evidence of accuracy. "
            "**License verification required before production deployment.**"
        )
        lines.append("")

    if run.coverage_gaps:
        lines.append("## Coverage gaps")
        lines.append("")
        lines.append(
            "The dataset never exercised the conditions below, so no claim "
            "can be made about them:"
        )
        lines.append("")
        for gap in run.coverage_gaps:
            missing = ", ".join(gap["missing"])
            lines.append(f"- **{gap['dimension']}**: {missing}")
        lines.append("")

    policy = evaluation.policy
    lines.append("## Policy under test")
    lines.append("")
    lines.append(f"- presentMin: `{policy.present_min}`")
    lines.append(f"- reviewMin: `{policy.review_min}`")
    lines.append(f"- ambiguityMargin: `{policy.ambiguity_margin}`")
    lines.append(f"- minDetectionConfidence: `{policy.min_detection_confidence}`")
    lines.append("")

    lines.append("## Overall")
    lines.append("")
    lines.append(_TABLE_HEADER)
    lines.append(_metric_row(evaluation.overall))
    lines.append("")
    if evaluation.overall.errored_captures:
        lines.append(
            f"{evaluation.overall.errored_captures} capture(s) failed to "
            "process; every truly-present student in them is counted as a "
            "false rejection."
        )
        lines.append("")

    lines.append("## By condition")
    lines.append("")
    lines.append(_TABLE_HEADER)
    for key in sorted(evaluation.slices):
        lines.append(_metric_row(evaluation.slices[key]))
    lines.append("")

    if sweep_points:
        lines.append("## Threshold sweep")
        lines.append("")
        lines.append(
            "Each row re-scores the same raw run at a different operating "
            "point. Pick a row against a stated false-acceptance budget; do "
            "not pick the row with the highest accuracy."
        )
        lines.append("")
        lines.append(
            "| presentMin | reviewMin | Accuracy | False acceptance | "
            "False rejection | Review rate |"
        )
        lines.append("| ---: | ---: | ---: | ---: | ---: | ---: |")
        for point in sweep_points:
            m = point.metrics
            lines.append(
                f"| {point.present_min:.2f} | {point.review_min:.2f} | "
                f"{_pct(m.accuracy)} | {_pct(m.false_acceptance_rate)} | "
                f"{_pct(m.false_rejection_rate)} | {_pct(m.review_rate)} |"
            )
        lines.append("")

        lines.append("## Recommended operating point")
        lines.append("")
        if recommendation is None:
            budget = (
                "the stated budget"
                if max_false_acceptance is None
                else f"{max_false_acceptance * 100:.2f}%"
            )
            lines.append(
                f"**None.** No threshold combination kept false acceptance at "
                f"or below {budget}. This is the finding: at this dataset and "
                "this model, there is no setting that is safe to deploy."
            )
        else:
            m = recommendation.metrics
            lines.append(
                f"presentMin `{recommendation.present_min:.2f}`, reviewMin "
                f"`{recommendation.review_min:.2f}` — false acceptance "
                f"{_pct(m.false_acceptance_rate)}, false rejection "
                f"{_pct(m.false_rejection_rate)}, review rate "
                f"{_pct(m.review_rate)}."
            )
            lines.append("")
            lines.append(
                "Set these on the institution via `Institution.settings."
                "confidenceThresholds` (`presentMin` / `reviewMin`). They are "
                "configuration, not code."
            )
        lines.append("")

    return "\n".join(lines)


def write_reports(
    out_dir: str,
    run: RawBenchmarkRun,
    evaluation: BenchmarkEvaluation,
    sweep_points: list[OperatingPoint] | None = None,
    recommendation: OperatingPoint | None = None,
    max_false_acceptance: float | None = None,
) -> tuple[str, str, str]:
    """Write raw.json, report.json and report.md. Returns their paths.

    Raw observations are written alongside the report so a later analysis —
    a new threshold, a new metric, a comparison against the next model — can
    reuse the inference instead of repeating it.
    """
    from pathlib import Path

    directory = Path(out_dir)
    directory.mkdir(parents=True, exist_ok=True)

    raw_path = directory / "raw.json"
    raw_path.write_text(json.dumps(run.to_dict(), indent=2))

    json_path = directory / "report.json"
    json_path.write_text(
        json.dumps(to_json(run, evaluation, sweep_points, recommendation), indent=2)
    )

    md_path = directory / "report.md"
    md_path.write_text(
        render_markdown(
            run, evaluation, sweep_points, recommendation, max_false_acceptance
        )
    )

    return str(raw_path), str(json_path), str(md_path)
