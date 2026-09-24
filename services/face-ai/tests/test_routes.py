"""End-to-end checks of the HTTP contract against the shipped mock backend.

These assert the wire format apps/web depends on: camelCase keys, the
quality gate's structural guarantee that a rejection carries no embedding,
and the normalised match statuses.
"""

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas import EMBEDDING_DIMENSION, FACE_AI_CONTRACT_VERSION


@pytest.fixture
def client():
    # The context manager runs the lifespan handler, so this also proves the
    # model loads at startup rather than on first request.
    with TestClient(app) as c:
        yield c


def test_health_reports_the_loaded_model(client):
    body = client.get("/v1/health").json()
    assert body["status"] == "ok"
    assert body["modelName"] == "mock"
    assert body["embeddingDim"] == EMBEDDING_DIMENSION


def test_model_info_exposes_full_provenance(client):
    info = client.get("/v1/model-info").json()
    assert info == {
        "modelName": "mock",
        "modelVersion": "0.1.0+pp1",
        "weightsVersion": "0.1.0",
        "preprocessingVersion": "1",
        "embeddingDim": EMBEDDING_DIMENSION,
        "embeddingNormalized": True,
        "runtime": "numpy-hash-stub",
        "commercialUse": "not-applicable",
        "productionEligible": False,
        "contractVersion": FACE_AI_CONTRACT_VERSION,
        # An embedding backend: apps/web stores and compares the vectors.
        "templateKind": "embedding",
        "identification": "not_applicable",
        # The mock describes itself as what it is: a hash, not a recogniser.
        "stages": [
            {
                "role": "embedder",
                "name": "sha256-bytes-hash",
                "version": "0.1.0",
                "runtime": "numpy-hash-stub",
                "commercialUse": "not-applicable",
                "productionReady": False,
                "capabilities": [],
                "requiredAssets": [],
                "embeddingDim": EMBEDDING_DIMENSION,
                "licenceNote": (
                    "No model and no weights. Vectors are a hash of the image "
                    "bytes and cannot identify anyone. Never a production "
                    "recogniser."
                ),
            }
        ],
    }


# ---------------------------------------------------------------------------
# Quality gate
# ---------------------------------------------------------------------------


def test_enroll_accepts_a_good_capture(client):
    body = client.post("/v1/enroll", json={"imageBase64": "good-image"}).json()
    assert body["accepted"] is True
    assert len(body["embedding"]) == EMBEDDING_DIMENSION
    assert body["assessment"]["reason"] == "ok"
    assert body["weightsVersion"] == "0.1.0"
    assert body["preprocessingVersion"] == "1"


@pytest.mark.parametrize(
    "prefix,reason",
    [
        ("NO_FACE:", "no_face"),
        ("MULTI:", "multiple_faces"),
        ("SMALL:", "face_too_small"),
        ("BLUR:", "blurred"),
        ("DARK:", "too_dark"),
        ("OCCLUDED:", "occluded"),
        ("ANGLE:", "bad_angle"),
        ("LOW:", "low_quality"),
    ],
)
def test_enroll_rejects_bad_captures_without_producing_an_embedding(
    client, prefix, reason
):
    body = client.post("/v1/enroll", json={"imageBase64": f"{prefix}x"}).json()
    assert body["accepted"] is False
    assert body["assessment"]["reason"] == reason
    # The rejected arm has no field to carry an embedding, so a caller cannot
    # forward one by mistake. This is the structural half of "do not silently
    # enrol bad data".
    assert "embedding" not in body


def test_enroll_aligns_the_face_it_embeds(client):
    """Enrolment runs the detector and uses what it found.

    The route once called ``align(image, None, None)``, so every accepted
    capture reported ``aligned: false`` and every stored template was built
    from a plain box crop. For an ArcFace-family recogniser that is a
    materially worse embedding, and nothing fails visibly — the student is
    simply matched less reliably for as long as the template exists. apps/web
    now stores this flag, so a regression here would be recorded against every
    row it produced.
    """
    body = client.post("/v1/enroll", json={"imageBase64": "good-image"}).json()
    assert body["accepted"] is True
    assert body["aligned"] is True


def test_enroll_returns_a_unit_length_embedding(client):
    """The contract apps/web now verifies before storing anything.

    Cosine similarity is computed as a dot product downstream, so a vector
    that is not unit length does not score slightly wrong — it scores on a
    different scale, and every threshold in the product misreads it.
    """
    body = client.post("/v1/enroll", json={"imageBase64": "good-image"}).json()
    norm = math.sqrt(sum(value * value for value in body["embedding"]))
    assert norm == pytest.approx(1.0, abs=1e-6)


def test_enroll_reports_the_provenance_a_model_swap_needs(client):
    """Weights and preprocessing travel as their own fields, not only inside
    the composite ``modelVersion``. A future re-enrolment migration has to
    answer "which rows came from which weights" without parsing a string."""
    body = client.post("/v1/enroll", json={"imageBase64": "good-image"}).json()
    composite = f"{body['weightsVersion']}+pp{body['preprocessingVersion']}"
    assert body["modelVersion"] == composite
    assert body["embeddingDim"] == EMBEDDING_DIMENSION


