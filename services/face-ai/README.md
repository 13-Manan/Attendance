# Face AI Service

Isolated FastAPI service that turns classroom images into face embeddings.
Stateless, never touches Postgres — see [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
and [`docs/adr/0002-face-ai-service-isolation-and-statelessness.md`](../../docs/adr/0002-face-ai-service-isolation-and-statelessness.md).

Backends: `mock` (deterministic fake vectors — no real face recognition,
no licensing risk) and `onnx` (a scaffold that refuses to load without
configured weights). **No model is cleared for production use.** Read
[`app/models/LICENSING.md`](app/models/LICENSING.md) before adding a real
model, and [`docs/FACE_AI_ARCHITECTURE.md`](../../docs/FACE_AI_ARCHITECTURE.md)
for how the layers fit together.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACE_MODEL_BACKEND` | `mock` | Which registered provider to load |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `false` | Refuse to start unless the backend is licence-cleared |
| `FACE_MODEL_DIR` | unset | Directory holding ONNX weights |
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

## Verify

```bash
curl localhost:8000/v1/health
# {"status":"ok","modelName":"mock","modelVersion":"0.1.0+pp1","embeddingDim":512}

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
