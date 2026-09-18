"""Matching must never turn a weak score into an attendance record.

The confidence engine's whole purpose is that "probably this student" routes
to a human instead of to a PRESENT mark, so the boundaries are tested
explicitly rather than assumed.
"""

import pytest

from app.matching import (
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
)

THRESHOLDS = MatchThresholds(matchThreshold=0.62, reviewThreshold=0.45)


def unit(index: int) -> list[float]:
    v = [0.0] * EMBEDDING_DIMENSION
    v[index] = 1.0
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
        probe, candidates, THRESHOLDS, EMBEDDING_DIMENSION
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
        unit(0), candidates, THRESHOLDS, EMBEDDING_DIMENSION
    )
    assert skipped == 1
    assert [s.student_id for s in scores] == ["ok"]


def test_empty_candidate_list_yields_no_scores():
    scores, skipped = score_candidates(unit(0), [], THRESHOLDS, EMBEDDING_DIMENSION)
    assert scores == []
    assert skipped == 0
