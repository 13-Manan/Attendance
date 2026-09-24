# Model licences — `azure_detection_own_recognition`

**Status: cleared for production, with one residual question referred to legal
review and recorded below.** Nothing in this backend is research-only, and no
part of it requires a licence key, an account, a registration or an approval
from anybody.

This is the licence audit for the backend that production runs. The wider
policy — how a backend gets cleared at all, and the log of every other backend
— is [`../app/models/LICENSING.md`](../app/models/LICENSING.md). Read that
first if you are adding a backend; read this if you want to know what is
actually shipping.

The rule that governs this whole document: **an open-source repository does
not imply freely usable model weights.** The licence on a project's source
code says nothing about the licence on the files it distributes, and the
licence on the weights says nothing about what the data they were trained on
permitted. All three were checked separately.

---

## What the running pipeline is made of

| Stage | Component | Runs where |
| --- | --- | --- |
| Detector | Azure AI Face `detection_03` | Microsoft's service |
| Aligner | dlib's similarity-transform chip extraction | This container |
| Embedder | `dlib_face_recognition_resnet_model_v1` | This container |
| Matcher | Cosine similarity | apps/web |

Azure is asked for one thing: *where are the faces, and where are their
landmarks*. The Identify, Verify and PersonGroup APIs — the Limited Access
features that need Microsoft's written approval — are never called. Nothing in
this pipeline waits on that approval, and a test asserts it
(`tests/test_azure_dlib_provider.py`: any Azure path other than `/detect`
fails the test that provoked it).

---

## 1. Azure AI Face — detection

