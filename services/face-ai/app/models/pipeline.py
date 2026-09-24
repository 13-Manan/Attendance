"""The stages a face-recognition backend is built from.

``FaceModelProvider`` (base.py) is what the routers call. This module is what a
*real* provider is assembled from:

    FaceDetector  ->  FaceAligner  ->  FaceEmbedder      (FaceMatcher: matching.py)

Each stage is its own object with its own identity, so that swapping one — a
better detector in front of the same recogniser, say — is a change to one
class, and so that a test can stand a fake stage in for a real one without any
model weights on disk.

## Why every stage carries a descriptor

A stored template is only comparable with templates produced by the *same*
detector landmarks, the *same* alignment and the *same* embedder. The
composite ``modelVersion`` string is what the database records, but an
operator deciding whether a backend can go to production needs more than a
string: which assets does it load, what licence covers each of them, what can
it do (landmarks? batching?), and is each part cleared for commercial use.
``StageDescriptor`` answers those per stage, and ``/v1/model-info`` returns all
of them.

The provider is production-eligible only when *every* stage is. One unapproved
stage — a permissively licensed embedder behind a detector trained on
non-commercial data — makes the whole pipeline unapproved.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

import numpy as np

from app.schemas import (
    BoundingBox,
    CommercialUseStatus,
    FaceLandmarks,
    PipelineStageInfo,
)

StageRole = Literal["detector", "aligner", "embedder", "matcher"]

#: What a stage can do, as a closed vocabulary so callers can test for it.
#:
#: - ``landmarks5``: the detector emits five-point landmarks, so alignment is
#:   possible.
#: - ``similarity_transform``: the aligner warps onto a fixed template rather
#:   than cropping a box.
#: - ``batch``: the embedder takes many crops in one inference call.
#: - ``cosine``: the matcher compares L2-normalised vectors by cosine
#:   similarity.
StageCapability = Literal["landmarks5", "similarity_transform", "batch", "cosine"]


@dataclass(frozen=True)
class StageDescriptor:
    """Identity and provenance of one pipeline stage."""

    role: StageRole
    name: str
    version: str
    runtime: str
    commercial_use: CommercialUseStatus
    capabilities: frozenset[StageCapability] = frozenset()
    #: Files this stage loads, by name. Empty for a stage with no weights.
    required_assets: tuple[str, ...] = ()
    #: Only meaningful for an embedder.
    embedding_dim: int | None = None
    #: One line on why the stage has its ``commercial_use`` status.
    licence_note: str = ""

    @property
    def production_ready(self) -> bool:
        return self.commercial_use == "permitted"

    def to_info(self) -> PipelineStageInfo:
        return PipelineStageInfo(
            role=self.role,
            name=self.name,
            version=self.version,
            runtime=self.runtime,
            commercialUse=self.commercial_use,
            productionReady=self.production_ready,
            capabilities=sorted(self.capabilities),
            requiredAssets=list(self.required_assets),
            embeddingDim=self.embedding_dim,
            licenceNote=self.licence_note or None,
        )


#: The matcher is not a model and has no weights, but it is a stage: every
#: similarity this system reports came out of it, and changing it (to L2
#: distance, or a learned metric) would invalidate every threshold. Named here
#: so model-info can say so.
COSINE_MATCHER = StageDescriptor(
    role="matcher",
    name="cosine",
    version="1",
    runtime="numpy",
    commercial_use="not-applicable",
    capabilities=frozenset({"cosine"}),
    licence_note="Plain arithmetic; no weights.",
)


@dataclass(frozen=True)
class RawDetection:
    """One face as the detector found it, in pixels of the decoded frame."""

    box: BoundingBox
    score: float
    landmarks: FaceLandmarks | None = None


@dataclass
class AlignedCrop:
    """A face ready to embed, and whether it was genuinely aligned."""

    crop: np.ndarray
    aligned: bool


@runtime_checkable
class FaceDetector(Protocol):
    descriptor: StageDescriptor

    def load(self) -> None: ...

    def detect_frame(self, frame: np.ndarray) -> list[RawDetection]:
        """Every face in a decoded BGR frame, strongest first."""
        ...


@runtime_checkable
class FaceAligner(Protocol):
    descriptor: StageDescriptor
    #: Side length of the square crop this aligner emits.
    output_size: int

    def load(self) -> None: ...

    def align_frame(
        self,
        frame: np.ndarray,
        box: BoundingBox,
        landmarks: FaceLandmarks | None,
    ) -> AlignedCrop: ...


@runtime_checkable
class FaceEmbedder(Protocol):
    descriptor: StageDescriptor

    def load(self) -> None: ...

    def embed_crops(self, crops: list[np.ndarray]) -> np.ndarray:
        """``[len(crops), embedding_dim]`` raw (not yet normalised) vectors.

        One call for every crop, so a backend that can batch does. An empty
        list returns an empty ``[0, embedding_dim]`` array.
        """
        ...


@dataclass
class PipelineTimings:
    """Wall-clock milliseconds spent in each stage for one request.

    Returned on the wire so latency can be measured from the caller's side
    without a profiler — and because "the register took eight seconds" is a
    question somebody will ask, and the answer is usually one stage.
    """

    decode_ms: float = 0.0
    detect_ms: float = 0.0
    align_ms: float = 0.0
    quality_ms: float = 0.0
    embed_ms: float = 0.0

    def add(self, other: PipelineTimings) -> None:
        self.decode_ms += other.decode_ms
        self.detect_ms += other.detect_ms
        self.align_ms += other.align_ms
        self.quality_ms += other.quality_ms
        self.embed_ms += other.embed_ms


@dataclass
class StageSet:
    """The stages a composed provider runs, in order."""

    detector: FaceDetector
    aligner: FaceAligner
    embedder: FaceEmbedder
    extra: tuple[StageDescriptor, ...] = field(default=(COSINE_MATCHER,))

    def descriptors(self) -> tuple[StageDescriptor, ...]:
        return (
            self.detector.descriptor,
            self.aligner.descriptor,
            self.embedder.descriptor,
            *self.extra,
        )
