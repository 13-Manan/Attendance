"""Raw benchmark artefacts: what the model did, before any decision.

The deliberate separation in this harness is that `runner` records
similarities and timings and *nothing else* — no MATCHED/UNCERTAIN verdicts,
no present/absent calls. Those are threshold-dependent, and the point of the
benchmark is to choose the thresholds. Storing raw scores means a threshold
sweep is a re-analysis, not a re-run: minutes of inference buy an unlimited
number of operating points.

These structures serialise to JSON so a run can be committed, shared, or
compared against a later model version.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class RawFaceObservation:
    """One detected face and its similarity to every candidate in the class.

    ``similarities`` is keyed by studentId and contains ONLY students enrolled
    in this capture's cohort — the class-scoped search requirement is baked
    into the artefact, so a benchmark physically cannot report a score against
    a student from another class.
    """

    sequence_number: int
    face_index: int
    detection_confidence: float
    quality_score: float | None
    similarities: dict[str, float] = field(default_factory=dict)

    @property
    def detected_face_id(self) -> str:
        return f"{self.sequence_number}:{self.face_index}"


@dataclass
class RawImageResult:
    sequence_number: int
    detected_face_count: int
    expected_face_count: int
    inference_ms: float


@dataclass
class RawCaptureResult:
    capture_id: str
    cohort_id: str
    cohort_size: int
    conditions: dict[str, str]
    cohort_student_ids: list[str]
    truly_present_student_ids: list[str]
    images: list[RawImageResult] = field(default_factory=list)
    faces: list[RawFaceObservation] = field(default_factory=list)
    total_ms: float = 0.0
    #: Populated when the capture could not be processed at all. Kept in the
    #: results rather than dropped: an image the pipeline crashes on is a
    #: real-world failure mode and belongs in the error rate.
    error: str | None = None

    @property
    def expected_face_instances(self) -> int:
        return sum(i.expected_face_count for i in self.images)

    @property
    def detected_face_instances(self) -> int:
        return sum(i.detected_face_count for i in self.images)


@dataclass
class RawBenchmarkRun:
    dataset_id: str
    generated_at: str
    model_name: str
    model_version: str
    production_eligible: bool
    commercial_use: str
    runtime: str
    gallery_template_count: int
    captures: list[RawCaptureResult] = field(default_factory=list)
    #: Conditions the dataset never exercised, copied from the coverage check
    #: so the gap travels with the numbers.
    coverage_gaps: list[dict[str, Any]] = field(default_factory=list)
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> RawBenchmarkRun:
        captures = [
            RawCaptureResult(
                **{
                    **c,
                    "images": [RawImageResult(**i) for i in c.get("images", [])],
                    "faces": [RawFaceObservation(**f) for f in c.get("faces", [])],
                }
            )
            for c in data.get("captures", [])
        ]
        return RawBenchmarkRun(
            **{**data, "captures": captures},
        )
