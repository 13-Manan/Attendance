# Face AI Service

Isolated FastAPI service that turns classroom images into face embeddings.
Stateless, never touches Postgres — see [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
and [`docs/adr/0002-face-ai-service-isolation-and-statelessness.md`](../../docs/adr/0002-face-ai-service-isolation-and-statelessness.md).

Backends:

- `azure_detection_own_recognition` — **what production runs.** Azure AI Face
  is asked one question per image — *where are the faces, and where are their
  landmarks?* — and everything that decides **who** a face belongs to happens
  in this process: dlib's `dlib_face_recognition_resnet_model_v1`, 128-d and
  L2-normalised, on a chip aligned from Azure's landmarks and cut from the
  full-resolution original. Identify, Verify and the PersonGroup APIs are
  never called, so nothing here waits on Microsoft's Limited Access approval,
  and no face template leaves our infrastructure. The weights are public
  domain, SHA-256 pinned and baked into the image. Cleared for commercial use;
  see the residual training-data question in
  [`docs/MODEL_LICENSES.md`](docs/MODEL_LICENSES.md), which is referred to
  legal review and is not settled.
- `mock` — hashes the image bytes into a vector. **It cannot recognise a
  face**: a new photo of an enrolled student scores near 0 against their
  template, so every capture reads as "no match". Only a byte-identical copy
  of an enrollment photo matches. Useful for exercising the pipeline, nothing
  else.
- `opencv` — YuNet detector + SFace recogniser. Real recognition; weights are
  fetched separately (below), not shipped in the image. Commercial use is
  `unclear`, so it is not production-eligible.
- `azure` — Azure AI Face for detection *and* identification, with one gallery
  per class. Superseded: identification is a Limited Access feature that was
  never approved for this resource, so it detected faces and identified
  nobody. Kept in the registry; not what production runs.
- `onnx` — a scaffold that refuses to load without configured weights.

Read [`app/models/LICENSING.md`](app/models/LICENSING.md) before adding a real
model — it is the policy and the log of every backend that has been through
it — and [`docs/FACE_AI_ARCHITECTURE.md`](../../docs/FACE_AI_ARCHITECTURE.md)
for how the layers fit together.

## Documentation

`docs/` holds what is true of the backend production actually runs. Each
answers a different question and none of them repeats another:

| Document | What it answers |
| --- | --- |
| [`docs/RECOGNITION.md`](docs/RECOGNITION.md) | How the pipeline works, stage by stage: what Azure is sent, how the chip is aligned, what happens when any of it fails |
| [`docs/MODEL_LICENSES.md`](docs/MODEL_LICENSES.md) | The licence audit — every artefact in the image, and the one question referred to legal review |
| [`docs/CALIBRATION.md`](docs/CALIBRATION.md) | Where the thresholds come from, what was measured, and — at length — what the measurement does **not** establish |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACE_MODEL_BACKEND` | `mock` | Which registered provider to load. Production: `azure_detection_own_recognition` |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `false` | Refuse to start unless the backend is licence-cleared. Production: `true` |
| `FACE_MODEL_DIR` | unset | Directory holding model weights (`azure_detection_own_recognition`, `opencv`, `onnx`). Production: `/srv/models`, baked into the image |
| `AZURE_FACE_ENDPOINT` | unset | `https://<resource>.cognitiveservices.azure.com/`. Server-side only |
| `AZURE_FACE_KEY` | unset | The resource key, from Key Vault. Never logged, never in a response |
| `AZURE_FACE_TIMEOUT_S` / `AZURE_FACE_MAX_RETRIES` | 15 s / 2 | Azure client bounds |
| `FACE_MODEL_EXECUTION_PROVIDERS` | `CPUExecutionProvider` | Comma-separated, in priority order |
| `FACE_MODEL_INTRA_OP_THREADS` | `0` | Intra-op thread count (0 = runtime default) |

## Prerequisites

- Python 3.11+ (this repo pins `.python-version` to 3.11; a version manager
  like `pyenv` is recommended since the system Python may be older)

## Setup

```bash
cd services/face-ai
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

That serves `mock`. To run what production runs, fetch the pinned recogniser
weights once (they are SHA-256 checked, and git-ignored) and supply Azure
credentials — the backend detects through the managed service, so it cannot
run offline:

```bash
.venv/bin/python scripts/fetch_models.py --set dlib   # into ./models
FACE_MODEL_BACKEND=azure_detection_own_recognition \
  FACE_MODEL_DIR="$PWD/models" \
  AZURE_FACE_ENDPOINT="https://<resource>.cognitiveservices.azure.com/" \
  AZURE_FACE_KEY="<key>" \
  uvicorn app.main:app --reload --port 8000
```

Startup is fail-fast and in this order: verify the weights' SHA-256, load the
network, run the golden self-test, build the Azure client, then make one
Detect call on a **synthetic** pattern to prove the credential. A wrong key
stops the service there. An Azure that is merely unreachable logs a warning
and lets the service start; requests answer `503` until it returns.

For real recognition with no Azure resource, `opencv` still works locally and
is still not production-eligible:

```bash
.venv/bin/python scripts/fetch_models.py --set opencv
FACE_MODEL_BACKEND=opencv FACE_MODEL_DIR="$PWD/models" \
  uvicorn app.main:app --reload --port 8000
```

Templates are stored against the model that produced them, and recognition
only compares against the running model's templates. Switching backend
therefore leaves earlier enrollments out of the candidate pool — re-enrol
students after switching.

## Verify

```bash
curl localhost:8000/v1/health
# {"status":"ok","modelName":"mock","modelVersion":"0.1.0+pp1","embeddingDim":128}

# Full provenance of the loaded model, including whether it may be used
# in production at all.
curl localhost:8000/v1/model-info

curl -X POST localhost:8000/v1/detect-embed \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test","images":[{"sequenceNumber":1,"imageBase64":"Zm9v"}]}'
```

`/v1/model-info` is also where the backend publishes its `calibration`: the
measured map from its raw similarities onto the product's scale. apps/web
applies it everywhere two faces are compared and **refuses to run** if a
production embedding backend publishes none, because "no map" and "the
identity map" are different claims and guessing the second marks strangers
present.

### Checks that need no running service

```bash
.venv/bin/python scripts/verify_recognizer.py         # weights SHA-256 + golden self-test
.venv/bin/python scripts/fetch_models.py --set dlib --check   # checksums only, no download
.venv/bin/python scripts/sbom.py --pretty             # CycloneDX inventory of what is installed
```

`verify_recognizer.py` runs during the image build as well. dlib selects its
SIMD code paths from the machine that compiled it, and a different BLAS or a
miscompiled path changes the descriptors it produces — not by much, and not
with an error. The symptom would be students quietly ceasing to be recognised
months later, because their templates were written by one build and compared
by another. Failing the build is the cheap version of finding that out.

`sbom.py` reads the same pins the build and the startup check read, plus the
*installed* distribution versions rather than the ranges asked for in the
requirements files. It is generated rather than committed so it cannot drift
from the things the build actually reads.

## Test

```bash
.venv/bin/python -m pytest tests -q
.venv/bin/python -m ruff check .
```
