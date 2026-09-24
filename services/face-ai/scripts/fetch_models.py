#!/usr/bin/env python3
"""Download the pinned model artefacts, and verify what arrived.

    python scripts/fetch_models.py                 # every set, into ./models
    python scripts/fetch_models.py --set dlib      # only the production recogniser
    python scripts/fetch_models.py --dir /srv/models
    python scripts/fetch_models.py --check         # verify only, download nothing

Sets (app/models/model_files.py ``ARTIFACT_SETS``):

    opencv  YuNet + SFace. The ``opencv`` backend. NOT cleared for commercial use.
    dlib    dlib ResNet v1. The ``azure_detection_own_recognition`` backend.
            Public-domain weights; the only set the production image bakes in.
    all     both (the default: CI and local tests exercise every backend)

The weights are not in git (see app/models/model_files.py for why), so this is
how a checkout, a CI job or a container build acquires them. Every path through
this script ends in a SHA-256 comparison against the pin in
``app/models/model_files.py`` — a download that produces unexpected bytes leaves
nothing behind. A compressed download is checked twice: the archive against
its own pin before it is opened, and the decompressed file against the
artefact pin before it is put in place.

Deliberately uses only the standard library. This runs before dependencies are
necessarily installed, and a model-acquisition script that needs `requests` to
fetch the models is one more thing to get wrong in a Dockerfile.
"""

from __future__ import annotations

import argparse
import bz2
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.model_files import (
    ARTIFACT_SETS,
    DLIB_ARTIFACTS,
    ModelArtifact,
    ModelArtifactError,
    file_sha256,
    resolve_artifact_path,
    verify_artifact,
)

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "models"


def human(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MiB"
    return f"{size / 1024:.0f} KiB"


def _mismatch(
    what: str, expected: str, actual: str, source: str, destination: Path
) -> ModelArtifactError:
    return ModelArtifactError(
        f"Downloaded {what} does not match its pin.\n"
        f"  expected SHA-256 {expected}\n"
        f"  actual   SHA-256 {actual}\n"
        f"  source           {source}\n"
        f"Nothing has been written to {destination}. Either upstream "
        f"republished this file — in which case the change must be "
        f"audited and the pin updated deliberately — or the download "
        f"was tampered with or truncated."
    )


def _fetch(url: str, into) -> None:
    # A User-Agent is set because some CDNs refuse the urllib default.
    request = urllib.request.Request(
        url, headers={"User-Agent": "attendance-face-ai/1.0"}
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        while chunk := response.read(1024 * 1024):
            into.write(chunk)


def _decompress_bz2(archive: Path, into, limit: int) -> None:
    """Stream-decompress, refusing to write more than ``limit`` bytes.

    The archive has already matched its pin, so this cannot be handed a
    decompression bomb by a third party. The limit still costs nothing and
    means a mistaken pin fails here rather than by filling the disk.
    """
    decompressor = bz2.BZ2Decompressor()
    written = 0
    with archive.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            data = decompressor.decompress(chunk)
            written += len(data)
            if written > limit:
                raise ModelArtifactError(
                    f"{archive.name} decompresses to more than the pinned "
                    f"{limit} bytes; refusing to continue."
                )
            into.write(data)
    if not decompressor.eof:
        raise ModelArtifactError(f"{archive.name} is a truncated bz2 stream.")


def download(artifact: ModelArtifact, destination: Path) -> None:
    """Fetch one artefact, verifying before it is put in place.

    Downloaded to a temporary file in the same directory and only renamed once
    the hash matches. An interrupted or corrupted download therefore cannot
    leave a plausible-looking artefact at the real path — the next run would
    otherwise "verify" a truncated file into existence and fail confusingly.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = artifact.archive_size_bytes or artifact.size_bytes
    print(f"  fetching {artifact.source_url.rsplit('/', 1)[-1]} ({human(size)})")

    temporaries: list[Path] = []

    def temporary(suffix: str):
        handle = tempfile.NamedTemporaryFile(
            dir=destination.parent,
            prefix=f".{artifact.filename}.",
            suffix=suffix,
            delete=False,
        )
        temporaries.append(Path(handle.name))
        return handle

    try:
        with temporary(".part") as tmp:
            _fetch(artifact.source_url, tmp)
        fetched = temporaries[-1]

        if artifact.archive_format is None:
            final = fetched
        elif artifact.archive_format == "bz2":
            actual_archive_sha = file_sha256(fetched)
            if actual_archive_sha != artifact.archive_sha256:
                raise _mismatch(
                    f"archive for {artifact.filename}",
                    artifact.archive_sha256 or "",
                    actual_archive_sha,
                    artifact.source_url,
                    destination,
                )
            with temporary(".unpacked") as unpacked:
                _decompress_bz2(fetched, unpacked, artifact.size_bytes)
            final = temporaries[-1]
        else:
            raise ModelArtifactError(
                f"{artifact.filename}: unsupported archive format "
                f"{artifact.archive_format!r}"
            )

        actual_sha = file_sha256(final)
        if actual_sha != artifact.sha256:
            raise _mismatch(
                artifact.filename,
                artifact.sha256,
                actual_sha,
                artifact.source_url,
                destination,
            )

        # NamedTemporaryFile creates 0600. The container runs as a non-root
        # user that must be able to read these, and in the image they are
        # copied in by a different user than the one that runs the process.
        final.chmod(0o644)
        final.replace(destination)
        temporaries.remove(final)
        print(f"  verified {artifact.filename}  sha256={actual_sha[:16]}…")
    finally:
        for path in temporaries:
            if path.exists():
                path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--dir", type=Path, default=DEFAULT_DIR, help="target directory"
    )
    parser.add_argument(
        "--set",
        dest="artifact_set",
        choices=sorted(ARTIFACT_SETS),
        default="all",
        help="which artefacts to fetch (default: all)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify existing files; never download",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-download even if a valid file is present",
    )
    args = parser.parse_args()

    artifacts = ARTIFACT_SETS[args.artifact_set]
    print(f"Model directory: {args.dir}  (set: {args.artifact_set})")
    failures = 0

    for artifact in artifacts:
        path = resolve_artifact_path(args.dir, artifact)
        print(f"\n{artifact.role}: {artifact.filename} ({artifact.upstream_release})")

        if not args.force and path.is_file():
            try:
                verify_artifact(args.dir, artifact)
                print("  already present and verified")
                continue
            except ModelArtifactError as error:
                if args.check:
                    print(f"  FAILED: {error}")
                    failures += 1
                    continue
                print(f"  present but invalid, re-downloading: {error}")

        if args.check:
            print(f"  FAILED: missing at {path}")
            failures += 1
            continue

        try:
            download(artifact, path)
        except (ModelArtifactError, urllib.error.URLError, OSError) as error:
            print(f"  FAILED: {error}")
            failures += 1

    print()
    if failures:
        print(f"{failures} artefact(s) failed. The service will refuse to start.")
        return 1

    print("All model artefacts present and verified against their pins.")
    if any(a not in DLIB_ARTIFACTS for a in artifacts):
        print(
            "\nReminder: the YuNet/SFace weights are NOT cleared for commercial "
            "use. See app/models/LICENSING.md — the opencv backend stays out of "
            "production."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
