"""Similarity scoring and the normalised MATCHED/UNCERTAIN/UNMATCHED decision.

Kept out of the routers and out of every model adapter on purpose. Scoring
and status classification must be *identical* across backends: if each
adapter re-implemented cosine similarity or its own notion of "confident
enough", swapping a model would silently change attendance outcomes for
reasons that have nothing to do with the model.

The threshold values themselves are NOT decided here — they are product
policy, owned per-institution by apps/web and passed in on each request. This
module only applies them, and the caller gets back the thresholds that were
used so any stored result stays explainable.

A backend whose recogniser scores on a different scale publishes a
``ScoreCalibration``. ``calibrate`` maps a raw similarity onto the product's
scale before any threshold sees it. apps/web does the same with the same map.
"""

from __future__ import annotations

from itertools import pairwise

import numpy as np

from app.schemas import (
    DEFAULT_MATCH_THRESHOLDS,
    MatchCandidate,
    MatchScore,
    MatchStatus,
    MatchThresholds,
    ScoreCalibration,
)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity in [-1, 1].

    Computed explicitly rather than assuming unit-length inputs: adapters are
    required to L2-normalise, but a candidate vector arrives from the database
    and may predate that guarantee. Normalising here costs one pass and makes
    the function correct for un-normalised input too.
    """
    va = np.asarray(a, dtype=np.float64)
    vb = np.asarray(b, dtype=np.float64)
    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na == 0.0 or nb == 0.0:
        # A zero vector has no direction, so it is similar to nothing. Return
        # 0.0 rather than raising: one corrupt stored template must not fail
        # an entire classroom's recognition run.
        return 0.0
    return float(np.dot(va, vb) / (na * nb))


def calibrate(raw: float, calibration: ScoreCalibration | None) -> float:
    """A raw cosine similarity on the product's scale.

    Linear between neighbouring knots. The knots span raw -1 to 1 and
    strictly increase, so the map is monotone: calibration can never reorder
    two candidates. It only changes which side of a threshold they fall on.
    ``None`` means that the backend's raw scale already is the product's.

    A raw score exactly on a knot reads as exactly that knot's value, and
    rounding never carries a score past the knot above it. Without both, a
    score on the review knot could land a rounding error below the review
    threshold. apps/web implements the same arithmetic in the same order.
    """
    if calibration is None:
        return raw
    knots = calibration.knots
    value = min(max(raw, knots[0].raw), knots[-1].raw)
    for low, high in pairwise(knots):
        if value < high.raw:
            t = (value - low.raw) / (high.raw - low.raw)
            return min(
                low.calibrated + t * (high.calibrated - low.calibrated),
                high.calibrated,
            )
        if value == high.raw:
            return high.calibrated
    return knots[-1].calibrated


def classify_match_status(
    similarity: float, thresholds: MatchThresholds
) -> MatchStatus:
    """Map a raw similarity onto the normalised decision vocabulary.

    Deliberately ordered so that a score can only be MATCHED by clearing the
    higher bar. There is no path by which a low-confidence score becomes a
    match — the UNCERTAIN band exists precisely so that "probably" routes to a
    human instead of to an attendance record.
    """
    if similarity >= thresholds.match_threshold:
        return "MATCHED"
    if similarity >= thresholds.review_threshold:
        return "UNCERTAIN"
    return "UNMATCHED"


def resolve_thresholds(thresholds: MatchThresholds | None) -> MatchThresholds:
    """Apply the caller's thresholds, or a conservative default.

    A caller that inverts the two bounds (review above match) would otherwise
    create a band where nothing can ever be UNCERTAIN, quietly turning
    borderline scores into confident matches. Clamp instead of trusting it.
    """
    resolved = thresholds or DEFAULT_MATCH_THRESHOLDS
    if resolved.review_threshold > resolved.match_threshold:
        return MatchThresholds(
            matchThreshold=resolved.match_threshold,
            reviewThreshold=resolved.match_threshold,
        )
    return resolved


def score_candidates(
    probe: list[float],
    candidates: list[MatchCandidate],
    thresholds: MatchThresholds,
    embedding_dim: int,
    *,
    calibration: ScoreCalibration | None,
) -> tuple[list[MatchScore], int]:
    """Score every candidate against the probe, highest similarity first.

    Returns ``(scores, skipped)``. A candidate whose embedding length does not
    match the running model's dimension is skipped and *counted* — it was
    enrolled under a different model, so its score would be meaningless. The
    count is surfaced to the caller because silently dropping candidates would
    turn "we could not compare this student" into "this student was absent".

    ``calibration`` is required, even when it is None, so that no caller can
    forget it. Raw dlib scores compared against thresholds set for another
    scale would mark nearly every candidate MATCHED. When the calibration
    has a raw ambiguity margin, a best match whose lead over the runner-up is
    below that margin is reported UNCERTAIN, because two students are too
    close to call.
    """
    scored: list[tuple[float, MatchScore]] = []
    skipped = 0
    for candidate in candidates:
        if len(candidate.embedding) != embedding_dim:
            skipped += 1
            continue
        raw = cosine_similarity(probe, candidate.embedding)
        similarity = calibrate(raw, calibration)
        scored.append(
            (
                raw,
                MatchScore(
                    studentId=candidate.student_id,
                    similarity=similarity,
                    status=classify_match_status(similarity, thresholds),
                    rawSimilarity=raw,
                ),
            )
        )
    # Ranked on the raw score, which calibration cannot reorder, with the
    # student id breaking ties so equal scores come back in the same order
    # every time.
    scored.sort(key=lambda pair: (-pair[0], pair[1].student_id))
    scores = [score for _, score in scored]
    if (
        calibration is not None
        and len(scored) >= 2
        and scores[0].status == "MATCHED"
        and scored[0][0] - scored[1][0] < calibration.raw_ambiguity_margin
    ):
        scores[0] = scores[0].model_copy(update={"status": "UNCERTAIN"})
    return scores, skipped
