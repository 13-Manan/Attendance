"""Execute a model over a benchmark dataset and record raw observations.

The runner makes no decisions. It builds a gallery from the enrolment images,
runs every capture through detect+embed, scores each detected face against
*only that capture's cohort*, and writes the similarities down. Whether a
given similarity means "present" is `metrics.py`'s problem, at whatever
threshold you ask it about.

Two clients are supported. The in-process client loads the configured backend
directly and is what you want for threshold work: it is faster and removes
HTTP from the latency numbers. The HTTP client exercises the real deployed
service including serialisation and the network, which is what you want when
the question is "how long does a classroom capture actually take?".
"""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from app.config import Settings, build_provider
from app.matching import cosine_similarity
from app.models.base import FaceModelProvider
from app.schemas import DetectedFace, FaceModelInfo, SessionImageInput
from bench.manifest import BenchCapture, BenchCohort, BenchManifest, assess_coverage
from bench.results import (
    RawBenchmarkRun,
    RawCaptureResult,
    RawFaceObservation,
    RawImageResult,
)


class BenchModelClient(Protocol):
    """The slice of the face-AI surface a benchmark needs."""

    def model_info(self) -> FaceModelInfo: ...

    def embed(self, image_base64: str) -> list[float]: ...

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]: ...


class InProcessClient:
    """Calls the configured provider directly — no FastAPI, no HTTP."""

    def __init__(self, provider: FaceModelProvider) -> None:
        self._provider = provider

    @staticmethod
    def from_settings(settings: Settings | None = None) -> InProcessClient:
        resolved = settings or Settings()
        provider = build_provider(resolved)
        provider.load()
        return InProcessClient(provider)

    def model_info(self) -> FaceModelInfo:
        return self._provider.model_info()

    def embed(self, image_base64: str) -> list[float]:
        return self._provider.embed(image_base64)

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        return self._provider.detect_and_embed(image)


class HttpClient:
    """Drives a running face-ai service over its published v1 contract.

    Uses the same endpoints apps/web uses, so a latency figure from this
    client is a figure a classroom would actually experience.
    """

    def __init__(self, base_url: str, timeout_s: float = 120.0) -> None:
        import httpx

        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout_s)

    def close(self) -> None:
        self._client.close()

    def model_info(self) -> FaceModelInfo:
        response = self._client.get("/v1/model-info")
        response.raise_for_status()
        return FaceModelInfo.model_validate(response.json())

    def embed(self, image_base64: str) -> list[float]:
        response = self._client.post("/v1/embed", json={"imageBase64": image_base64})
        response.raise_for_status()
        return list(response.json()["embedding"])

    def detect_and_embed(self, image: SessionImageInput) -> list[DetectedFace]:
        response = self._client.post(
            "/v1/detect-embed",
            json={
                "sessionId": "benchmark",
                "images": [
                    {
                        "sequenceNumber": image.sequence_number,
                        "imageBase64": image.image_base64,
                    }
                ],
            },
        )
        response.raise_for_status()
        return [DetectedFace.model_validate(f) for f in response.json()["faces"]]


# --------------------------------------------------------------------------
# Gallery
# --------------------------------------------------------------------------


@dataclass
class Gallery:
    """Enrolment templates for one cohort, keyed by studentId.

    A student may have several templates, exactly as `FaceEmbedding` allows
    several active rows per student. A face's similarity to a student is the
    best of that student's templates — averaging them would blur two genuinely
    different appearances (with and without glasses, say) into a vector that
    resembles neither.
    """

    templates: dict[str, list[list[float]]]

    @property
    def template_count(self) -> int:
        return sum(len(v) for v in self.templates.values())

    def score(self, probe: list[float], embedding_dim: int) -> dict[str, float]:
        scores: dict[str, float] = {}
        for student_id, vectors in self.templates.items():
            best: float | None = None
            for vector in vectors:
                if len(vector) != embedding_dim:
                    continue
                similarity = cosine_similarity(probe, vector)
                if best is None or similarity > best:
                    best = similarity
            if best is not None:
                scores[student_id] = best
        return scores


