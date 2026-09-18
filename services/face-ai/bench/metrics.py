"""Turn raw benchmark artefacts into the numbers a deployment decision needs.

Every function here is pure and takes a policy explicitly, so the same raw run
can be scored at fifty different thresholds without touching the model. That
is the mechanism behind `sweep()`, and the reason this harness can answer
"what threshold should we ship?" with a curve instead of an opinion.

The decision logic mirrors `apps/web/src/modules/recognition-engine/service.ts`
exactly — same bands, same ambiguity-margin downgrade, same
highest-similarity-wins deduplication across images. If the two ever diverge,
the benchmark is measuring a system nobody runs. `classify_match_status` is
imported from `app.matching` rather than re-implemented for the same reason.

Metric definitions (stated because "accuracy" means five different things in
face recognition and the ambiguity is where misleading numbers come from):

  detection rate      detected face instances / expected face instances,
                      summed over images. Measures the detector alone.
  accuracy            over all (capture, enrolled student) pairs: fraction
                      where the advisory decision matched the truth. Students
                      routed to NEEDS_REVIEW are counted as *deferred*, not
                      correct and not wrong — they were handed to a human,
                      which is the designed behaviour, not an error.
  false acceptance    truly-absent students marked PRESENT / truly absent.
                      The number that matters most: it is the proxy-attendance
                      failure, and it is unrecoverable because nobody reviews
                      a confident Present.
  false rejection     truly-present students marked ABSENT / truly present.
                      Costly but visible — the student complains.
  review rate         fraction routed to NEEDS_REVIEW. Not an error, but a
                      workload: a system that reviews 60% of a class has not
                      saved anyone any time.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.matching import classify_match_status
from app.schemas import MatchStatus, MatchThresholds
from bench.results import RawBenchmarkRun, RawCaptureResult

# --------------------------------------------------------------------------
# Policy
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class EvaluationPolicy:
    """The full decision configuration under test.

    Mirrors `RecognitionPolicy` in apps/web. There are no default values worth
    trusting yet — `DEFAULT_EVALUATION_POLICY` below exists so the harness can
    run, and is labelled as a starting point, not a recommendation.
    """

    present_min: float
    review_min: float
    ambiguity_margin: float
    min_detection_confidence: float

    @property
    def thresholds(self) -> MatchThresholds:
        return MatchThresholds(
            matchThreshold=self.present_min, reviewThreshold=self.review_min
        )

    def as_dict(self) -> dict[str, float]:
        return {
            "presentMin": self.present_min,
            "reviewMin": self.review_min,
            "ambiguityMargin": self.ambiguity_margin,
            "minDetectionConfidence": self.min_detection_confidence,
        }


#: Plumbing defaults ONLY — these match the values apps/web currently ships so
#: that a first benchmark run measures the shipped configuration. They are not
#: validated against any dataset. Replace them with an operating point chosen
#: from a real `sweep()` before production.
DEFAULT_EVALUATION_POLICY = EvaluationPolicy(
    present_min=0.62,
    review_min=0.45,
    ambiguity_margin=0.05,
    min_detection_confidence=0.5,
)

Advisory = str  # "PRESENT" | "NEEDS_REVIEW" | "ABSENT"

_ADVISORY_BY_STATUS: dict[MatchStatus, Advisory] = {
    "MATCHED": "PRESENT",
    "UNCERTAIN": "NEEDS_REVIEW",
    "UNMATCHED": "ABSENT",
}


# --------------------------------------------------------------------------
# Decision replay
# --------------------------------------------------------------------------


@dataclass
class StudentDecision:
    student_id: str
    advisory: Advisory
    best_similarity: float | None
    was_ambiguous: bool


def decide_capture(
    capture: RawCaptureResult, policy: EvaluationPolicy
) -> list[StudentDecision]:
    """Replay the production decision pipeline over one capture's raw scores.

    Returns one decision per enrolled student in the cohort — including the
    students nothing pointed at, who come back ABSENT. A student is never
    returned twice no matter how many images or faces claimed them; that is
    the deduplication requirement, exercised here on real data rather than
    only in a unit test.
    """
    best: dict[str, tuple[float, bool]] = {}

    for face in capture.faces:
        if face.detection_confidence < policy.min_detection_confidence:
            # Dropped as a phantom detection: contributes nothing, and in
            # particular does not push anyone into review.
            continue
        if not face.similarities:
            continue
        ranked = sorted(face.similarities.items(), key=lambda kv: kv[1], reverse=True)
        top_id, top_score = ranked[0]
        status = classify_match_status(top_score, policy.thresholds)
        ambiguous = (
            status == "MATCHED"
            and len(ranked) > 1
            and top_score - ranked[1][1] < policy.ambiguity_margin
        )
        if ambiguous:
            status = "UNCERTAIN"
        if status == "UNMATCHED":
            continue
        previous = best.get(top_id)
        if previous is None or top_score > previous[0]:
            best[top_id] = (top_score, ambiguous)

    decisions: list[StudentDecision] = []
    for student_id in capture.cohort_student_ids:
        claim = best.get(student_id)
        if claim is None:
            decisions.append(StudentDecision(student_id, "ABSENT", None, False))
            continue
        score, ambiguous = claim
        status = classify_match_status(score, policy.thresholds)
        if ambiguous and status == "MATCHED":
            status = "UNCERTAIN"
        decisions.append(
            StudentDecision(student_id, _ADVISORY_BY_STATUS[status], score, ambiguous)
        )
    return decisions


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


@dataclass
class Counts:
    truly_present: int = 0
    truly_absent: int = 0
    present_correct: int = 0
    present_as_absent: int = 0  # false rejection
    present_as_review: int = 0
    absent_correct: int = 0
    absent_as_present: int = 0  # false acceptance
    absent_as_review: int = 0
    #: A truly-present student marked PRESENT under someone else's identity is
    #: counted here *and* as a false acceptance on the student who was named.
    expected_faces: int = 0
    detected_faces: int = 0
    captures: int = 0
    errored_captures: int = 0
    latencies_ms: list[float] = field(default_factory=list)

    def add(self, other: Counts) -> None:
        self.truly_present += other.truly_present
        self.truly_absent += other.truly_absent
        self.present_correct += other.present_correct
        self.present_as_absent += other.present_as_absent
        self.present_as_review += other.present_as_review
        self.absent_correct += other.absent_correct
        self.absent_as_present += other.absent_as_present
        self.absent_as_review += other.absent_as_review
        self.expected_faces += other.expected_faces
        self.detected_faces += other.detected_faces
        self.captures += other.captures
        self.errored_captures += other.errored_captures
        self.latencies_ms.extend(other.latencies_ms)


def _ratio(numerator: int, denominator: int) -> float | None:
    """None, not 0.0, when there is nothing to divide by.

    A 0% false-acceptance rate computed over zero absent students is not a
    reassuring result; it is an absent measurement, and rendering it as 0.0%
    would be the single most misleading thing this file could do.
    """
    if denominator == 0:
        return None
    return numerator / denominator


def _percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    idx = (len(ordered) - 1) * p
    low = math.floor(idx)
    high = math.ceil(idx)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (idx - low)


@dataclass
class MetricSet:
    label: str
    sample_captures: int
    sample_students: int
    detection_rate: float | None
    accuracy: float | None
    false_acceptance_rate: float | None
    false_rejection_rate: float | None
    review_rate: float | None
    errored_captures: int
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    latency_max_ms: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "sampleCaptures": self.sample_captures,
            "sampleStudents": self.sample_students,
            "detectionRate": self.detection_rate,
            "accuracy": self.accuracy,
            "falseAcceptanceRate": self.false_acceptance_rate,
            "falseRejectionRate": self.false_rejection_rate,
            "reviewRate": self.review_rate,
            "erroredCaptures": self.errored_captures,
            "latencyP50Ms": self.latency_p50_ms,
            "latencyP95Ms": self.latency_p95_ms,
            "latencyMaxMs": self.latency_max_ms,
        }


def _counts_for_capture(
    capture: RawCaptureResult, policy: EvaluationPolicy
) -> Counts:
    counts = Counts(captures=1)
    counts.expected_faces = capture.expected_face_instances
    counts.detected_faces = capture.detected_face_instances
    if capture.total_ms:
        counts.latencies_ms.append(capture.total_ms)
    if capture.error:
        counts.errored_captures = 1
        # An errored capture still has ground truth: every truly-present
        # student went unrecorded. Counting it as a false rejection is
        # honest — from the faculty's seat, a crash and a miss look the same.
        truly_present = set(capture.truly_present_student_ids)
        counts.truly_present = len(truly_present)
        counts.truly_absent = len(capture.cohort_student_ids) - len(truly_present)
        counts.present_as_absent = counts.truly_present
        counts.absent_correct = counts.truly_absent
        return counts

    truly_present = set(capture.truly_present_student_ids)
    for decision in decide_capture(capture, policy):
        is_present = decision.student_id in truly_present
        if is_present:
            counts.truly_present += 1
            if decision.advisory == "PRESENT":
                counts.present_correct += 1
            elif decision.advisory == "NEEDS_REVIEW":
                counts.present_as_review += 1
            else:
                counts.present_as_absent += 1
        else:
            counts.truly_absent += 1
            if decision.advisory == "PRESENT":
                counts.absent_as_present += 1
            elif decision.advisory == "NEEDS_REVIEW":
                counts.absent_as_review += 1
            else:
                counts.absent_correct += 1
    return counts


def metrics_from_counts(label: str, counts: Counts) -> MetricSet:
    total_students = counts.truly_present + counts.truly_absent
    decided = (
        counts.present_correct
        + counts.present_as_absent
        + counts.absent_correct
        + counts.absent_as_present
    )
    correct = counts.present_correct + counts.absent_correct
    reviewed = counts.present_as_review + counts.absent_as_review
    return MetricSet(
        label=label,
        sample_captures=counts.captures,
        sample_students=total_students,
        detection_rate=_ratio(counts.detected_faces, counts.expected_faces),
        # Accuracy is computed over *decided* students only. Including
        # NEEDS_REVIEW in the denominator would make a system that defers
        # everything look inaccurate, when deferring is the correct behaviour
        # under uncertainty; `review_rate` is what bounds that behaviour.
        accuracy=_ratio(correct, decided),
        false_acceptance_rate=_ratio(counts.absent_as_present, counts.truly_absent),
        false_rejection_rate=_ratio(counts.present_as_absent, counts.truly_present),
        review_rate=_ratio(reviewed, total_students),
        errored_captures=counts.errored_captures,
        latency_p50_ms=_percentile(counts.latencies_ms, 0.5),
        latency_p95_ms=_percentile(counts.latencies_ms, 0.95),
        latency_max_ms=max(counts.latencies_ms) if counts.latencies_ms else None,
    )


@dataclass
class BenchmarkEvaluation:
    policy: EvaluationPolicy
    overall: MetricSet
    #: Keyed "dimension=value", e.g. "lighting=dim" or "cohortSize=50". The
    #: per-slice view is the deliverable — an overall number cannot tell you
    #: the back row is failing.
    slices: dict[str, MetricSet]

    def as_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy.as_dict(),
            "overall": self.overall.as_dict(),
            "slices": {k: v.as_dict() for k, v in sorted(self.slices.items())},
        }


SLICE_DIMENSIONS = ("distance", "lighting", "eyewear", "occlusion", "angle", "camera")


def evaluate(run: RawBenchmarkRun, policy: EvaluationPolicy) -> BenchmarkEvaluation:
    overall = Counts()
    slices: dict[str, Counts] = {}

    for capture in run.captures:
        counts = _counts_for_capture(capture, policy)
        overall.add(counts)

        keys = [
            f"cohortSize={capture.cohort_size}",
            f"imageCount={len(capture.images)}",
        ]
        keys += [
            f"{dim}={capture.conditions[dim]}"
            for dim in SLICE_DIMENSIONS
            if dim in capture.conditions
        ]
        for key in keys:
            slices.setdefault(key, Counts()).add(counts)

    return BenchmarkEvaluation(
        policy=policy,
        overall=metrics_from_counts("overall", overall),
        slices={k: metrics_from_counts(k, v) for k, v in slices.items()},
    )


# --------------------------------------------------------------------------
# Threshold sweep
# --------------------------------------------------------------------------


@dataclass
class OperatingPoint:
    present_min: float
    review_min: float
    metrics: MetricSet

    def as_dict(self) -> dict[str, Any]:
        return {
            "presentMin": self.present_min,
            "reviewMin": self.review_min,
            **self.metrics.as_dict(),
        }


def sweep(
    run: RawBenchmarkRun,
    policy: EvaluationPolicy,
    present_grid: tuple[float, ...],
    review_grid: tuple[float, ...],
) -> list[OperatingPoint]:
    """Re-score the whole run at every (presentMin, reviewMin) combination.

    Combinations where reviewMin > presentMin are skipped: they would create a
    band in which nothing can be UNCERTAIN, which quietly converts borderline
    scores into confident matches — the exact failure the review band exists
    to prevent. `app.matching.resolve_thresholds` clamps the same case at
    runtime.
    """
    points: list[OperatingPoint] = []
    for present_min in present_grid:
        for review_min in review_grid:
            if review_min > present_min:
                continue
            candidate = EvaluationPolicy(
                present_min=present_min,
                review_min=review_min,
                ambiguity_margin=policy.ambiguity_margin,
                min_detection_confidence=policy.min_detection_confidence,
            )
            result = evaluate(run, candidate)
            points.append(OperatingPoint(present_min, review_min, result.overall))
    return points


def recommend_operating_point(
    points: list[OperatingPoint], max_false_acceptance: float
) -> OperatingPoint | None:
    """The best point that stays under a false-acceptance budget.

    Deliberately requires the caller to state the budget: there is no
    universally correct trade-off between marking an absent student present
    and sending a present student to review, and an institution's policy (and
    its regulator) decides it, not this file. Among points meeting the budget
    we prefer the lowest false-rejection rate, then the lowest review rate —
    fewest students wronged first, least faculty work second.

    Returns None when no point meets the budget, which is itself the finding:
    the model is not good enough for this dataset at any threshold.
    """
    eligible = [
        p
        for p in points
        if p.metrics.false_acceptance_rate is not None
        and p.metrics.false_acceptance_rate <= max_false_acceptance
    ]
    if not eligible:
        return None
    return min(
        eligible,
        key=lambda p: (
            p.metrics.false_rejection_rate
            if p.metrics.false_rejection_rate is not None
            else 1.0,
            p.metrics.review_rate if p.metrics.review_rate is not None else 1.0,
        ),
    )
