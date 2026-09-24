#!/usr/bin/env python3
"""Emit a CycloneDX bill of materials for what this service actually runs.

    python scripts/sbom.py > sbom.json
    python scripts/sbom.py --pretty

Two kinds of component, and the difference matters:

* **Model artefacts** — read from ``app/models/model_files.py``, the same
  pins the build and the startup check use. Each carries its SHA-256 and its
  source URL, so "which weights served this attendance record" is answerable
  from the document.
* **Python distributions** — read from the *installed* environment via
  ``importlib.metadata``. Resolved versions, not the ranges in
  requirements.txt: a range is what we asked for, and an SBOM should say what
  we got. Run this inside the image to describe the image.

Licences come from each distribution's own metadata. Where a project declares
none, the field is ``null`` rather than a guess — an SBOM that invents a
licence is worse than one that admits it does not know. The licensing that
matters for this product is audited by hand in docs/MODEL_LICENSES.md; this
document is the inventory, not the audit.

Standard library only, so it runs in the image without adding a dependency
whose own licence would then need auditing.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.model_files import ARTIFACT_SETS

#: Hand-audited, from docs/MODEL_LICENSES.md. Only for components whose own
#: metadata cannot carry a licence: a downloaded .dat file has no metadata.
ARTIFACT_LICENCES = {
    "dlib_face_recognition_resnet_model_v1.dat": (
        "CC0-1.0",
        "Released into the public domain by the author (davisking/dlib-models). "
        "About half the training images came from FaceScrub (CC BY-NC-ND 3.0) "
        "and VGG Face (CC BY-NC 4.0); see docs/MODEL_LICENSES.md.",
    ),
    "face_detection_yunet_2023mar.onnx": (
        "MIT",
        "Not used in production: trained on WIDER Face, whose terms are "
        "academic-only. See app/models/LICENSING.md.",
    ),
    "face_recognition_sface_2021dec.onnx": (
        "Apache-2.0",
        "Not used in production: the training-data provenance of the "
        "distributed artefact is undocumented. See app/models/LICENSING.md.",
    ),
}

#: Not a Python distribution and not a file we ship, but it is part of the
#: running pipeline and a reader of this document needs to see it.
MANAGED_SERVICES = [
    {
        "type": "service",
        "bom-ref": "service:azure-ai-face-detect",
        "name": "azure-ai-face",
        "version": "detection_03",
        "description": (
            "Face detection only. Identify, Verify and the PersonGroup APIs "
            "are never called. Microsoft Product Terms apply under the "
            "subscription; no artefact is downloaded or run here."
        ),
    }
]


def _licence(dist: metadata.Distribution) -> str | None:
    meta = dist.metadata
    declared = meta.get("License-Expression") or meta.get("License")
    if declared and len(declared) < 120 and "\n" not in declared:
        return declared
    for classifier in meta.get_all("Classifier") or []:
        if classifier.startswith("License :: "):
            return classifier.rsplit(" :: ", 1)[-1]
    return None


def python_components() -> list[dict]:
    out = []
    def name_of(dist: metadata.Distribution) -> str:
        return str(dist.metadata["Name"]).lower()

    for dist in sorted(metadata.distributions(), key=name_of):
        name = dist.metadata["Name"]
        component: dict = {
            "type": "library",
            "bom-ref": f"pkg:pypi/{name.lower()}@{dist.version}",
            "name": name,
            "version": dist.version,
            "purl": f"pkg:pypi/{name.lower()}@{dist.version}",
        }
        licence = _licence(dist)
        component["licenses"] = [{"license": {"name": licence}}] if licence else []
        out.append(component)
    return out


def artifact_components() -> list[dict]:
    out = []
    for artifact in ARTIFACT_SETS["all"]:
        licence, note = ARTIFACT_LICENCES.get(artifact.filename, (None, ""))
        out.append(
            {
                "type": "machine-learning-model",
                "bom-ref": f"model:{artifact.filename}",
                "name": artifact.filename,
                "version": artifact.sha256[:12],
                "description": note or None,
                "hashes": [{"alg": "SHA-256", "content": artifact.sha256}],
                "externalReferences": [
                    {"type": "distribution", "url": artifact.source_url}
                ],
                "licenses": [{"license": {"id": licence}}] if licence else [],
                "properties": [
                    {"name": "attendance:role", "value": artifact.role},
                    {"name": "attendance:bytes", "value": str(artifact.size_bytes)},
                ],
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true", help="indent the output")
    args = parser.parse_args()

    document = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
            "component": {
                "type": "application",
                "bom-ref": "attendance-face-ai",
                "name": "attendance-face-ai",
                "description": (
                    "Face detection, quality assessment and embedding for the "
                    "attendance product. Licence audit: docs/MODEL_LICENSES.md."
                ),
            },
            "tools": [{"name": "services/face-ai/scripts/sbom.py"}],
        },
        "components": artifact_components() + python_components(),
        "services": MANAGED_SERVICES,
    }
    json.dump(document, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
