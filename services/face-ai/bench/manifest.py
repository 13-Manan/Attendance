"""Benchmark dataset description, loading and validation.

A benchmark is only repeatable if the dataset is described in a file rather
than in someone's memory of how they shot it. The manifest carries both the
data and the *conditions* — distance, lighting, eyewear, occlusion, angle,
camera — because a single aggregate accuracy number is nearly useless for
deciding whether a system is deployable. "94% overall" hides "61% in the back
row under dim light", and the back row is exactly where attendance fraud and
attendance complaints come from.

Ground truth is recorded per image (`visibleStudentIds`) as well as per
capture (the union). Per-image truth is what makes detection rate meaningful
and what lets the harness verify the multi-photo deduplication requirement:
a student visible in image 1 and image 2 must still be counted once.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, get_args

# --------------------------------------------------------------------------
# Condition vocabulary
#
# Closed literals rather than free strings: the whole point of recording
# conditions is to slice results by them, and free strings turn "dim",
# "low-light" and "Dim" into three separate buckets with four samples each.
# --------------------------------------------------------------------------

Distance = Literal["near", "mid", "far"]
Lighting = Literal["bright", "normal", "dim", "backlit", "mixed"]
Eyewear = Literal["none", "some", "all"]
Occlusion = Literal["none", "partial", "heavy"]
Angle = Literal["frontal", "slight", "side"]

CONDITION_FIELDS = ("distance", "lighting", "eyewear", "occlusion", "angle", "camera")


@dataclass(frozen=True)
class CaptureConditions:
    """How one classroom capture was shot.

    ``camera`` is a free string on purpose — it is device provenance
    ("pixel-7a", "logitech-c920", "lenovo-builtin-720p"), not a category the
    harness reasons about, and enumerating every device a college owns would
    be a losing game. It is still recorded so a bad result can be traced to
    one bad webcam instead of blamed on the model.
    """

    distance: Distance
    lighting: Lighting
    eyewear: Eyewear = "none"
    occlusion: Occlusion = "none"
    angle: Angle = "frontal"
    camera: str = "unspecified"

    def as_dict(self) -> dict[str, str]:
        return {f: getattr(self, f) for f in CONDITION_FIELDS}


@dataclass(frozen=True)
class BenchStudent:
    student_id: str
    #: Paths (relative to the manifest) of the enrolment photos. These build
    #: the gallery; they must NEVER also appear as capture images, or the
    #: benchmark measures memorisation instead of recognition.
    enrollment_images: tuple[str, ...]


@dataclass(frozen=True)
class BenchCohort:
    cohort_id: str
    label: str
    students: tuple[BenchStudent, ...]

    @property
    def size(self) -> int:
        return len(self.students)

    @property
    def student_ids(self) -> tuple[str, ...]:
        return tuple(s.student_id for s in self.students)


@dataclass(frozen=True)
class BenchImage:
    sequence_number: int
    path: str
    #: Students genuinely visible in THIS frame. A student in the room but
    #: hidden behind someone else is not visible, and counting them as a
    #: missed detection would punish the detector for physics.
    visible_student_ids: tuple[str, ...]


@dataclass(frozen=True)
class BenchCapture:
    capture_id: str
    cohort_id: str
    conditions: CaptureConditions
    images: tuple[BenchImage, ...]

    @property
    def present_student_ids(self) -> frozenset[str]:
        """Union across images — who the attendance answer should say is
        present, regardless of which frame caught them."""
        return frozenset(sid for img in self.images for sid in img.visible_student_ids)

    @property
    def expected_face_instances(self) -> int:
        """Total face appearances the detector should find across all images
        of this capture. The denominator of detection rate."""
        return sum(len(img.visible_student_ids) for img in self.images)


@dataclass(frozen=True)
class BenchManifest:
    dataset_id: str
    description: str
    root: Path
    cohorts: tuple[BenchCohort, ...]
    captures: tuple[BenchCapture, ...]
    notes: str = ""

    def cohort(self, cohort_id: str) -> BenchCohort:
        for c in self.cohorts:
            if c.cohort_id == cohort_id:
                return c
        raise KeyError(f"Unknown cohortId '{cohort_id}'")

    def resolve(self, relative_path: str) -> Path:
        return (self.root / relative_path).resolve()


class ManifestError(ValueError):
    """Raised for a structurally invalid manifest.

    Every message names the offending id. A benchmark that silently skips a
    malformed capture reports a better number than the system deserves.
    """


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def _literal(value: object, allowed: object, field_name: str, where: str) -> str:
    options = get_args(allowed)
    if value not in options:
        raise ManifestError(
            f"{where}: {field_name}={value!r} is not one of {sorted(options)}"
        )
    return str(value)


def _conditions_from(raw: dict, where: str) -> CaptureConditions:
    return CaptureConditions(
        distance=_literal(raw.get("distance", "mid"), Distance, "distance", where),  # type: ignore[arg-type]
        lighting=_literal(raw.get("lighting", "normal"), Lighting, "lighting", where),  # type: ignore[arg-type]
        eyewear=_literal(raw.get("eyewear", "none"), Eyewear, "eyewear", where),  # type: ignore[arg-type]
        occlusion=_literal(raw.get("occlusion", "none"), Occlusion, "occlusion", where),  # type: ignore[arg-type]
        angle=_literal(raw.get("angle", "frontal"), Angle, "angle", where),  # type: ignore[arg-type]
        camera=str(raw.get("camera", "unspecified")),
    )


def load_manifest(path: str | Path) -> BenchManifest:
    """Parse and fully validate a manifest file."""
    manifest_path = Path(path).resolve()
    raw = json.loads(manifest_path.read_text())
    return parse_manifest(raw, root=manifest_path.parent)


def parse_manifest(raw: dict, root: Path) -> BenchManifest:
    cohorts: list[BenchCohort] = []
    for c in raw.get("cohorts", []):
        cohort_id = str(c["cohortId"])
        students = tuple(
            BenchStudent(
                student_id=str(s["studentId"]),
                enrollment_images=tuple(str(p) for p in s.get("enrollmentImages", [])),
            )
            for s in c.get("students", [])
        )
        if not students:
            raise ManifestError(f"cohort '{cohort_id}' has no students")
        seen: set[str] = set()
        for s in students:
            if s.student_id in seen:
                raise ManifestError(
                    f"cohort '{cohort_id}' lists studentId '{s.student_id}' twice"
                )
            seen.add(s.student_id)
            if not s.enrollment_images:
                raise ManifestError(
                    f"cohort '{cohort_id}' student '{s.student_id}' has no "
                    "enrollmentImages — it could never be recognised, which "
                    "would be scored as a model failure"
                )
        cohorts.append(
            BenchCohort(
                cohort_id=cohort_id,
                label=str(c.get("label", cohort_id)),
                students=students,
            )
        )

    if not cohorts:
        raise ManifestError("manifest defines no cohorts")
    cohort_by_id = {c.cohort_id: c for c in cohorts}

    captures: list[BenchCapture] = []
    for cap in raw.get("captures", []):
        capture_id = str(cap["captureId"])
        where = f"capture '{capture_id}'"
        cohort_id = str(cap["cohortId"])
        cohort = cohort_by_id.get(cohort_id)
        if cohort is None:
            raise ManifestError(f"{where}: unknown cohortId '{cohort_id}'")

        images_raw = cap.get("images", [])
        if not 1 <= len(images_raw) <= 3:
            raise ManifestError(
                f"{where}: has {len(images_raw)} images; the capture UI allows 1-3"
            )
        images: list[BenchImage] = []
        for img in images_raw:
            seq = int(img["sequenceNumber"])
            if seq not in (1, 2, 3):
                raise ManifestError(f"{where}: sequenceNumber {seq} is not 1, 2 or 3")
            visible = tuple(str(s) for s in img.get("visibleStudentIds", []))
            unknown = set(visible) - set(cohort.student_ids)
            if unknown:
                raise ManifestError(
                    f"{where} image {seq}: visibleStudentIds {sorted(unknown)} are "
                    f"not enrolled in cohort '{cohort_id}'. A benchmark cannot "
                    "expect a class-scoped search to find someone outside the class."
                )
            images.append(
                BenchImage(
                    sequence_number=seq,
                    path=str(img["path"]),
                    visible_student_ids=visible,
                )
            )

        seqs = [i.sequence_number for i in images]
        if len(set(seqs)) != len(seqs):
            raise ManifestError(f"{where}: duplicate sequenceNumber in images")

        captures.append(
            BenchCapture(
                capture_id=capture_id,
                cohort_id=cohort_id,
                conditions=_conditions_from(cap.get("conditions", {}), where),
                images=tuple(sorted(images, key=lambda i: i.sequence_number)),
            )
        )

    if not captures:
        raise ManifestError("manifest defines no captures")

    capture_ids = [c.capture_id for c in captures]
    if len(set(capture_ids)) != len(capture_ids):
        raise ManifestError("duplicate captureId in manifest")

    return BenchManifest(
        dataset_id=str(raw.get("datasetId", manifest_default_id(root))),
        description=str(raw.get("description", "")),
        root=root,
        cohorts=tuple(cohorts),
        captures=tuple(captures),
        notes=str(raw.get("notes", "")),
    )


def manifest_default_id(root: Path) -> str:
    return root.name or "benchmark"


# --------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------


@dataclass
class CoverageGap:
    dimension: str
    missing: tuple[str, ...]


# 100 was added in the performance phase. The first three sizes answer "does
# accuracy degrade as the class grows"; 100 is there because a lecture hall is
# a real deployment target and because the candidate-scan measurements in
# `bench/perf.py` show the cost is linear in class size — a claim that needs a
# cohort at the top of the range to be worth anything.
REQUIRED_COHORT_SIZES = (10, 20, 50, 100)


@dataclass
class CoverageReport:
    """What the Phase 5 spec asks a benchmark to cover, versus what this
    dataset actually contains.

    Reported rather than enforced: a partial dataset is still worth measuring,
    but the report must say out loud which conditions were never tested so
    nobody reads "97% accuracy" as "97% accuracy everywhere".
    """

    cohort_sizes: tuple[int, ...]
    gaps: list[CoverageGap] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.gaps


def assess_coverage(manifest: BenchManifest) -> CoverageReport:
    sizes = tuple(sorted({c.size for c in manifest.cohorts}))
    gaps: list[CoverageGap] = []

    missing_sizes = [
        str(n)
        for n in REQUIRED_COHORT_SIZES
        # +/-20% tolerance: a real class of 48 satisfies "50 students".
        if not any(abs(s - n) <= max(1, n * 0.2) for s in sizes)
    ]
    if missing_sizes:
        gaps.append(CoverageGap("cohortSize", tuple(missing_sizes)))

    for dimension, allowed in (
        ("distance", Distance),
        ("lighting", Lighting),
        ("eyewear", Eyewear),
        ("occlusion", Occlusion),
        ("angle", Angle),
    ):
        seen = {getattr(c.conditions, dimension) for c in manifest.captures}
        missing = tuple(sorted(set(get_args(allowed)) - seen))
        if missing:
            gaps.append(CoverageGap(dimension, missing))

    cameras = {c.conditions.camera for c in manifest.captures}
    if len(cameras) < 2:
        gaps.append(CoverageGap("camera", ("at least 2 distinct cameras",)))

    if not any(len(c.images) > 1 for c in manifest.captures):
        gaps.append(CoverageGap("multiPhoto", ("no capture uses more than one image",)))

    return CoverageReport(cohort_sizes=sizes, gaps=gaps)
