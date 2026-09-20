"""Backend selection, configuration, and the licensing guard.

The registry below is more than a name -> class map: each entry carries the
licensing posture of that backend's weights. That is deliberate. LICENSING.md
has always required that the service refuse to start on a backend whose
weights are not cleared for commercial use — a requirement that was prose
only, and therefore unenforceable, until the metadata lived next to the code
that selects the backend.
"""

from dataclasses import dataclass
from functools import lru_cache

from pydantic_settings import BaseSettings

from app.models.base import FaceModelProvider
from app.models.mock_model import MockEmbeddingModel
from app.models.onnx_provider import OnnxFaceModelProvider
from app.models.opencv_provider import OpenCVFaceModelProvider
from app.schemas import CommercialUseStatus


class BackendNotProductionEligibleError(RuntimeError):
    """Raised at startup when a deployment demands a production-ready model
    but the selected backend's weights are not licence-cleared."""


@dataclass(frozen=True)
class BackendRegistration:
    """One selectable backend plus the facts a deployment must check.

    ``commercial_use`` must match the backend log in models/LICENSING.md.
    Anything other than "permitted" means the backend cannot serve production
    traffic, whether because its weights are research-only, because nobody has
    verified them yet, or because there are no weights at all.
    """

    provider_cls: type[FaceModelProvider]
    commercial_use: CommercialUseStatus
    #: One line on why it has that status, surfaced in the startup error so
    #: the failure explains itself without a trip to the docs.
    licence_note: str


# Adding a real model means adding a FaceModelProvider implementation and one
# entry here — apps/web never changes. Read models/LICENSING.md first.
MODEL_REGISTRY: dict[str, BackendRegistration] = {
    "mock": BackendRegistration(
        provider_cls=MockEmbeddingModel,
        commercial_use="not-applicable",
        licence_note=(
            "Deterministic hash stub. No weights, no licence — and no real "
            "recognition. Development and CI only."
        ),
    ),
    "onnx": BackendRegistration(
        provider_cls=OnnxFaceModelProvider,
        commercial_use="unclear",
        licence_note=(
            "Scaffold only: no weights are bundled and none have been "
            "licence-verified. Requires FACE_MODEL_DIR and a completed "
            "backend-log entry in models/LICENSING.md."
        ),
    ),
    "opencv": BackendRegistration(
        provider_cls=OpenCVFaceModelProvider,
        # Real recognition, and still not production-eligible. The weight
        # licences are permissive (SFace Apache-2.0, YuNet MIT) but the
        # training-data provenance behind the distributed SFace artefact is
        # unresolved for commercial biometric use. Until that is settled by
        # someone qualified to settle it, this stays "unclear" and the guard
        # below keeps it out of production.
        commercial_use="unclear",
        licence_note=(
            "YuNet (MIT) + SFace (Apache-2.0) via OpenCV. The weights' own "
            "licences are permissive, but the SFace training-data provenance "
            "is unresolved for commercial biometric use — see "
            "models/LICENSING.md. Real recognition, local evaluation only."
        ),
    ),
}


