"""The provider abstraction must actually hold.

These tests are the mechanical version of the architectural claim "we can
replace the face model without rewriting anything". They exercise a second,
entirely synthetic provider through the same interface and the same routes as
the shipped mock, and assert the wire contract does not shift.
"""

from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.config import (
    MODEL_REGISTRY,
    BackendNotProductionEligibleError,
    BackendRegistration,
    Settings,
    build_provider,
    get_model,
    reset_model_cache,
)
from app.main import app
from app.models.base import AlignedFace, DetectionResult, FaceModelProvider
from app.models.mock_model import MockEmbeddingModel
from app.models.onnx_provider import (
    ModelWeightsNotConfiguredError,
    OnnxFaceModelProvider,
)
from app.schemas import (
    EMBEDDING_DIMENSION,
    BoundingBox,
    DetectedFace,
    DetectedFaceBox,
    FaceLandmarks,
    FaceQualityAssessment,
    FaceQualityMetric,
    FaceQualityMetrics,
    Point,
    SessionImageInput,
)


class FakeProvider(FaceModelProvider):
    """A deliberately different backend: different name, different weights
    version, different preprocessing version, different runtime, and a
    constant embedding. If the architecture is sound, swapping this in
    changes only the provenance fields — never the response shape."""

    name = "fake"
    weights_version = "9.9.9"
    preprocessing_version = "7"
    embedding_dim = EMBEDDING_DIMENSION
    runtime = "unit-test"
    commercial_use = "permitted"

    def __init__(self) -> None:
        self.loaded = False
        self.unloaded = False

    def load(self) -> None:
        self.loaded = True

    def unload(self) -> None:
        self.unloaded = True

    def detect(self, image_base64: str) -> DetectionResult:
        box = BoundingBox(x=1.0, y=2.0, width=10.0, height=10.0)
        return DetectionResult(
            faces=[
                DetectedFaceBox(
                    faceId=0,
                    boundingBox=box,
                    detectionConfidence=0.5,
                    landmarks=FaceLandmarks(
                        leftEye=Point(x=3.0, y=5.0),
                        rightEye=Point(x=8.0, y=5.0),
                        noseTip=Point(x=6.0, y=7.0),
                        mouthLeft=Point(x=4.0, y=9.0),
                        mouthRight=Point(x=8.0, y=9.0),
                    ),
                )
            ],
            image_width=100,
            image_height=200,
        )

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        return FaceQualityAssessment(
            reason="ok",
            qualityScore=0.77,
            faceCount=1,
            metrics=FaceQualityMetrics(
                blur=FaceQualityMetric.measured(120.0, "variance-of-laplacian"),
                brightness=FaceQualityMetric.unavailable(),
                faceSize=FaceQualityMetric.measured(180.0, "face-height-px"),
                pose=FaceQualityMetric.unavailable(),
                occlusion=FaceQualityMetric.unavailable(),
            ),
        )

    def align(self, image_base64, bounding_box, landmarks) -> AlignedFace:
        return AlignedFace(image_base64=image_base64, aligned=True)

    def embed(self, image_base64, bounding_box=None, landmarks=None):
        return [0.0] * (EMBEDDING_DIMENSION - 1) + [1.0]

    def detect_and_embed(self, image: SessionImageInput):
        return [
            DetectedFace(
                sequenceNumber=image.sequence_number,
                boundingBox=BoundingBox(x=0.0, y=0.0, width=1.0, height=1.0),
                embedding=self.embed(image.image_base64),
                detectionConfidence=0.5,
                qualityScore=0.77,
            )
        ]


@contextmanager
def client_for(provider: FaceModelProvider | None):
    """A client served by `provider`, or by the configured backend when None.

    Scoped as a context manager rather than a fixture because the
    cross-backend tests need one client active at a time — overlapping
    dependency overrides would quietly serve both requests from the same
    provider and the comparison would prove nothing.
    """
    if provider is not None:
        provider.load()
        app.dependency_overrides[get_model] = lambda: provider
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.pop(get_model, None)


@pytest.fixture
def fake_client():
    """Swap the provider via FastAPI's dependency override — the same seam
    production uses to select a backend, so the test proves the real path."""
    provider = FakeProvider()
    with client_for(provider) as client:
        yield client, provider


# ---------------------------------------------------------------------------
# Interface conformance
# ---------------------------------------------------------------------------


