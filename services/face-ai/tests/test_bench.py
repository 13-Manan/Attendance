"""Tests for the benchmark harness itself.

A harness that miscounts is worse than no harness: it produces a confident,
wrong number that a deployment decision rests on. These tests pin the metric
definitions against hand-computed cases, and pin the decision replay against
the same behaviours the TypeScript recognition engine is tested for
(deduplication across images, ambiguity downgrade, class scoping).
"""

from __future__ import annotations

import json

import pytest

from bench.manifest import ManifestError, assess_coverage, load_manifest, parse_manifest
from bench.metrics import (
    DEFAULT_EVALUATION_POLICY,
    EvaluationPolicy,
    decide_capture,
    evaluate,
    recommend_operating_point,
    sweep,
)
from bench.report import render_markdown, to_json
from bench.results import (
    RawBenchmarkRun,
    RawCaptureResult,
    RawFaceObservation,
    RawImageResult,
)

POLICY = DEFAULT_EVALUATION_POLICY


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_capture(
    faces: list[RawFaceObservation],
    *,
    cohort: tuple[str, ...] = ("s1", "s2", "s3"),
    present: tuple[str, ...] = ("s1",),
    images: list[RawImageResult] | None = None,
    conditions: dict[str, str] | None = None,
    capture_id: str = "cap-1",
    error: str | None = None,
) -> RawCaptureResult:
    return RawCaptureResult(
        capture_id=capture_id,
        cohort_id="co-1",
        cohort_size=len(cohort),
        conditions=conditions
        or {
            "distance": "mid",
            "lighting": "normal",
            "eyewear": "none",
            "occlusion": "none",
            "angle": "frontal",
            "camera": "test-cam",
        },
        cohort_student_ids=list(cohort),
        truly_present_student_ids=list(present),
        images=images or [RawImageResult(1, len(faces), len(present), 10.0)],
        faces=faces,
        total_ms=25.0,
        error=error,
    )


def face(
    similarities: dict[str, float],
    *,
    seq: int = 1,
    index: int = 0,
    confidence: float = 0.95,
) -> RawFaceObservation:
    return RawFaceObservation(
        sequence_number=seq,
        face_index=index,
        detection_confidence=confidence,
        quality_score=0.8,
        similarities=similarities,
    )


def make_run(captures: list[RawCaptureResult]) -> RawBenchmarkRun:
    return RawBenchmarkRun(
        dataset_id="test",
        generated_at="2026-09-15T00:00:00+00:00",
        model_name="mock",
        model_version="0.1.0+pp1",
        production_eligible=False,
        commercial_use="not-applicable",
        runtime="mock/none",
        gallery_template_count=3,
        captures=captures,
    )


MANIFEST = {
    "datasetId": "unit",
    "description": "fixture",
    "cohorts": [
        {
            "cohortId": "co-1",
            "label": "small",
            "students": [
                {"studentId": "s1", "enrollmentImages": ["e/s1.jpg"]},
                {"studentId": "s2", "enrollmentImages": ["e/s2.jpg"]},
            ],
        }
    ],
    "captures": [
        {
            "captureId": "cap-1",
            "cohortId": "co-1",
            "conditions": {"distance": "far", "lighting": "dim", "camera": "cam-a"},
            "images": [
                {"sequenceNumber": 1, "path": "c/1.jpg", "visibleStudentIds": ["s1"]},
                {
                    "sequenceNumber": 2,
                    "path": "c/2.jpg",
                    "visibleStudentIds": ["s1", "s2"],
                },
            ],
        }
    ],
}


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def test_manifest_parses_and_derives_ground_truth(tmp_path):
    manifest = parse_manifest(MANIFEST, root=tmp_path)
    capture = manifest.captures[0]
    assert capture.present_student_ids == frozenset({"s1", "s2"})
    # s1 appears in both frames, s2 in one: three face appearances expected.
    assert capture.expected_face_instances == 3
    assert manifest.cohort("co-1").size == 2