def _read_base64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def build_gallery(
    manifest: BenchManifest, cohort: BenchCohort, client: BenchModelClient
) -> Gallery:
    templates: dict[str, list[list[float]]] = {}
    for student in cohort.students:
        vectors: list[list[float]] = []
        for relative in student.enrollment_images:
            image_path = manifest.resolve(relative)
            if not image_path.exists():
                raise FileNotFoundError(
                    f"enrolment image missing for {student.student_id}: {image_path}"
                )
            vectors.append(client.embed(_read_base64(image_path)))
        templates[student.student_id] = vectors
    return Gallery(templates=templates)


# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------


def run_capture(
    manifest: BenchManifest,
    capture: BenchCapture,
    cohort: BenchCohort,
    gallery: Gallery,
    client: BenchModelClient,
    embedding_dim: int,
) -> RawCaptureResult:
    result = RawCaptureResult(
        capture_id=capture.capture_id,
        cohort_id=capture.cohort_id,
        cohort_size=cohort.size,
        conditions=capture.conditions.as_dict(),
        cohort_student_ids=list(cohort.student_ids),
        truly_present_student_ids=sorted(capture.present_student_ids),
    )

    capture_started = time.perf_counter()
    for image in capture.images:
        image_path = manifest.resolve(image.path)
        try:
            payload = SessionImageInput(
                sequenceNumber=image.sequence_number,
                imageBase64=_read_base64(image_path),
            )
            started = time.perf_counter()
            faces = client.detect_and_embed(payload)
            inference_ms = (time.perf_counter() - started) * 1000
        except Exception as exc:
            # Recorded, not raised: an image the pipeline cannot process is a
            # real failure mode with a real attendance consequence, and a
            # harness that aborts on it reports nothing at all.
            result.error = f"{type(exc).__name__}: {exc}"
            result.total_ms = (time.perf_counter() - capture_started) * 1000
            return result

        result.images.append(
            RawImageResult(
                sequence_number=image.sequence_number,
                detected_face_count=len(faces),
                expected_face_count=len(image.visible_student_ids),
                inference_ms=inference_ms,
            )
        )
        for index, face in enumerate(faces):
            result.faces.append(
                RawFaceObservation(
                    sequence_number=image.sequence_number,
                    face_index=index,
                    detection_confidence=face.detection_confidence,
                    quality_score=face.quality_score,
                    # Class-scoped by construction: the gallery holds only
                    # this cohort's templates.
                    similarities=gallery.score(face.embedding, embedding_dim),
                )
            )

    result.total_ms = (time.perf_counter() - capture_started) * 1000
    return result


def run_benchmark(manifest: BenchManifest, client: BenchModelClient) -> RawBenchmarkRun:
    info = client.model_info()
    coverage = assess_coverage(manifest)

    galleries: dict[str, Gallery] = {
        cohort.cohort_id: build_gallery(manifest, cohort, client)
        for cohort in manifest.cohorts
    }

    captures = [
        run_capture(
            manifest,
            capture,
            manifest.cohort(capture.cohort_id),
            galleries[capture.cohort_id],
            client,
            info.embedding_dim,
        )
        for capture in manifest.captures
    ]

    return RawBenchmarkRun(
        dataset_id=manifest.dataset_id,
        generated_at=datetime.now(UTC).isoformat(),
        model_name=info.model_name,
        model_version=info.model_version,
        production_eligible=info.production_eligible,
        commercial_use=info.commercial_use,
        runtime=info.runtime,
        gallery_template_count=sum(g.template_count for g in galleries.values()),
        captures=captures,
        coverage_gaps=[
            {"dimension": gap.dimension, "missing": list(gap.missing)}
            for gap in coverage.gaps
        ],
        notes=manifest.notes,
    )