def test_shipped_backends_implement_the_full_provider_interface():
    for name, registration in MODEL_REGISTRY.items():
        assert issubclass(registration.provider_cls, FaceModelProvider), name
        # No abstract method left unimplemented — instantiating would raise.
        assert not getattr(
            registration.provider_cls, "__abstractmethods__", frozenset()
        ), f"{name} leaves abstract methods unimplemented"


def test_provider_composes_weights_and_preprocessing_into_one_version():
    provider = MockEmbeddingModel()
    assert provider.version == "0.1.0+pp1"
    # A preprocessing change must move the stored provenance string even when
    # the weights are untouched, because it invalidates old embeddings too.
    provider.preprocessing_version = "2"
    assert provider.version == "0.1.0+pp2"


def test_mock_reports_itself_as_not_production_eligible():
    info = MockEmbeddingModel().model_info()
    assert info.commercial_use == "not-applicable"
    assert info.production_eligible is False
    assert info.embedding_dim == EMBEDDING_DIMENSION
    assert info.embedding_normalized is True


def test_mock_embeddings_are_unit_length_and_correct_dimension():
    vector = MockEmbeddingModel().embed("some-image-bytes")
    assert len(vector) == EMBEDDING_DIMENSION
    norm = sum(v * v for v in vector) ** 0.5
    assert norm == pytest.approx(1.0, abs=1e-9)


def test_compare_embeddings_is_shared_not_per_backend():
    # Both providers inherit the same comparison, so a swap cannot change how
    # two vectors are scored.
    assert (
        FaceModelProvider.compare_embeddings
        is MockEmbeddingModel.compare_embeddings
        is FakeProvider.compare_embeddings
    )
    v = [1.0] + [0.0] * (EMBEDDING_DIMENSION - 1)
    assert MockEmbeddingModel().compare_embeddings(v, v) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Provider replaceability
# ---------------------------------------------------------------------------


def test_provider_can_be_replaced_without_changing_the_wire_contract():
    with client_for(FakeProvider()) as client:
        fake = client.post("/v1/enroll", json={"imageBase64": "hello"}).json()
    with client_for(None) as client:
        real = client.post("/v1/enroll", json={"imageBase64": "hello"}).json()

    # Same keys, same types — only the provenance values differ.
    assert set(fake) == set(real)
    assert fake["accepted"] is True and real["accepted"] is True
    assert len(fake["embedding"]) == len(real["embedding"]) == EMBEDDING_DIMENSION
    assert fake["modelName"] == "fake" and real["modelName"] == "mock"
    assert fake["modelVersion"] == "9.9.9+pp7"
    assert real["modelVersion"] == "0.1.0+pp1"


def test_model_info_reports_the_swapped_backend(fake_client):
    client, _ = fake_client
    info = client.get("/v1/model-info").json()
    assert info["modelName"] == "fake"
    assert info["weightsVersion"] == "9.9.9"
    assert info["preprocessingVersion"] == "7"
    assert info["runtime"] == "unit-test"
    assert info["commercialUse"] == "permitted"
    assert info["productionEligible"] is True


def test_detect_shape_is_identical_across_backends():
    with client_for(FakeProvider()) as client:
        fake = client.post("/v1/detect", json={"imageBase64": "hello"}).json()
    with client_for(None) as client:
        real = client.post("/v1/detect", json={"imageBase64": "hello"}).json()
    assert set(fake) == set(real)
    assert fake["faceCount"] == len(fake["faces"]) == 1
    assert set(fake["faces"][0]) == set(real["faces"][0])
    # Landmarks travel on both, which is what makes alignment possible at all.
    assert set(fake["faces"][0]["landmarks"]) == {
        "leftEye",
        "rightEye",
        "noseTip",
        "mouthLeft",
        "mouthRight",
    }


# ---------------------------------------------------------------------------
# Licensing guard
# ---------------------------------------------------------------------------


def test_every_registry_entry_declares_a_commercial_use_status():
    for name, registration in MODEL_REGISTRY.items():
        assert registration.commercial_use in {
            "permitted",
            "research-only",
            "unclear",
            "not-applicable",
        }, name
        assert registration.licence_note.strip(), f"{name} has no licence note"


