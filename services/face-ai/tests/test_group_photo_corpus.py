"""Real-model group photos, from a corpus that is NOT in the repository.

    FACE_QA_CORPUS=/path/outside/repo/pairs pytest tests/test_group_photo_corpus.py

Skipped unless ``FACE_QA_CORPUS`` names a directory of ``<id>_enroll.jpg`` /
``<id>_probe.jpg`` pairs (two different photographs of each person) and the
pinned model artefacts are present. Nothing is written: portraits are read,
composed into a grid in memory, and only similarities are asserted.

Enrolment photos become templates; the *other* photo of each person goes into
the class photo, so every match is across two different photographs. A few
identities are left un-enrolled and put in the photo too — they are the
"unknown face" case and must not reach the review threshold against anybody.

The one-to-one assignment, the multi-photo merge and the teacher-facing
categories live in apps/web (recognition-engine); their group-photo tests run
there with synthetic vectors. This file proves the part only a real model can:
that a composed class photo yields one usable, correctly-ranked embedding per
face.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import numpy as np
import pytest

from app.models.model_files import ModelArtifactError, verify_all
from app.schemas import DEFAULT_MATCH_THRESHOLDS, SessionImageInput

cv2 = pytest.importorskip("cv2", reason="opencv-python-headless is required")

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"
CORPUS = os.environ.get("FACE_QA_CORPUS")


def _ready() -> bool:
    if not CORPUS or not Path(CORPUS).is_dir():
        return False
    try:
        verify_all(MODEL_DIR)
    except ModelArtifactError:
        return False
    return True


pytestmark = pytest.mark.skipif(
    not _ready(), reason="Set FACE_QA_CORPUS to a pair corpus outside the repo"
)

PRESENT = DEFAULT_MATCH_THRESHOLDS.match_threshold
REVIEW = DEFAULT_MATCH_THRESHOLDS.review_threshold
ENROLLED, UNKNOWN = 16, 3


def _b64(frame: np.ndarray, quality: int = 90) -> str:
    return base64.b64encode(
        cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tobytes()
    ).decode()


@pytest.fixture(scope="module")
def world():
    from app.models.opencv_provider import OpenCVFaceModelProvider
    from bench.group_compose import head_crop, load_pairs

    provider = OpenCVFaceModelProvider(model_dir=str(MODEL_DIR))
    provider.load()
    pairs = load_pairs(Path(CORPUS))
    if len(pairs) < ENROLLED + UNKNOWN:
        pytest.skip(f"corpus has {len(pairs)} pairs; {ENROLLED + UNKNOWN} needed")

    templates: dict[str, np.ndarray] = {}
    heads: dict[str, tuple[np.ndarray, float]] = {}
    for ident, enrol, probe in pairs[: ENROLLED + UNKNOWN]:
        head = head_crop(provider.detector, cv2.imread(str(probe)))
        assert head is not None, ident
        heads[ident] = head
        if len(templates) < ENROLLED:
            outcome = provider.enroll_image(_b64(cv2.imread(str(enrol))))
            assert outcome.embedding is not None, (ident, outcome.assessment.reasons)
            templates[ident] = np.asarray(outcome.embedding)
    return provider, templates, heads


def _class_photo(world, face_px: int):
    from bench.group_compose import compose

    provider, _, heads = world
    frame, placed = compose([(i, *heads[i]) for i in heads], face_px)
    analysis = provider.analyze_image(
        SessionImageInput(sequenceNumber=1, imageBase64=_b64(frame))
    )
    return analysis, placed


def _best(templates, vector):
    scores = sorted(
        ((float(vector @ t), ident) for ident, t in templates.items()), reverse=True
    )
    return scores[0], scores[1]


def test_every_face_in_a_class_photo_is_found_and_embedded(world):
    analysis, placed = _class_photo(world, face_px=96)
    assert analysis.summary.detected_faces == len(placed)
    assert analysis.summary.embedded_faces == len(placed)
    assert analysis.rejected == []


def test_enrolled_students_rank_first_and_unknown_faces_stay_below_review(world):
    from bench.group_compose import nearest

    _, templates, _ = world
    analysis, placed = _class_photo(world, face_px=96)
    seen = set()
    for face in analysis.faces:
        b = face.bounding_box
        who = nearest(placed, b.x + b.width / 2, b.y + b.height / 2).identity
        seen.add(who)
        (score, best), (runner_up, _) = _best(templates, np.asarray(face.embedding))
        if who in templates:
            assert best == who, (who, best, score)
            assert score >= REVIEW, (who, score)
            assert score - runner_up > 0.1, (who, score, runner_up)
        else:
            # Unknown person: never close enough to anyone to even be reviewed
            # as them.
            assert score < REVIEW, (who, best, score)
    assert seen == set(i.identity for i in placed)


def test_small_faces_are_flagged_and_never_confidently_wrong(world):
    from bench.group_compose import nearest

    _, templates, _ = world
    analysis, placed = _class_photo(world, face_px=26)
    for face in analysis.faces:
        assert "face_too_small" in face.quality_flags
        b = face.bounding_box
        who = nearest(placed, b.x + b.width / 2, b.y + b.height / 2).identity
        (score, best), _ = _best(templates, np.asarray(face.embedding))
        if best != who:
            assert score < PRESENT, (who, best, score)


def test_the_same_student_in_two_photos_yields_two_matching_embeddings(world):
    # The merge itself is apps/web's job; this proves its input is sound — the
    # same face in two captures produces vectors that agree with each other.
    from bench.group_compose import nearest

    def by_identity(face_px):
        analysis, placed = _class_photo(world, face_px)
        out = {}
        for face in analysis.faces:
            box = face.bounding_box
            who = nearest(placed, box.x + box.width / 2, box.y + box.height / 2)
            out[who.identity] = np.asarray(face.embedding)
        return out

    first, second = by_identity(96), by_identity(72)
    assert first.keys() == second.keys()
    for ident in first:
        assert float(first[ident] @ second[ident]) > PRESENT, ident
