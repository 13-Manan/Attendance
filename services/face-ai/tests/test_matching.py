"""Matching must never turn a weak score into an attendance record.

The confidence engine's whole purpose is that "probably this student" routes
to a human instead of to a PRESENT mark, so the boundaries are tested
explicitly rather than assumed.
"""

import math
from itertools import pairwise

import pytest
from pydantic import ValidationError

from app.matching import (
    calibrate,
    classify_match_status,
    cosine_similarity,
    resolve_thresholds,
    score_candidates,
)
from app.schemas import (
    DEFAULT_MATCH_THRESHOLDS,
    EMBEDDING_DIMENSION,
    MatchCandidate,
    MatchThresholds,
    ScoreCalibration,
)

THRESHOLDS = MatchThresholds(matchThreshold=0.62, reviewThreshold=0.45)

# The shape of the production dlib calibration: raw 0.93 reads as the review
# threshold, raw 0.955 as the present threshold.
CALIBRATION = ScoreCalibration(
    id="test",
    knots=[
        {"raw": -1.0, "calibrated": -1.0},
        {"raw": 0.93, "calibrated": 0.45},
        {"raw": 0.955, "calibrated": 0.62},
        {"raw": 1.0, "calibrated": 1.0},
    ],
    rawAmbiguityMargin=0.01,
)


def unit(index: int) -> list[float]:
    v = [0.0] * EMBEDDING_DIMENSION
    v[index] = 1.0
    return v


def at_cosine(c: float, axis: int) -> list[float]:
    """A unit vector whose cosine with unit(0) is exactly ``c``."""
    v = [0.0] * EMBEDDING_DIMENSION
    v[0] = c
    v[axis] = math.sqrt(1.0 - c * c)
    return v


# ---------------------------------------------------------------------------
# Status classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "similarity,expected",
    [
        (0.99, "MATCHED"),
        (0.62, "MATCHED"),  # boundary is inclusive
        (0.6199, "UNCERTAIN"),
        (0.50, "UNCERTAIN"),
        (0.45, "UNCERTAIN"),  # boundary is inclusive
        (0.4499, "UNMATCHED"),
        (0.0, "UNMATCHED"),
        (-1.0, "UNMATCHED"),
    ],
)
def test_classify_match_status_boundaries(similarity, expected):
    assert classify_match_status(similarity, THRESHOLDS) == expected


def test_a_low_score_can_never_be_reported_as_matched():
    for similarity in [0.0, 0.1, 0.2, 0.3, 0.44]:
        assert classify_match_status(similarity, THRESHOLDS) == "UNMATCHED"


def test_inverted_thresholds_cannot_create_a_confident_match():
    # A misconfiguration that put review above match would otherwise leave no
    # band in which a borderline score is UNCERTAIN.
    resolved = resolve_thresholds(
        MatchThresholds(matchThreshold=0.5, reviewThreshold=0.9)
    )
    assert resolved.review_threshold <= resolved.match_threshold
    assert classify_match_status(0.6, resolved) == "MATCHED"
    assert classify_match_status(0.4, resolved) == "UNMATCHED"


def test_missing_thresholds_fall_back_to_the_conservative_default():
    assert resolve_thresholds(None) == DEFAULT_MATCH_THRESHOLDS


# ---------------------------------------------------------------------------
# Similarity
# ---------------------------------------------------------------------------


def test_cosine_similarity_basics():
    assert cosine_similarity(unit(0), unit(0)) == pytest.approx(1.0)
    assert cosine_similarity(unit(0), unit(1)) == pytest.approx(0.0)
    assert cosine_similarity(unit(0), [-v for v in unit(0)]) == pytest.approx(-1.0)


def test_cosine_similarity_normalises_unnormalised_input():
    scaled = [v * 17.0 for v in unit(0)]
    assert cosine_similarity(unit(0), scaled) == pytest.approx(1.0)


def test_zero_vector_scores_zero_rather_than_raising():
    # One corrupt stored template must not fail an entire classroom's run.
    assert cosine_similarity(unit(0), [0.0] * EMBEDDING_DIMENSION) == 0.0


# ---------------------------------------------------------------------------
# Candidate scoring
# ---------------------------------------------------------------------------


def test_scores_are_sorted_best_first_and_carry_their_own_status():
    probe = unit(0)
    candidates = [
        MatchCandidate(studentId="far", embedding=unit(1)),
        MatchCandidate(studentId="exact", embedding=unit(0)),
    ]
    scores, skipped = score_candidates(
        probe, candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=None
    )
    assert skipped == 0
    assert [s.student_id for s in scores] == ["exact", "far"]
    assert scores[0].status == "MATCHED"
    assert scores[1].status == "UNMATCHED"


def test_candidates_from_a_different_model_are_skipped_and_counted():
    # A template enrolled under another model has a different dimension; its
    # score would be meaningless. Counting the skip stops "could not compare"
    # being silently recorded as "absent".
    candidates = [
        MatchCandidate(studentId="wrong-dim", embedding=[0.1, 0.2, 0.3]),
        MatchCandidate(studentId="ok", embedding=unit(0)),
    ]
    scores, skipped = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=None
    )
    assert skipped == 1
    assert [s.student_id for s in scores] == ["ok"]


def test_empty_candidate_list_yields_no_scores():
    scores, skipped = score_candidates(
        unit(0), [], THRESHOLDS, EMBEDDING_DIMENSION, calibration=None
    )
    assert scores == []
    assert skipped == 0


def test_equal_scores_come_back_in_a_stable_order():
    candidates = [
        MatchCandidate(studentId="b", embedding=unit(0)),
        MatchCandidate(studentId="a", embedding=unit(0)),
    ]
    scores, _ = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=None
    )
    assert [s.student_id for s in scores] == ["a", "b"]