def test_manifest_rejects_ground_truth_outside_the_cohort(tmp_path):
    bad = json.loads(json.dumps(MANIFEST))
    bad["captures"][0]["images"][0]["visibleStudentIds"] = ["outsider"]
    with pytest.raises(ManifestError, match="not enrolled in cohort"):
        parse_manifest(bad, root=tmp_path)


def test_manifest_rejects_a_student_with_no_enrollment_images(tmp_path):
    bad = json.loads(json.dumps(MANIFEST))
    bad["cohorts"][0]["students"][0]["enrollmentImages"] = []
    with pytest.raises(ManifestError, match="no enrollmentImages"):
        parse_manifest(bad, root=tmp_path)


def test_manifest_rejects_more_than_three_images(tmp_path):
    bad = json.loads(json.dumps(MANIFEST))
    bad["captures"][0]["images"] = [
        {"sequenceNumber": n, "path": f"c/{n}.jpg", "visibleStudentIds": []}
        for n in (1, 2, 3)
    ] + [{"sequenceNumber": 3, "path": "c/4.jpg", "visibleStudentIds": []}]
    with pytest.raises(ManifestError, match="1-3"):
        parse_manifest(bad, root=tmp_path)


def test_manifest_rejects_an_unknown_condition_value(tmp_path):
    bad = json.loads(json.dumps(MANIFEST))
    bad["captures"][0]["conditions"]["lighting"] = "sort of dark"
    with pytest.raises(ManifestError, match="lighting"):
        parse_manifest(bad, root=tmp_path)


def test_load_manifest_reads_from_disk(tmp_path):
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(MANIFEST))
    manifest = load_manifest(path)
    assert manifest.dataset_id == "unit"
    assert manifest.resolve("c/1.jpg") == (tmp_path / "c/1.jpg").resolve()


def test_coverage_reports_the_conditions_a_small_dataset_never_exercised(tmp_path):
    coverage = assess_coverage(parse_manifest(MANIFEST, root=tmp_path))
    assert not coverage.complete
    dimensions = {gap.dimension for gap in coverage.gaps}
    # Two students, one camera, only far/dim — every axis is under-sampled.
    assert "cohortSize" in dimensions
    assert "camera" in dimensions
    assert "distance" in dimensions


# ---------------------------------------------------------------------------
# Decision replay
# ---------------------------------------------------------------------------


def test_decide_capture_returns_one_row_per_enrolled_student():
    capture = make_capture([face({"s1": 0.9, "s2": 0.1, "s3": 0.1})])
    decisions = decide_capture(capture, POLICY)
    assert [d.student_id for d in decisions] == ["s1", "s2", "s3"]
    assert {d.student_id: d.advisory for d in decisions} == {
        "s1": "PRESENT",
        "s2": "ABSENT",
        "s3": "ABSENT",
    }


def test_a_student_seen_in_two_images_is_decided_once_at_the_best_score():
    capture = make_capture(
        [
            face({"s1": 0.5, "s2": 0.1, "s3": 0.1}, seq=1),
            face({"s1": 0.91, "s2": 0.1, "s3": 0.1}, seq=2),
        ],
        present=("s1",),
    )
    decisions = [d for d in decide_capture(capture, POLICY) if d.student_id == "s1"]
    assert len(decisions) == 1
    assert decisions[0].best_similarity == pytest.approx(0.91)
    assert decisions[0].advisory == "PRESENT"


def test_a_near_tie_is_routed_to_review_not_to_present():
    capture = make_capture([face({"s1": 0.90, "s2": 0.88, "s3": 0.1})])
    decision = next(d for d in decide_capture(capture, POLICY) if d.student_id == "s1")
    assert decision.was_ambiguous is True
    assert decision.advisory == "NEEDS_REVIEW"


def test_a_low_confidence_detection_cannot_mark_anyone_present():
    capture = make_capture([face({"s1": 0.99}, confidence=0.1)])
    decisions = decide_capture(capture, POLICY)
    assert all(d.advisory == "ABSENT" for d in decisions)


