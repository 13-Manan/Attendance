#!/usr/bin/env python3
"""Download the pinned YuNet and SFace artefacts, and verify what arrived.

    python scripts/fetch_models.py                 # into ./models
    python scripts/fetch_models.py --dir /srv/models
    python scripts/fetch_models.py --check         # verify only, download nothing

The weights are not in git (see app/models/model_files.py for why), so this is
how a checkout, a CI job or a container build acquires them. Every path through
this script ends in a SHA-256 comparison against the pin in
``app/models/model_files.py`` — a download that produces unexpected bytes leaves
nothing behind.

Deliberately uses only the standard library. This runs before dependencies are
necessarily installed, and a model-acquisition script that needs `requests` to
fetch the models is one more thing to get wrong in a Dockerfile.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.model_files import (
    REQUIRED_ARTIFACTS,
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


def download(artifact: ModelArtifact, destination: Path) -> None:
    """Fetch one artefact, verifying before it is put in place.

    Downloaded to a temporary file in the same directory and only renamed once
    the hash matches. An interrupted or corrupted download therefore cannot
    leave a plausible-looking artefact at the real path — the next run would
    otherwise "verify" a truncated file into existence and fail confusingly.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {artifact.filename} ({human(artifact.size_bytes)})")

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=destination.parent,
            prefix=f".{artifact.filename}.",
            suffix=".part",
            delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            # A User-Agent is set because some CDNs refuse the urllib default.
            request = urllib.request.Request(
                artifact.source_url, headers={"User-Agent": "attendance-face-ai/1.0"}
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                while chunk := response.read(1024 * 1024):
                    tmp.write(chunk)

        actual_sha = file_sha256(tmp_path)
        if actual_sha != artifact.sha256:
            raise ModelArtifactError(
                f"Downloaded {artifact.filename} does not match its pin.\n"
                f"  expected SHA-256 {artifact.sha256}\n"
                f"  actual   SHA-256 {actual_sha}\n"
                f"  source           {artifact.source_url}\n"
                f"Nothing has been written to {destination}. Either upstream "
                f"republished this file — in which case the change must be "
                f"audited and the pin updated deliberately — or the download "
                f"was tampered with or truncated."
            )

        # NamedTemporaryFile creates 0600. The container runs as a non-root
        # user that must be able to read these, and in the image they are
        # copied in by a different user than the one that runs the process.
        tmp_path.chmod(0o644)
        tmp_path.replace(destination)
        tmp_path = None
        print(f"  verified {artifact.filename}  sha256={actual_sha[:16]}…")
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir", type=Path, default=DEFAULT_DIR, help="target directory"
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

    print(f"Model directory: {args.dir}")
    failures = 0

    for artifact in REQUIRED_ARTIFACTS:
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
    print(
        "\nReminder: these weights are NOT cleared for commercial use. "
        "See app/models/LICENSING.md — productionEligible stays false."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