def test_scoring_requires_the_caller_to_state_the_calibration():
    # Forgetting it must be an error, not "read raw dlib scores as calibrated".
    with pytest.raises(TypeError):
        score_candidates(unit(0), [], THRESHOLDS, EMBEDDING_DIMENSION)  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------


def test_no_calibration_reads_raw_scores_as_they_are():
    for raw in (-1.0, 0.0, 0.5, 0.93, 1.0):
        assert calibrate(raw, None) == raw


@pytest.mark.parametrize(
    "raw,expected",
    [
        (-1.0, -1.0),
        (0.93, 0.45),
        (0.955, 0.62),
        (1.0, 1.0),
        (0.9425, 0.535),  # halfway between the review and present knots
        (-0.035, -0.275),  # halfway along the first segment
    ],
)
def test_calibration_interpolates_linearly_between_knots(raw, expected):
    assert calibrate(raw, CALIBRATION) == pytest.approx(expected)


def test_calibration_clamps_out_of_range_input():
    # Float error can push a cosine a hair past 1.
    assert calibrate(1.0000001, CALIBRATION) == pytest.approx(1.0)
    assert calibrate(-1.0000001, CALIBRATION) == pytest.approx(-1.0)


def test_calibration_never_reorders_scores():
    raws = [i / 1000 for i in range(-1000, 1001)]
    calibrated = [calibrate(r, CALIBRATION) for r in raws]
    assert all(b > a for a, b in pairwise(calibrated))


def test_raw_scores_just_under_the_knots_stay_on_the_safe_side():
    def status(raw):
        return classify_match_status(calibrate(raw, CALIBRATION), THRESHOLDS)

    assert status(0.9549) == "UNCERTAIN"
    assert status(0.955) == "MATCHED"
    assert status(0.9299) == "UNMATCHED"
    assert status(0.93) == "UNCERTAIN"


@pytest.mark.parametrize(
    "knots,message",
    [
        ([{"raw": -1.0, "calibrated": -1.0}], "at least two"),
        (
            [{"raw": -0.5, "calibrated": -1.0}, {"raw": 1.0, "calibrated": 1.0}],
            "span",
        ),
        (
            [
                {"raw": -1.0, "calibrated": -1.0},
                {"raw": 0.9, "calibrated": 0.7},
                {"raw": 0.95, "calibrated": 0.6},
                {"raw": 1.0, "calibrated": 1.0},
            ],
            "strictly increase",
        ),
        (
            [
                {"raw": -1.0, "calibrated": -1.0},
                {"raw": 0.9, "calibrated": 0.5},
                {"raw": 0.9, "calibrated": 0.6},
                {"raw": 1.0, "calibrated": 1.0},
            ],
            "strictly increase",
        ),
        (
            [{"raw": -1.0, "calibrated": -2.0}, {"raw": 1.0, "calibrated": 1.0}],
            "lie in",
        ),
    ],
)
def test_a_calibration_that_could_reorder_or_escape_the_scale_is_rejected(
    knots, message
):
    with pytest.raises(ValidationError, match=message):
        ScoreCalibration(id="bad", knots=knots, rawAmbiguityMargin=0.01)


def test_calibrated_scoring_reports_both_scales():
    candidates = [
        MatchCandidate(studentId="strong", embedding=at_cosine(0.97, 1)),
        MatchCandidate(studentId="middling", embedding=at_cosine(0.94, 2)),
        MatchCandidate(studentId="stranger", embedding=at_cosine(0.90, 3)),
    ]
    scores, _ = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=CALIBRATION
    )
    by_id = {s.student_id: s for s in scores}
    assert [s.student_id for s in scores] == ["strong", "middling", "stranger"]
    assert by_id["strong"].status == "MATCHED"
    assert by_id["middling"].status == "UNCERTAIN"
    assert by_id["stranger"].status == "UNMATCHED"
    assert by_id["strong"].raw_similarity == pytest.approx(0.97)
    assert by_id["strong"].similarity == pytest.approx(calibrate(0.97, CALIBRATION))


def test_uncalibrated_raw_dlib_scores_would_have_matched_a_stranger():
    # Why the calibration is mandatory: a raw 0.90 is a typical score between
    # two different people under dlib, and on the product scale it clears 0.62.
    candidates = [MatchCandidate(studentId="stranger", embedding=at_cosine(0.90, 1))]
    raw, _ = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=None
    )
    calibrated, _ = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=CALIBRATION
    )
    assert raw[0].status == "MATCHED"
    assert calibrated[0].status == "UNMATCHED"


def test_a_best_match_too_close_to_the_runner_up_is_demoted():
    candidates = [
        MatchCandidate(studentId="rahul", embedding=at_cosine(0.970, 1)),
        MatchCandidate(studentId="aman", embedding=at_cosine(0.965, 2)),
    ]
    scores, _ = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=CALIBRATION
    )
    assert scores[0].student_id == "rahul"
    # 0.970 clears the present knot on its own, but the lead is 0.005 raw.
    assert calibrate(0.970, CALIBRATION) >= THRESHOLDS.match_threshold
    assert scores[0].status == "UNCERTAIN"


def test_a_clear_lead_keeps_the_match():
    candidates = [
        MatchCandidate(studentId="rahul", embedding=at_cosine(0.970, 1)),
        MatchCandidate(studentId="aman", embedding=at_cosine(0.955, 2)),
    ]
    scores, _ = score_candidates(
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION, calibration=CALIBRATION
    )
    assert scores[0].student_id == "rahul"
    assert scores[0].status == "MATCHED"