def test_scores_below_the_review_floor_yield_no_claim():
    capture = make_capture([face({"s1": 0.2, "s2": 0.1, "s3": 0.05})])
    assert all(d.advisory == "ABSENT" for d in decide_capture(capture, POLICY))


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def test_detection_rate_is_detected_over_expected_face_instances():
    capture = make_capture(
        [face({"s1": 0.9}), face({"s2": 0.9})],
        present=("s1", "s2", "s3"),
        images=[RawImageResult(1, 2, 3, 10.0)],
    )
    metrics = evaluate(make_run([capture]), POLICY).overall
    assert metrics.detection_rate == pytest.approx(2 / 3)


def test_false_acceptance_counts_an_absent_student_marked_present():
    # s2 is not in the room, but a face scores 0.95 against their template.
    capture = make_capture([face({"s2": 0.95, "s1": 0.1, "s3": 0.1})], present=("s1",))
    metrics = evaluate(make_run([capture]), POLICY).overall
    assert metrics.false_acceptance_rate == pytest.approx(1 / 2)  # s2 of {s2, s3}
    assert metrics.false_rejection_rate == pytest.approx(1 / 1)  # s1 was missed


def test_review_is_neither_correct_nor_incorrect():
    # One present student routed to review: no false rejection, and accuracy
    # is computed over the students that were actually decided.
    capture = make_capture([face({"s1": 0.5, "s2": 0.1, "s3": 0.1})], present=("s1",))
    metrics = evaluate(make_run([capture]), POLICY).overall
    assert metrics.false_rejection_rate == pytest.approx(0.0)
    assert metrics.review_rate == pytest.approx(1 / 3)
    assert metrics.accuracy == pytest.approx(1.0)  # s2, s3 correctly absent


def test_metrics_are_none_not_zero_when_there_is_nothing_to_measure():
    capture = make_capture(
        [face({"s1": 0.9, "s2": 0.1, "s3": 0.1})], present=("s1", "s2", "s3")
    )
    metrics = evaluate(make_run([capture]), POLICY).overall
    # Nobody was absent, so a false-acceptance rate is not measurable here.
    assert metrics.false_acceptance_rate is None


def test_an_errored_capture_counts_every_present_student_as_missed():
    capture = make_capture([], present=("s1", "s2"), error="DecodeError: bad jpeg")
    metrics = evaluate(make_run([capture]), POLICY).overall
    assert metrics.errored_captures == 1
    assert metrics.false_rejection_rate == pytest.approx(1.0)


def test_results_are_sliced_by_condition_and_cohort_size():
    dim = make_capture(
        [face({"s1": 0.9, "s2": 0.1, "s3": 0.1})],
        capture_id="dim",
        conditions={
            "distance": "far",
            "lighting": "dim",
            "eyewear": "none",
            "occlusion": "none",
            "angle": "frontal",
            "camera": "cam-a",
        },
    )
    bright = make_capture(
        [face({"s1": 0.3, "s2": 0.1, "s3": 0.1})],
        capture_id="bright",
        conditions={
            "distance": "near",
            "lighting": "bright",
            "eyewear": "none",
            "occlusion": "none",
            "angle": "frontal",
            "camera": "cam-b",
        },
    )
    evaluation = evaluate(make_run([dim, bright]), POLICY)
    assert evaluation.slices["lighting=dim"].false_rejection_rate == pytest.approx(0.0)
    bright_slice = evaluation.slices["lighting=bright"]
    assert bright_slice.false_rejection_rate == pytest.approx(1.0)
    assert evaluation.slices["cohortSize=3"].sample_captures == 2


def test_latency_percentiles_are_reported():
    captures = []
    for i, ms in enumerate([10.0, 20.0, 400.0]):
        capture = make_capture([face({"s1": 0.9})], capture_id=f"c{i}")
        capture.total_ms = ms
        captures.append(capture)
    metrics = evaluate(make_run(captures), POLICY).overall
    assert metrics.latency_p50_ms == pytest.approx(20.0)
    assert metrics.latency_max_ms == pytest.approx(400.0)


# ---------------------------------------------------------------------------
# Threshold sweep
# ---------------------------------------------------------------------------


def test_sweep_skips_inverted_threshold_pairs():
    run = make_run([make_capture([face({"s1": 0.9, "s2": 0.1, "s3": 0.1})])])
    points = sweep(run, POLICY, present_grid=(0.5, 0.7), review_grid=(0.4, 0.6, 0.8))
    assert all(p.review_min <= p.present_min for p in points)
    assert (0.5, 0.4) in [(p.present_min, p.review_min) for p in points]


