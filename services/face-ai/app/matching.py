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
"""

from __future__ import annotations

import numpy as np

from app.schemas import (
    DEFAULT_MATCH_THRESHOLDS,
    MatchCandidate,
    MatchScore,
    MatchStatus,
    MatchThresholds,
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
) -> tuple[list[MatchScore], int]:
    """Score every candidate against the probe, highest similarity first.

    Returns ``(scores, skipped)``. A candidate whose embedding length does not
    match the running model's dimension is skipped and *counted* — it was
    enrolled under a different model, so its score would be meaningless. The
    count is surfaced to the caller because silently dropping candidates would
    turn "we could not compare this student" into "this student was absent".
    """
    scores: list[MatchScore] = []
    skipped = 0
    for candidate in candidates:
        if len(candidate.embedding) != embedding_dim:
            skipped += 1
            continue
        similarity = cosine_similarity(probe, candidate.embedding)
        scores.append(
            MatchScore(
                studentId=candidate.student_id,
                similarity=similarity,
                status=classify_match_status(similarity, thresholds),
            )
        )
    scores.sort(key=lambda s: s.similarity, reverse=True)
    return scores, skipped
