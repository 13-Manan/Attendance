# Face AI Service

Isolated FastAPI service that turns classroom images into face embeddings.
Stateless, never touches Postgres — see [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
and [`docs/adr/0002-face-ai-service-isolation-and-statelessness.md`](../../docs/adr/0002-face-ai-service-isolation-and-statelessness.md).

Backends:

- `mock` — hashes the image bytes into a vector. **It cannot recognise a
  face**: a new photo of an enrolled student scores near 0 against their
  template, so every capture reads as "no match". Only a byte-identical copy
  of an enrollment photo matches. Useful for exercising the pipeline, nothing
  else.
- `opencv` — YuNet detector + SFace recogniser. Real recognition; weights are
  fetched separately (below), not shipped in the image. Commercial use is
  `unclear`, so it is not production-eligible.
- `onnx` — a scaffold that refuses to load without configured weights.

**No model is cleared for production use.** Read
[`app/models/LICENSING.md`](app/models/LICENSING.md) before adding a real
model, and [`docs/FACE_AI_ARCHITECTURE.md`](../../docs/FACE_AI_ARCHITECTURE.md)
for how the layers fit together.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACE_MODEL_BACKEND` | `mock` | Which registered provider to load |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `false` | Refuse to start unless the backend is licence-cleared |
| `FACE_MODEL_DIR` | unset | Directory holding model weights (`opencv`, `onnx`) |
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

That serves `mock`. To exercise real recognition locally, fetch the pinned
weights once (they are SHA-256 checked, and git-ignored) and select `opencv`:

```bash
.venv/bin/python scripts/fetch_models.py            # into ./models
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

## Test

```bash
.venv/bin/python -m pytest tests -q
.venv/bin/python -m ruff check .
```
