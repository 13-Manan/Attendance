"""Which model artefacts this service will run, and proof that it got them.

A face-recognition service that loads whatever ``.onnx`` file happens to sit at
a path is a service whose behaviour is decided by its filesystem. The filename
is not evidence: two builds of YuNet, a quantised variant, or a swapped file all
present as ``face_detection_yunet_2023mar.onnx``, and the difference only shows
up as students being matched slightly worse for as long as nobody notices.

So each artefact is pinned by **content hash**, and ``verify_artifact`` is
called during ``load()`` — at startup, so a wrong or corrupt file fails the
container's health check rather than a student's enrolment.

The hashes below were computed during the Phase 4.5 audit by downloading each
file from the source URL recorded here and hashing the bytes. They are not
copied from a README.

## On the source URLs

``resolve/main`` is a moving reference — Hugging Face will serve whatever is on
that branch today. That is deliberate and safe *because* of the hash pin: if
upstream republishes the file, the download succeeds and verification fails
loudly, which is the outcome we want. Pinning a commit SHA in the URL as well
would be marginally tidier and would still need the hash check, since a URL
cannot tell us what arrived.

## On not committing the weights

The artefacts are ~37 MiB together and are not in git. Binary blobs in a source
repository are a licensing question as much as a size one — see LICENSING.md,
where the commercial-use status of these very weights is still ``unclear``.
``scripts/fetch_models.py`` acquires them reproducibly instead.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


class ModelArtifactError(RuntimeError):
    """A required model file is missing, unreadable, or not what we pinned."""


@dataclass(frozen=True)
class ModelArtifact:
    """One pinned model file."""

    #: Role in the pipeline, for error messages that say what broke.
    role: str
    filename: str
    #: Lowercase hex SHA-256 of the exact bytes this service expects.
    sha256: str
    #: Size in bytes, checked first because it is free and rejects the common
    #: failure — a Git LFS pointer file (~131 bytes) downloaded instead of the
    #: artefact — with a message that names the actual problem.
    size_bytes: int
    source_url: str
    #: Upstream release identifier. Not semver: OpenCV Zoo dates its releases,
    #: and inventing a version number the upstream does not publish would make
    #: provenance harder to trace, not easier.
    upstream_release: str


#: YuNet face detector. 227 KiB.
YUNET = ModelArtifact(
    role="detector",
    filename="face_detection_yunet_2023mar.onnx",
    sha256="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    size_bytes=232589,
    source_url=(
        "https://huggingface.co/opencv/face_detection_yunet/resolve/main/"
        "face_detection_yunet_2023mar.onnx"
    ),
    upstream_release="2023mar",
)

#: SFace recogniser. 36.9 MiB, emits a 128-d vector.
SFACE = ModelArtifact(
    role="recognizer",
    filename="face_recognition_sface_2021dec.onnx",
    sha256="0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    size_bytes=38696353,
    source_url=(
        "https://huggingface.co/opencv/face_recognition_sface/resolve/main/"
        "face_recognition_sface_2021dec.onnx"
    ),
    upstream_release="2021dec",
)

REQUIRED_ARTIFACTS: tuple[ModelArtifact, ...] = (YUNET, SFACE)


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Hash a file in chunks.

    Streamed rather than ``read()`` because the recogniser is 37 MiB and this
    runs at startup in a container sized for inference, not for holding a
    second copy of every artefact in memory.
    """
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_artifact_path(model_dir: str | Path, artifact: ModelArtifact) -> Path:
    return Path(model_dir) / artifact.filename


def verify_artifact(model_dir: str | Path, artifact: ModelArtifact) -> Path:
    """Return the artefact's path, or raise explaining precisely what is wrong.

    Checks widen as they get more expensive: exists, then size, then hash. The
    size check is not redundant — a Git LFS pointer is a valid, readable,
    131-byte text file, and "expected 232589 bytes, found 131 — this looks like
    a Git LFS pointer" is a far more useful failure than a hash mismatch.
    """
    path = resolve_artifact_path(model_dir, artifact)

    if not path.is_file():
        raise ModelArtifactError(
            f"The {artifact.role} model is missing: expected a file at {path}. "
            f"Run `python scripts/fetch_models.py` to download and verify it, "
            f"or point FACE_MODEL_DIR at a directory that already holds it."
        )

    actual_size = path.stat().st_size
    if actual_size != artifact.size_bytes:
        hint = ""
        if actual_size < 1024:
            hint = (
                " A file this small is almost certainly a Git LFS pointer rather "
                "than the model itself — `git lfs pull`, or use "
                "scripts/fetch_models.py, which downloads the resolved bytes."
            )
        raise ModelArtifactError(
            f"The {artifact.role} model at {path} is {actual_size} bytes; "
            f"{artifact.size_bytes} were expected.{hint}"
        )

    actual_sha = file_sha256(path)
    if actual_sha != artifact.sha256:
        raise ModelArtifactError(
            f"The {artifact.role} model at {path} does not match the pinned "
            f"artefact. Expected SHA-256 {artifact.sha256}, found {actual_sha}. "
            f"Refusing to load: a face-recognition service must not run weights "
            f"nobody has verified. If this is a deliberate model change, update "
            f"the pin in app/models/model_files.py, bump weights_version, and "
            f"record the new artefact in app/models/LICENSING.md — every stored "
            f"template becomes incomparable and every student must be re-enrolled."
        )

    return path


def verify_all(model_dir: str | Path) -> dict[str, Path]:
    """Verify every required artefact. Returns role -> path."""
    return {a.role: verify_artifact(model_dir, a) for a in REQUIRED_ARTIFACTS}