class Settings(BaseSettings):
    face_model_backend: str = "mock"

    #: Set true in any environment that serves real institutions. Startup then
    #: fails on a backend whose weights are not licence-cleared, so a
    #: research-only or unverified model cannot reach production by accident.
    face_ai_require_production_model: bool = False

    #: Directory holding the .onnx artefacts for the onnx/opencv backends.
    #:
    #: No default path: a face-recognition service that falls back to a
    #: built-in location is one that can silently load whatever is sitting
    #: there. The backend refuses to start without this, and verifies the
    #: SHA-256 of everything it finds (app/models/model_files.py).
    face_model_dir: str | None = None

    #: YuNet detection tuning. Upstream's published defaults, exposed because a
    #: classroom is not the benchmark they were chosen on. NOT CALIBRATED for
    #: this product — see docs/RECOGNITION_ENGINE.md on threshold calibration.
    face_detector_score_threshold: float = 0.6
    face_detector_nms_threshold: float = 0.3
    face_detector_top_k: int = 5000

    #: Smallest face, in pixels on its shorter side, that may produce an
    #: *enrolment* template. A bad template is permanent and silently degrades
    #: every future match, so enrolment is gated where detection is not.
    #: Conservative and configurable rather than tuned; no classroom data
    #: exists to tune it against.
    face_min_enrolment_face_pixels: int = 24

    #: ONNX Runtime execution providers, highest priority first, comma
    #: separated. CPU-only deployments need no change; a GPU deployment sets
    #: "CUDAExecutionProvider,CPUExecutionProvider" and nothing else moves.
    face_model_execution_providers: str = "CPUExecutionProvider"

    #: 0 lets ONNX Runtime choose. Pin it when several workers share a host,
    #: otherwise each session grabs every core and they fight.
    face_model_intra_op_threads: int = 0

    #: Shared secret the caller must present as ``Authorization: Bearer <token>``
    #: on every inference endpoint.
    #:
    #: This service turns a photograph into a 512-float biometric template. An
    #: unauthenticated ``/v1/enroll`` is an oracle that converts anybody's face
    #: into the exact value stored against a student, so reachability is the
    #: whole of the access control unless something checks a credential. It is
    #: the *service* that must check it: "internal network only" is a property
    #: of a deployment, not of this process, and a deployment that turns out to
    #: be wrong about its own network fails open.
    #:
    #: Unset is allowed so `uvicorn app.main:app` still starts for local
    #: development, and it warns on every boot. Set FACE_AI_REQUIRE_AUTH in any
    #: environment that holds real faces to turn that warning into a refusal.
    face_ai_auth_token: str | None = None

    #: Refuse to start without ``face_ai_auth_token``. The counterpart of
    #: ``face_ai_require_production_model``: the two questions a deployment must
    #: answer out loud are "may these weights be used?" and "who may call this?".
    face_ai_require_auth: bool = False

    #: Largest accepted ``imageBase64`` string, in characters. Base64 costs 4
    #: characters per 3 bytes, so 8 MiB of text is ~6 MiB of image — the same
    #: ceiling apps/web enforces on its own upload paths, kept here as well
    #: because this service must not depend on its caller to bound it.
    face_ai_max_image_base64_chars: int = 8 * 1024 * 1024

    #: Largest accepted ``images`` array on ``/v1/detect-embed``. Matches the
    #: three-capture classroom wizard.
    face_ai_max_images_per_request: int = 3

    #: Largest accepted ``candidates`` array on ``/v1/match``. A classroom pool;
    #: an unbounded list is a way to make one request cost minutes of CPU.
    face_ai_max_match_candidates: int = 2000

    @property
    def execution_provider_list(self) -> list[str]:
        return [
            p.strip()
            for p in self.face_model_execution_providers.split(",")
            if p.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()


def build_provider(settings: Settings) -> FaceModelProvider:
    """Resolve, licence-check and construct the configured backend.

    Does not call ``load()`` — the lifespan handler owns that, so that the
    cost and the failure modes of acquiring weights belong to startup.
    """
    registration = MODEL_REGISTRY.get(settings.face_model_backend)
    if registration is None:
        available = ", ".join(sorted(MODEL_REGISTRY))
        raise ValueError(
            f"Unknown FACE_MODEL_BACKEND '{settings.face_model_backend}'. "
            f"Available backends: {available}"
        )

    if (
        settings.face_ai_require_production_model
        and registration.commercial_use != "permitted"
    ):
        raise BackendNotProductionEligibleError(
            f"FACE_AI_REQUIRE_PRODUCTION_MODEL is set, but backend "
            f"'{settings.face_model_backend}' has commercial-use status "
            f"'{registration.commercial_use}'. {registration.licence_note} "
            f"Refusing to start. Record a verified, commercial-use-permitted "
            f"weights licence in services/face-ai/app/models/LICENSING.md and "
            f"set commercial_use='permitted' on its registry entry first."
        )

    if registration.provider_cls is OnnxFaceModelProvider:
        return OnnxFaceModelProvider(
            model_dir=settings.face_model_dir,
            execution_providers=settings.execution_provider_list,
            intra_op_num_threads=settings.face_model_intra_op_threads,
        )
    if registration.provider_cls is OpenCVFaceModelProvider:
        return OpenCVFaceModelProvider(
            model_dir=settings.face_model_dir,
            score_threshold=settings.face_detector_score_threshold,
            nms_threshold=settings.face_detector_nms_threshold,
            top_k=settings.face_detector_top_k,
            min_face_pixels=settings.face_min_enrolment_face_pixels,
        )
    return registration.provider_cls()


@lru_cache
def get_model() -> FaceModelProvider:
    """FastAPI dependency returning the loaded provider.

    Still memoised, so a request never pays for loading. The lifespan handler
    primes this cache at startup; the lazy path here is a safety net for
    tests and for direct ASGI use without the lifespan.
    """
    settings = get_settings()
    provider = build_provider(settings)
    provider.load()
    return provider


def reset_model_cache() -> None:
    """Drop memoised settings and provider. For tests that vary the env."""
    get_model.cache_clear()
    get_settings.cache_clear()
