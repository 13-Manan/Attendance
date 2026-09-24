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

The artefacts are ~60 MiB together and are not in git. Binary blobs in a source
repository are a licensing question as much as a size one — see LICENSING.md,
where the commercial-use status of the YuNet/SFace weights is still
``unclear``. ``scripts/fetch_models.py`` acquires them reproducibly instead.

The dlib recogniser is the exception that proves the rule: its weights are
public domain (docs/MODEL_LICENSES.md), so the production image bakes it in at
build time — fetched by the same script, verified against the same pin, and
checked again at startup. Nothing is downloaded while the service runs.
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
    #: Set when ``source_url`` serves a compressed file. The download is then
    #: verified twice: the archive against ``archive_sha256``, and the
    #: decompressed bytes against ``sha256``. Only the decompressed file is
    #: kept, and only it is verified at startup.
    archive_format: str | None = None
    archive_sha256: str | None = None
    archive_size_bytes: int | None = None


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

#: dlib's ResNet face recogniser (``dlib_face_recognition_resnet_model_v1``).
#: 21.4 MiB compressed and 22.5 MiB on disk. It emits a 128-d descriptor from a
#: 150x150 aligned chip. Used by the ``azure_detection_own_recognition`` backend.
#:
#: The URL pins the upstream commit that added the file (2017-02-11). The
#: identical bytes are also served at http://dlib.net/files/. Both hashes were
#: computed from downloads of both sources, which matched byte for byte. They
#: were not copied from a README. The licence evidence is in
#: docs/MODEL_LICENSES.md.
DLIB_RESNET = ModelArtifact(
    role="recognizer",
    filename="dlib_face_recognition_resnet_model_v1.dat",
    sha256="55533b28a95800a551ba546ba62fe69625c7e95a7061c338adffead08719da30",
    size_bytes=22466066,
    source_url=(
        "https://github.com/davisking/dlib-models/raw/"
        "2a61575dd45d818271c085ff8cd747613a48f20d/"
        "dlib_face_recognition_resnet_model_v1.dat.bz2"
    ),
    upstream_release="v1 (davisking/dlib-models@2a61575)",
    archive_format="bz2",
    archive_sha256="abb1f61041e434465855ce81c2bd546e830d28bcbed8d27ffbe5bb408b11553a",
    archive_size_bytes=21428389,
)

#: What the ``opencv`` backend loads. Its name predates the other sets.
REQUIRED_ARTIFACTS: tuple[ModelArtifact, ...] = (YUNET, SFACE)

#: What the ``azure_detection_own_recognition`` backend loads. Azure does the
#: detecting, so there is no local detector to pin.
DLIB_ARTIFACTS: tuple[ModelArtifact, ...] = (DLIB_RESNET,)

#: Named sets for ``scripts/fetch_models.py``. The production image fetches
#: only ``dlib``: YuNet and SFace are not cleared for commercial use and do
#: not belong in an image that serves institutions.
ARTIFACT_SETS: dict[str, tuple[ModelArtifact, ...]] = {
    "opencv": REQUIRED_ARTIFACTS,
    "dlib": DLIB_ARTIFACTS,
    "all": REQUIRED_ARTIFACTS + DLIB_ARTIFACTS,
}


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


def verify_all(
    model_dir: str | Path,
    artifacts: tuple[ModelArtifact, ...] = REQUIRED_ARTIFACTS,
) -> dict[str, Path]:
    """Verify every artefact in a set. Returns role -> path.

    Keyed by role, so a set must not hold two artefacts with the same role.
    ``ARTIFACT_SETS["all"]`` does, which is why it is for fetching only.
    """
    roles = [a.role for a in artifacts]
    if len(set(roles)) != len(roles):
        raise ValueError(f"artefact set has duplicate roles: {roles}")
    return {a.role: verify_artifact(model_dir, a) for a in artifacts}