def test_sweep_moves_the_error_trade_off_as_thresholds_rise():
    # s1 present and scoring 0.7; s2 absent and scoring 0.65 on another face.
    capture = make_capture(
        [
            face({"s1": 0.70, "s2": 0.10, "s3": 0.05}, index=0),
            face({"s2": 0.65, "s1": 0.10, "s3": 0.05}, index=1),
        ],
        present=("s1",),
    )
    run = make_run([capture])
    lax = evaluate(run, EvaluationPolicy(0.60, 0.40, 0.05, 0.5)).overall
    strict = evaluate(run, EvaluationPolicy(0.85, 0.40, 0.05, 0.5)).overall
    # Lax admits the impostor; strict does not, at the cost of deferring the
    # genuine student to review.
    assert lax.false_acceptance_rate == pytest.approx(0.5)
    assert strict.false_acceptance_rate == pytest.approx(0.0)
    assert strict.review_rate > lax.review_rate


def test_recommendation_respects_the_false_acceptance_budget():
    capture = make_capture(
        [
            face({"s1": 0.70, "s2": 0.10, "s3": 0.05}, index=0),
            face({"s2": 0.65, "s1": 0.10, "s3": 0.05}, index=1),
        ],
        present=("s1",),
    )
    points = sweep(
        make_run([capture]),
        POLICY,
        present_grid=(0.60, 0.68, 0.85),
        review_grid=(0.40,),
    )
    chosen = recommend_operating_point(points, max_false_acceptance=0.0)
    assert chosen is not None
    assert chosen.metrics.false_acceptance_rate == pytest.approx(0.0)


def test_recommendation_returns_none_when_no_point_meets_the_budget():
    # An absent student the model is confidently, unambiguously wrong about:
    # 0.99 with a wide margin over everyone else. No threshold in the grid can
    # exclude them, and the ambiguity rule has nothing to catch.
    capture = make_capture(
        [face({"s2": 0.99, "s1": 0.10, "s3": 0.05})], present=("s1",)
    )
    points = sweep(
        make_run([capture]), POLICY, present_grid=(0.3, 0.5, 0.9), review_grid=(0.2,)
    )
    assert all(p.metrics.false_acceptance_rate == pytest.approx(0.5) for p in points)
    assert recommend_operating_point(points, max_false_acceptance=0.0) is None


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def test_the_report_leads_with_the_licensing_warning_for_an_uncleared_backend():
    run = make_run([make_capture([face({"s1": 0.9, "s2": 0.1, "s3": 0.1})])])
    markdown = render_markdown(run, evaluate(run, POLICY))
    assert "License verification required before production deployment." in markdown
    assert "not licence-cleared for production" in markdown


def test_the_report_names_untested_conditions():
    run = make_run([make_capture([face({"s1": 0.9})])])
    run.coverage_gaps = [{"dimension": "lighting", "missing": ["backlit", "dim"]}]
    markdown = render_markdown(run, evaluate(run, POLICY))
    assert "Coverage gaps" in markdown
    assert "backlit" in markdown


def test_report_json_round_trips_the_raw_run():
    run = make_run([make_capture([face({"s1": 0.9, "s2": 0.1, "s3": 0.1})])])
    restored = RawBenchmarkRun.from_dict(json.loads(json.dumps(run.to_dict())))
    restored_scores = restored.captures[0].faces[0].similarities
    assert restored_scores == {"s1": 0.9, "s2": 0.1, "s3": 0.1}
    # And the analysis of the restored run matches the original.
    assert (
        evaluate(restored, POLICY).overall.as_dict()
        == evaluate(run, POLICY).overall.as_dict()
    )


def test_report_json_carries_the_model_provenance():
    run = make_run([make_capture([face({"s1": 0.9})])])
    payload = to_json(run, evaluate(run, POLICY))
    assert payload["model"]["commercialUse"] == "not-applicable"
    assert payload["model"]["productionEligible"] is False