| Question | Answer |
| --- | --- |
| Model name | Azure AI Face detection |
| Model version | `detection_03` |
| Source | Managed service; no artefact is downloaded or run here |
| Software licence | Not applicable — no software is distributed to us |
| Terms | Microsoft Product Terms for Azure AI services, under the subscription owning resource `attendance-azure-face` |
| Commercial use | **Permitted** under the subscription |
| Redistribution | Not applicable; nothing to redistribute |
| Attribution | None required |
| Registration / key required | **Yes** — an Azure subscription and a resource key. Server-side only, from Key Vault, never in source, logs or the browser |
| Approval required | **No, for detection.** Identification and Verification are Limited Access ([aka.ms/facerecognition](https://aka.ms/facerecognition)) and are not used |
| Conflicts with this product | None identified for detection |

Detection was verified live against the production resource on 2026-09-24: a
Detect call without `returnFaceId` answers 200; every Identify-family call
answers `403 UnsupportedFeature`. That is precisely why detection is the only
thing asked of it.

**Data sent:** decoded pixels, re-encoded as JPEG. Never the uploaded file, so
EXIF — GPS position, device identity — never leaves this service. No `faceId`
is requested, so Azure is not asked to retain anything.

## 2. dlib (the library)

| Question | Answer |
| --- | --- |
| Component | dlib 20.0.1, built from source in the image |
| Repository | <https://github.com/davisking/dlib> |
| Source distribution | <https://files.pythonhosted.org/packages/25/1e/17570a07f9db19014f5df9cc5de2b4acfb47834e9921e019372b51d7cc03/dlib-20.0.1.tar.gz> |
| sha256 | `7cb2a09467de032332c743bc967007f016598c66c9c9ebc54a5b66d3d9e46d54` (3,327,542 bytes), pinned in [`../requirements-dlib.txt`](../requirements-dlib.txt) |
| Software licence | **Boost Software License 1.0** |
| Commercial use | **Permitted** |
| Redistribution | Permitted. Boost 1.0 requires the copyright notice and licence text to accompany *source* redistribution; it explicitly does **not** require them for binary/machine-executable distribution, which is what this image ships |
| Attribution | Not required for the binary form shipped here |
| Registration / key required | **No** |
| Conflicts with this product | None |

Boost 1.0 is one of the most permissive licences in use: no copyleft, no
advertising clause, no notice requirement on binaries.

## 3. `dlib_face_recognition_resnet_model_v1` (the weights)

| Question | Answer |
| --- | --- |
| Model name | `dlib_face_recognition_resnet_model_v1` |
| Model version | pinned at commit `2a61575` of davisking/dlib-models |
| Weights source | <https://github.com/davisking/dlib-models/raw/2a61575dd45d818271c085ff8cd747613a48f20d/dlib_face_recognition_resnet_model_v1.dat.bz2> |
| sha256 (archive) | `abb1f61041e434465855ce81c2bd546e830d28bcbed8d27ffbe5bb408b11553a` (21,428,389 bytes) |
| sha256 (decompressed `.dat`) | `55533b28a95800a551ba546ba62fe69625c7e95a7061c338adffead08719da30` (22,466,066 bytes) |
| Repository licence | **CC0-1.0** (the dlib-models repository) |
| Weights licence | **Public domain**, by the author's explicit statement |
| Commercial use | **Permitted** |
| Redistribution | Permitted without condition |
| Attribution | Not required. Given anyway, in this file and in `/v1/model-info` |
| Registration / key required | **No** |
| Conflicts with this product | See the residual question below |

The author's statement, from the dlib-models README:

> "...anyone can do whatever they want with these model files as I've released
> them into the public domain."

Both checksums are pinned in [`../app/models/model_files.py`](../app/models/model_files.py)
and verified twice: the compressed archive against its own pin before it is
opened, and the decompressed file against the artefact pin before it is put in
place. The service verifies the same checksum again at startup, so a layer
altered after the build does not serve.

### Residual question: the training data — REFERRED FOR LEGAL REVIEW

The same README describes the training set:

> "...about half the images are from VGG and face scrub... 7485 identities...
> no overlap with LFW"

Those two research corpora carry non-commercial licences:

| Corpus | Licence |
| --- | --- |
| FaceScrub | CC BY-NC-ND 3.0 |
| VGG Face | CC BY-NC 4.0 |

**What this does and does not mean.** The weights themselves are released into
the public domain by the person who trained them, and this product's use of
them requires no permission from him. Whether a non-commercially-licensed
*dataset* can restrict commercial use of a *model* trained on it is an
unsettled question of law, not a defect in the licence we were granted, and it
is not one an engineer should decide.

**The position taken here, deliberately:** the backend is marked
`commercial_use = "permitted"` on the strength of the licence actually granted
for the artefact we ship, and this paragraph exists so that the question is
recorded rather than buried. It is flagged for legal review in
[`../app/models/LICENSING.md`](../app/models/LICENSING.md), in the registry
entry in `app/config.py`, in the embedder's stage descriptor (visible on
`/v1/model-info`), and in the deployment report.

**If that review comes back negative,** the replacement path is clean: this
backend is one entry in `MODEL_REGISTRY`, the weights are one pinned artefact,
and `modelVersion` changes with them — which flips every stored template to
`NEEDS_REENROLLMENT` automatically rather than silently mixing model versions.
The detector, the alignment, the calibration machinery and every line of
apps/web stay exactly as they are.

This is the same standard that keeps the `opencv` backend out of production:
its SFace artefact has permissive licence files but an undocumented training
corpus, which is *less* evidence than we have here, not more.

## 4. Everything else in the image

| Component | Version | Licence | Commercial use |
| --- | --- | --- | --- |
| Python | 3.12 (`python:3.12-slim`) | PSF-2.0 | Permitted |
| FastAPI | >=0.115,<1.0 | MIT | Permitted |
| Starlette | (via FastAPI) | BSD-3-Clause | Permitted |
| Uvicorn | >=0.32,<1.0 | BSD-3-Clause | Permitted |
| Gunicorn | >=23.0,<24.0 | MIT | Permitted |
| Pydantic / pydantic-settings | >=2.9 / >=2.6 | MIT | Permitted |
| httpx | >=0.27,<1.0 | BSD-3-Clause | Permitted |
| NumPy | >=2.0,<3.0 | BSD-3-Clause | Permitted |
| opencv-python-headless | >=4.10,<5.0 | Apache-2.0 | Permitted |
| Pillow | >=10.4,<11.0 | MIT-CMU | Permitted |
| python-multipart | >=0.0.12 | Apache-2.0 | Permitted |
| onnxruntime | >=1.19,<2.0 | MIT | Permitted |
| setuptools (build only) | 84.0.0 | MIT | Permitted |
| wheel (build only) | 0.45.1 | MIT | Permitted |
| OpenBLAS (runtime lib) | Debian `libopenblas0-pthread` | BSD-3-Clause | Permitted |

`onnxruntime` and `opencv-python-headless` remain installed because the
`onnx` and `opencv` backends still exist in the registry for local evaluation.
Neither runs in production; `FACE_AI_REQUIRE_PRODUCTION_MODEL=true` refuses to
start on either.

**No component of this image requires a licence key, an API key for the model,
a registration, an account, or a per-seat or per-request model fee.** The one
credential in the system is the Azure resource key, which buys face
*detection* as a service, not a licence to a model.

## SBOM

A machine-readable bill of materials for the artefacts this backend runs is
generated from the same pins the build uses:

    python scripts/sbom.py > sbom.json

It is generated rather than committed so it cannot drift from
`app/models/model_files.py` and the requirements files, which are the things
the build actually reads.

---

## Verification record

| Item | Verified | By | How |
| --- | --- | --- | --- |
| dlib weights public domain | 2026-09-24 | this deployment | dlib-models README, quoted above; repository LICENSE = CC0-1.0 |
| dlib library Boost 1.0 | 2026-09-24 | this deployment | LICENSE.txt in the pinned sdist |
| Training-data corpora and their licences | 2026-09-24 | this deployment | dlib-models README; FaceScrub and VGG Face published terms |
| Azure detection needs no Limited Access approval | 2026-09-24 | this deployment | Live call against the production resource: Detect 200, Identify 403 |
| Artefact checksums | 2026-09-24 | this deployment | `scripts/fetch_models.py`, which fails the build on any mismatch |
| Commercial-use position on training data | **REFERRED** | — | Awaiting legal review; see above |
| Calibration holds through the production path | 2026-09-24 | this deployment | 142 live Detect calls with re-encoded payloads; every decision identical to the original-bytes evaluation ([CALIBRATION.md](CALIBRATION.md)) |
| Compiled recogniser matches the calibrated one | 2026-09-24 | this deployment | Golden self-test run inside the built image (`scripts/verify_recognizer.py`) |