#: Backends whose "permitted" status is recorded in models/LICENSING.md's
#: backend log. Adding a name here is the deliberate, reviewed act; flipping a
#: registry flag on its own is not enough to pass this test.
#:
#: ``azure`` ships no weights: it calls Microsoft's managed Azure AI Face
#: service under the subscription's product terms. Its separate Limited Access
#: gate on identification is enforced at runtime, not by this flag.
#:
#: ``azure_detection_own_recognition`` does run weights in this container: the
#: dlib ResNet recogniser, released into the public domain by its author and
#: checksum-pinned in app/models/model_files.py. Its licence audit is written
#: up in docs/MODEL_LICENSES.md, including the residual question about the
#: non-commercial research sets in its training data.
LICENCE_VERIFIED_BACKENDS = frozenset({"azure", "azure_detection_own_recognition"})

#: Backends that run weights in this container and have *not* been cleared.
#: Separate from the set above so that clearing one is an edit to both this
#: file and models/LICENSING.md, never a single flag flip.
UNVERIFIED_SELF_HOSTED_BACKENDS = frozenset({"onnx", "opencv"})


def test_no_shipped_backend_claims_commercial_clearance_it_does_not_have():
    # Guards against a future contributor flipping a status to 'permitted' to
    # silence the startup guard without recording a verified licence.
    for name, registration in MODEL_REGISTRY.items():
        if name in LICENCE_VERIFIED_BACKENDS:
            continue
        assert registration.commercial_use != "permitted", (
            f"Backend '{name}' claims commercial clearance. Update "
            f"models/LICENSING.md's backend log and this test together, "
            f"only after a licence has actually been verified."
        )


def test_every_unverified_self_hosted_backend_stays_out_of_production():
    # The scaffold and the OpenCV pair still have no cleared weights licence,
    # so neither can serve production however convenient it would be.
    for name in UNVERIFIED_SELF_HOSTED_BACKENDS:
        assert MODEL_REGISTRY[name].commercial_use != "permitted", name

    permitted = {
        name
        for name, registration in MODEL_REGISTRY.items()
        if registration.commercial_use == "permitted"
    }
    assert permitted == LICENCE_VERIFIED_BACKENDS


def test_startup_refuses_a_non_production_backend_when_production_required():
    settings = Settings(
        face_model_backend="mock", face_ai_require_production_model=True
    )
    with pytest.raises(BackendNotProductionEligibleError) as excinfo:
        build_provider(settings)
    assert "LICENSING.md" in str(excinfo.value)


def test_non_production_backend_is_allowed_when_production_not_required():
    settings = Settings(
        face_model_backend="mock", face_ai_require_production_model=False
    )
    assert isinstance(build_provider(settings), MockEmbeddingModel)


def test_unknown_backend_name_is_rejected():
    with pytest.raises(ValueError, match="Unknown FACE_MODEL_BACKEND"):
        build_provider(Settings(face_model_backend="does-not-exist"))


def test_a_permitted_backend_passes_the_production_guard(monkeypatch):
    monkeypatch.setitem(
        MODEL_REGISTRY,
        "licensed-fake",
        BackendRegistration(
            provider_cls=FakeProvider,
            commercial_use="permitted",
            licence_note="Synthetic backend used only by this test.",
        ),
    )
    settings = Settings(
        face_model_backend="licensed-fake", face_ai_require_production_model=True
    )
    assert isinstance(build_provider(settings), FakeProvider)
    reset_model_cache()


# ---------------------------------------------------------------------------
# The ONNX scaffold
# ---------------------------------------------------------------------------


def test_onnx_backend_refuses_to_load_without_configured_weights():
    provider = OnnxFaceModelProvider(model_dir=None)
    with pytest.raises(ModelWeightsNotConfiguredError) as excinfo:
        provider.load()
    assert "FACE_MODEL_DIR" in str(excinfo.value)


def test_onnx_backend_is_not_production_eligible():
    assert OnnxFaceModelProvider().model_info().production_eligible is False


def test_onnx_backend_fails_loudly_rather_than_reporting_no_faces():
    # An unconfigured recogniser returning an empty face list would read as
    # "nobody was present" and quietly mark a whole class absent.
    with pytest.raises(ModelWeightsNotConfiguredError):
        OnnxFaceModelProvider().detect("anything")


def test_onnx_provider_receives_execution_provider_configuration():
    settings = Settings(
        face_model_backend="onnx",
        face_model_execution_providers="CUDAExecutionProvider,CPUExecutionProvider",
        face_model_intra_op_threads=4,
    )
    provider = build_provider(settings)
    assert isinstance(provider, OnnxFaceModelProvider)
    # GPU vs CPU is configuration, not an architectural change.
    assert provider._execution_providers == [
        "CUDAExecutionProvider",
        "CPUExecutionProvider",
    ]
    assert provider._intra_op_num_threads == 4