def test_quality_reports_unimplemented_metrics_as_unavailable(client):
    body = client.post("/v1/quality", json={"imageBase64": "good"}).json()
    metrics = body["assessment"]["metrics"]
    assert set(metrics) == {
        "blur",
        "brightness",
        "faceSize",
        "pose",
        "occlusion",
        "yaw",
        "pitch",
        "underexposure",
        "overexposure",
        "detectionConfidence",
        "interEyeDistance",
    }
    for name, metric in metrics.items():
        # The mock measures nothing; it must say so rather than invent a
        # number an operator might tune thresholds against.
        assert metric["status"] == "unavailable", name
        assert metric["value"] is None, name


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def test_detect_returns_boxes_landmarks_and_image_dimensions(client):
    body = client.post("/v1/detect", json={"imageBase64": "good"}).json()
    assert body["faceCount"] == 1
    assert body["imageWidth"] > 0 and body["imageHeight"] > 0
    face = body["faces"][0]
    assert face["faceId"] == 0
    assert set(face["boundingBox"]) == {"x", "y", "width", "height"}
    assert 0.0 <= face["detectionConfidence"] <= 1.0
    assert face["landmarks"]["leftEye"]["x"] < face["landmarks"]["rightEye"]["x"]


def test_detect_reports_multiple_faces(client):
    body = client.post("/v1/detect", json={"imageBase64": "MULTI:x"}).json()
    assert body["faceCount"] == 2
    assert [f["faceId"] for f in body["faces"]] == [0, 1]


def test_detect_reports_no_faces(client):
    body = client.post("/v1/detect", json={"imageBase64": "NO_FACE:x"}).json()
    assert body["faceCount"] == 0
    assert body["faces"] == []


def test_embed_reports_whether_it_aligned(client):
    without = client.post("/v1/embed", json={"imageBase64": "good"}).json()
    assert without["aligned"] is False
    assert len(without["embedding"]) == EMBEDDING_DIMENSION

    detected = client.post("/v1/detect", json={"imageBase64": "good"}).json()
    with_landmarks = client.post(
        "/v1/embed",
        json={
            "imageBase64": "good",
            "landmarks": detected["faces"][0]["landmarks"],
        },
    ).json()
    assert with_landmarks["aligned"] is True


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def _embedding_for(client, image: str) -> list[float]:
    return client.post("/v1/embed", json={"imageBase64": image}).json()["embedding"]


def test_match_returns_matched_for_the_same_face(client):
    same = _embedding_for(client, "student-a")
    body = client.post(
        "/v1/match",
        json={
            "imageBase64": "student-a",
            "candidates": [{"studentId": "a", "embedding": same}],
        },
    ).json()
    assert body["status"] == "MATCHED"
    assert body["bestMatch"]["studentId"] == "a"
    assert body["bestMatch"]["status"] == "MATCHED"
    assert body["thresholdsUsed"] == {"matchThreshold": 0.62, "reviewThreshold": 0.45}


def test_match_returns_unmatched_for_a_stranger(client):
    other = _embedding_for(client, "student-b")
    body = client.post(
        "/v1/match",
        json={
            "imageBase64": "student-a",
            "candidates": [{"studentId": "b", "embedding": other}],
        },
    ).json()
    assert body["status"] == "UNMATCHED"
    # A best-scoring candidate still exists; its status is what decides.
    assert body["bestMatch"]["status"] == "UNMATCHED"


def test_match_returns_uncertain_inside_the_review_band(client):
    same = _embedding_for(client, "student-a")
    # Raise the accept bar above a perfect self-match so the score lands in
    # the review band without needing a contrived embedding.
    body = client.post(
        "/v1/match",
        json={
            "imageBase64": "student-a",
            "candidates": [{"studentId": "a", "embedding": same}],
            "thresholds": {"matchThreshold": 1.5, "reviewThreshold": 0.5},
        },
    ).json()
    assert body["status"] == "UNCERTAIN"
    assert body["thresholdsUsed"]["matchThreshold"] == 1.5


def test_match_with_no_candidates_is_unmatched_not_an_error(client):
    body = client.post(
        "/v1/match", json={"imageBase64": "student-a", "candidates": []}
    ).json()
    assert body["status"] == "UNMATCHED"
    assert body["bestMatch"] is None
    assert body["scores"] == []


def test_match_counts_candidates_it_could_not_compare(client):
    body = client.post(
        "/v1/match",
        json={
            "imageBase64": "student-a",
            "candidates": [{"studentId": "old-model", "embedding": [0.1, 0.2]}],
        },
    ).json()
    assert body["skippedIncompatibleCandidates"] == 1
    assert body["status"] == "UNMATCHED"
    assert body["scores"] == []


def test_match_only_ever_sees_the_candidates_it_was_given(client):
    """The class-scoped search guarantee, from the service's side.

    The service holds no database credentials and no candidate store, so the
    scored set is exactly the caller's list — it cannot reach a student in
    another cohort or another institution even in principle.
    """
    mine = _embedding_for(client, "student-a")
    body = client.post(
        "/v1/match",
        json={
            "imageBase64": "student-a",
            "candidates": [{"studentId": "in-my-class", "embedding": mine}],
        },
    ).json()
    assert [s["studentId"] for s in body["scores"]] == ["in-my-class"]


# ---------------------------------------------------------------------------
# Contract parity
# ---------------------------------------------------------------------------


def test_python_contract_version_matches_the_typescript_contract():
    """The two schema definitions are hand-synced; this makes drift fail CI."""
    import pathlib
    import re

    ts = (
        pathlib.Path(__file__).resolve().parents[3]
        / "packages"
        / "shared-types"
        / "src"
        / "face-ai-contract.ts"
    ).read_text()

    version = re.search(r'FACE_AI_CONTRACT_VERSION\s*=\s*"([^"]+)"', ts)
    dimension = re.search(r"EMBEDDING_DIMENSION\s*=\s*(\d+)", ts)
    assert version and dimension, "could not read the TypeScript contract"
    assert version.group(1) == FACE_AI_CONTRACT_VERSION
    assert int(dimension.group(1)) == EMBEDDING_DIMENSION
