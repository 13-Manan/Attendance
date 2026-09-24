#!/usr/bin/env python3
"""Prove this build of the recogniser computes what was calibrated.

    python scripts/verify_recognizer.py [--dir /srv/models]

Run during the image build (services/face-ai/Dockerfile) and available in the
runbook for a container that is behaving oddly. It does exactly what the
service does at startup: verify the weights' SHA-256, load the network, and
compare its output on a fixed synthetic chip against the pinned ``GOLDEN_*``
values in app/models/dlib_recognition.py.

Why it is worth a build step of its own: dlib selects SSE4/AVX code paths from
the machine that compiles it, and a different BLAS or a miscompiled SIMD path
changes the descriptors it produces. Not by much, and not with an error — the
symptom is students who quietly stop being recognised, months later, because
their templates were written by one build and compared by another. Failing the
build is the cheap version of finding that out.

Exits non-zero, loudly, on any mismatch. Prints no vector.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.dlib_recognition import (
    DlibResNetEmbedder,
    RecognizerSelfTestError,
)
from app.models.model_files import (
    DLIB_ARTIFACTS,
    DLIB_RESNET,
    ModelArtifactError,
    verify_all,
)

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "models"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        type=Path,
        default=DEFAULT_DIR,
        help="directory holding the pinned recogniser (default: ./models)",
    )
    args = parser.parse_args()

    try:
        weights = verify_all(args.dir, DLIB_ARTIFACTS)[DLIB_RESNET.role]
    except ModelArtifactError as error:
        print(f"model artefact check failed: {error}", file=sys.stderr)
        return 1

    embedder = DlibResNetEmbedder(weights)
    try:
        embedder.load()
    except RecognizerSelfTestError as error:
        print(f"recogniser self-test failed: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"the recogniser could not be loaded: {error}", file=sys.stderr)
        return 1

    print(f"recogniser self-test passed ({DLIB_RESNET.filename}, {weights})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
