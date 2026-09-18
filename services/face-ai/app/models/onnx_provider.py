"""ONNX Runtime backend — the shape a real recogniser plugs into.

This adapter is deliberately shipped WITHOUT model weights. It refuses to
load unless a licensed model directory is configured, and it is never the
default backend. Its job in this phase is twofold:

  1. Prove the ``FaceModelProvider`` abstraction can carry a real, two-network
     ONNX pipeline — not just the mock. Everything provider-specific that a
     real integration needs (execution providers, session options, letterbox
     scaling, the alignment template, channel order, mean/std) lives inside
     this file and touches nothing else in the repo.
  2. Encode the integration decisions now, while the reference material is in
     front of us, so Phase 5 is an implementation task rather than a research
     task.

Runtime layering, which matters for how this is read:

    ONNX Runtime = the inference engine. It is not a face-recognition
    algorithm. It loads a graph and runs tensors through it, with a choice of
    execution provider (CPU, CUDA, CoreML, ...). Swapping CPU for GPU is a
    provider-list change here, not an architectural change anywhere.

    The face model = the actual recogniser (a detector network plus a
    recognition network). Which networks, and under what licence, is an open
    question tracked in LICENSING.md — and is exactly why this file does not
    bundle any.

Pipeline a real implementation runs, in order:

    decode -> letterbox to detector input -> detector session.run
           -> boxes + 5-point landmarks, rescaled to original pixels
           -> similarity transform onto a fixed template (112x112)
           -> normalise (channel order, mean/std) -> recogniser session.run
           -> L2-normalise -> 512-d embedding

Two details from that sequence are easy to get wrong and expensive to
discover later, so they are stated explicitly:

  * Recognition networks of the ArcFace family do NOT emit unit-length
    vectors. Cosine similarity divides by the norms at comparison time, which
    hides this. Our contract requires L2-normalised embeddings, so the
    adapter must normalise before returning — otherwise vectors stored in
    pgvector are only comparable under cosine distance and silently wrong
    under inner-product or L2 distance.
  * Alignment is not cosmetic. The recogniser is trained on faces warped onto
    a fixed five-point template; feeding it an unaligned box crop degrades
    accuracy sharply. This is why the contract carries landmarks at all.
"""

from __future__ import annotations

from app.models.base import AlignedFace, DetectionResult, FaceModelProvider
from app.schemas import (
    BoundingBox,
    DetectedFace,
    FaceLandmarks,
    FaceQualityAssessment,
    SessionImageInput,
)


class ModelWeightsNotConfiguredError(RuntimeError):
    """Raised at load() when no licensed weights have been supplied.

    Deliberately raised during startup rather than on first request: a
    misconfigured deployment must fail its health check, not fail a student
    mid-enrolment.
    """


class OnnxFaceModelProvider(FaceModelProvider):
    """Scaffold for a real ONNX-backed recogniser.

    Not registered as a default backend and not usable without weights. It is
    registered in the model registry only so the licensing guard and the
    provider-swap path can be exercised against something other than the mock.
    """

    name = "onnx"
    # Both remain placeholders until a specific, licence-verified weights
    # release is chosen. "latest" is never an acceptable value here — the
    # whole point of recording a version is to be able to identify, years
    # later, which artefact produced a given stored template.
    weights_version = "unconfigured"
    preprocessing_version = "1"
    runtime = "onnxruntime"
    # Until a specific weights release is chosen AND its licence verified,
    # this must stay "unclear". config.py refuses production traffic on it.
    commercial_use = "unclear"

    def __init__(
        self,
        model_dir: str | None = None,
        execution_providers: list[str] | None = None,
        intra_op_num_threads: int = 0,
    ) -> None:
        self._model_dir = model_dir
        # Execution providers are tried in priority order; the CPU provider is
        # the universal fallback and should stay last. ONNX Runtime requires
        # this list to be explicit rather than inferring a device.
        self._execution_providers = execution_providers or ["CPUExecutionProvider"]
        self._intra_op_num_threads = intra_op_num_threads
        self._detector = None
        self._recogniser = None

    def load(self) -> None:
        """Build the inference sessions once, at application startup.

        Session construction is the expensive part — graph parsing,
        optimisation and provider initialisation — so it must not happen per
        request. Doing it here also means a missing file, an unavailable
        execution provider or a corrupt graph surfaces as a failed startup.
        """
        if not self._model_dir:
            raise ModelWeightsNotConfiguredError(
                "The 'onnx' backend has no model directory configured. Set "
                "FACE_MODEL_DIR to a directory containing licence-verified "
                "detector and recogniser .onnx files, and record the licence "
                "in services/face-ai/app/models/LICENSING.md before using "
                "this backend for anything beyond local evaluation."
            )

        # Imported lazily so the service starts on machines that have not
        # installed onnxruntime and are only ever running the mock backend.
        import onnxruntime as ort  # noqa: F401  (used once weights exist)

        # A real implementation continues here:
        #
        #   options = ort.SessionOptions()
        #   options.graph_optimization_level = (
        #       ort.GraphOptimizationLevel.ORT_ENABLE_ALL)
        #   options.intra_op_num_threads = self._intra_op_num_threads
        #   self._detector = ort.InferenceSession(
        #       f"{self._model_dir}/detector.onnx",
        #       sess_options=options,
        #       providers=self._execution_providers)
        #   self._recogniser = ort.InferenceSession(
        #       f"{self._model_dir}/recogniser.onnx",
        #       sess_options=options,
        #       providers=self._execution_providers)
        #   self._warmup()   # first run() pays lazy allocation; do it here
        #
        # It is left unwritten rather than half-written because the concrete
        # input names, shapes and normalisation constants are properties of
        # the specific weights, which have not been chosen.
        raise ModelWeightsNotConfiguredError(
            "The 'onnx' backend is a scaffold: no licence-verified weights "
            "have been selected yet. See docs/FACE_AI_ARCHITECTURE.md."
        )

    def unload(self) -> None:
        self._detector = None
        self._recogniser = None

    # -- pipeline stages ----------------------------------------------------
    #
    # Each raises rather than returning a plausible-looking empty result: a
    # backend that cannot run must fail loudly, never quietly report "no
    # faces found" and let an attendance session record everyone absent.

    def detect(self, image_base64: str) -> DetectionResult:
        raise ModelWeightsNotConfiguredError("onnx backend not configured")

    def assess_quality(self, image_base64: str) -> FaceQualityAssessment:
        raise ModelWeightsNotConfiguredError("onnx backend not configured")

    def align(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None,
        landmarks: FaceLandmarks | None,
    ) -> AlignedFace:
        raise ModelWeightsNotConfiguredError("onnx backend not configured")

    def embed(
        self,
        image_base64: str,
        bounding_box: BoundingBox | None = None,
        landmarks: FaceLandmarks | None = None,
    ) -> list[float]:
        raise ModelWeightsNotConfiguredError("onnx backend not configured")

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        raise ModelWeightsNotConfiguredError("onnx backend not configured")
