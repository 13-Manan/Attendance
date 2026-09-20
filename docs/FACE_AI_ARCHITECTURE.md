# Face AI Architecture

How face recognition is structured in this product, why it is structured
that way, and what is verified versus still open.

This is a foundation document, written in Phase 3.1. **No real face
recognition model ships in the repository at the time of writing** — see
[Model licensing](#model-licensing) for why that is a deliberate outcome
rather than an unfinished task.

---

## 1. Layering

```
┌──────────────────────────────────────────────────────────────┐
│ Next.js application (apps/web)                               │
│  auth · RBAC · institution & class context · attendance      │
│  business logic · student records · faculty review · audit   │
│  · UI · vector search (pgvector) · thresholds                │
└───────────────────────────┬──────────────────────────────────┘
                            │ internal AI contract (HTTP + JSON)
                            │ packages/shared-types/src/face-ai-contract.ts
┌───────────────────────────▼──────────────────────────────────┐
│ Face AI service (services/face-ai) — FastAPI, stateless      │
│  routers/*  ← speak only the contract                        │
│  matching.py ← cosine + MATCHED/UNCERTAIN/UNMATCHED          │
└───────────────────────────┬──────────────────────────────────┘
                            │ FaceModelProvider (app/models/base.py)
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼─────────┐ ┌───────▼──────────┐ ┌──────▼─────────────────┐
│ MockEmbedding   │ │ OnnxFaceModel    │ │ OpenCVFaceModelProvider│
│ Model           │ │ Provider         │ │ REAL recognition       │
│ hash stub       │ │ scaffold —       │ │ productionEligible:    │
│ (dev/CI only)   │ │ needs weights    │ │   false (licensing)    │
└─────────────────┘ └───────┬──────────┘ └──────┬─────────────────┘
                            │                   │
                  ┌─────────▼────────┐  ┌───────▼─────────────────┐
                  │ ONNX Runtime     │  │ OpenCV                  │
                  │ (not wired up)   │  │  FaceDetectorYN (YuNet) │
                  └──────────────────┘  │  FaceRecognizerSF(SFace)│
                                        └───────┬─────────────────┘
                                                │
                                   128-d L2-normalised embedding
```

The `opencv` backend uses OpenCV rather than ONNX Runtime for a specific
reason: the YuNet ONNX graph emits twelve *undecoded* per-stride tensors, and
the anchor decoding, score fusion, keypoint decoding and NMS that turn those
into usable detections live in OpenCV's C++ `FaceDetectorYN` — as does
`alignCrop`, the reference implementation of the similarity transform SFace was
trained against. Reimplementing either in Python would mean owning a numerical
reimplementation of somebody else's post-processing, where every bug presents
as "recognition is slightly worse" rather than as a failure.

Two boundaries matter, and they are different in kind:

- **The contract boundary** (Next.js ↔ face-ai) is a network boundary. It
  is versioned, typed on both sides, and is the only thing `apps/web`
  knows about face recognition.
- **The provider boundary** (face-ai ↔ model) is an in-process interface.
  It is where a model gets swapped, and swapping it must not disturb the
  contract boundary above it.

ONNX Runtime sits *below* the model, not beside it. It is the inference
engine — it loads a graph and runs tensors through it. It is not a face
recognition algorithm and is never the answer to "which model are we
using?"

---

## 2. Why the Python service exists at all

Heavy inference does not run inside the Next.js server process. Model
loading holds hundreds of megabytes resident, inference is CPU-bound and
blocking, and the numerical stack (NumPy, OpenCV, ONNX Runtime) is native
Python. Putting that inside the request path of the web tier would make
one classroom photo stall unrelated page renders.

The split is by responsibility, not by convenience:

| Face AI service (Python) | Next.js application |
| --- | --- |
| Image decode and preprocessing | Authentication, sessions |
| Face detection | Authorization / RBAC |
| Alignment | Institution and class context |
| Embedding generation | Attendance business logic |
| Quality assessment | Student and attendance records |
| Similarity scoring against a supplied candidate list | **Candidate selection** (class-scoped query) |
| Model loading and inference lifecycle | Faculty review and corrections |
| AI-specific error handling | Audit logging, UI, API orchestration |

The service holds **no database credentials and no candidate store**
(ADR-0002). That is what makes the class-scoping guarantee in §6 a
structural property rather than a policy.

---

## 3. The model provider interface

`services/face-ai/app/models/base.py`:

```python
class FaceModelProvider(ABC):
    name: str                    # "mock", "arcface-r100", …
    weights_version: str         # a release/tag/commit — never "latest"
    preprocessing_version: str   # bumped when decode/crop/align/normalise changes
    embedding_dim: int
    runtime: str                 # "onnxruntime", "numpy-hash-stub", …
    commercial_use: CommercialUseStatus

    def load(self) -> None: ...
    def unload(self) -> None: ...
    def detect(image_base64) -> DetectionResult: ...
    def assess_quality(image_base64) -> FaceQualityAssessment: ...
    def align(image_base64, bounding_box, landmarks) -> AlignedFace: ...
    def embed(image_base64, bounding_box=None, landmarks=None) -> list[float]: ...
    def detect_and_embed(image) -> list[DetectedFace]: ...
    def compare_embeddings(a, b) -> float      # shared, not overridable in practice
    def model_info() -> FaceModelInfo          # concrete — provenance is not a choice
    @property
    def version(self) -> str                   # f"{weights_version}+pp{preprocessing_version}"
```

Two rules every adapter must honour, stated in the module docstring
because they are not expressible in the type system:

1. `embed()` returns an **L2-normalised** vector of exactly
   `embedding_dim` floats. (ArcFace models do *not* do this themselves —
   see §8.)
2. Failures are expressed only in the shared `FaceQualityReason`
   vocabulary. A backend does not get to invent a rejection reason the UI
   has no wording for.

`compare_embeddings` is concrete and delegates to the shared
`matching.cosine_similarity`, so replacing a backend cannot change how two
vectors are scored — only what the vectors are.

`model_info()` is concrete too. A backend declares its facts; it does not
get to compose its own provenance record or decide whether it is
production-eligible.

### Adding a backend

1. Implement `FaceModelProvider` in `app/models/<name>_provider.py`.
2. Verify the **weights** license and record it in
   `app/models/LICENSING.md`'s backend log.
3. Register it in `MODEL_REGISTRY` (`app/config.py`) with its
   `commercial_use` status and a licence note.
4. Select it with `FACE_MODEL_BACKEND=<name>`.

Nothing in `apps/web` changes. Nothing in the routers changes. The Prisma
schema does not change.

---

## 4. The internal AI contract

Defined twice, deliberately — TypeScript in
`packages/shared-types/src/face-ai-contract.ts`, Pydantic in
`services/face-ai/app/schemas.py` — and kept in step by a parity test
(`tests/test_routes.py::test_python_contract_version_matches_the_typescript_contract`)
that fails if `FACE_AI_CONTRACT_VERSION` or `EMBEDDING_DIMENSION` drift.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | Liveness + which model is loaded |
| `GET /v1/model-info` | Full provenance record |
| `POST /v1/detect` | Faces, boxes, landmarks, image dimensions |
| `POST /v1/quality` | Capture quality assessment |
| `POST /v1/embed` | Embedding for one face |
| `POST /v1/enroll` | Quality gate + embedding in one call |
| `POST /v1/match` | Score a probe against a **supplied** candidate list |
| `POST /v1/detect-embed` | Batch multi-face path (Phase 1 contract) |

### Detection

Returns `faces[]` of `{faceId, boundingBox, detectionConfidence,
landmarks?}` plus `faceCount`, `imageWidth`, `imageHeight`.

`boundingBox` is **pixel coordinates, origin top-left** — stated in both
schema definitions. An undeclared coordinate space is how
normalised-versus-pixel bugs ship.

`landmarks` carries the 5-point set (eyes, nose tip, mouth corners). This
exists because alignment is not cosmetic: without landmarks crossing the
detect→embed boundary, a real backend would have to re-detect inside
`embed()`, doing the work twice and risking a different face being chosen
the second time.

### Quality

`reason` (the shared vocabulary), `qualityScore`, `faceCount`, and
`metrics` for blur, brightness, face size, pose and occlusion.

Each metric is `{status: "measured" | "unavailable", value?, unit?}`.
**A metric that is not implemented reports `unavailable`.** It does not
report a plausible-looking number. An operator tuning a threshold against
an invented value is worse off than one who knows the metric is missing.

### Embedding

`embedding`, `modelName`, `modelVersion`, `weightsVersion`,
`preprocessingVersion`, `embeddingDim`, `aligned`.

`aligned` is false when the adapter could not perform a real alignment and
fell back to a plain crop — the caller is told rather than left to assume.

**Raw embeddings are never exposed through student- or staff-facing
APIs.** `enrollFaceForStudentRequest` returns an embedding *id* and a
quality score; the response type has no field capable of carrying a
vector, so the invariant is structural. The audit trail records model
metadata only. `listActiveEmbeddingMetadataForStudent` never selects the
vector column.

### Matching

```
bestMatch: {studentId, similarity, status} | null
status: "MATCHED" | "UNCERTAIN" | "UNMATCHED"
scores: [...]            // every candidate, best first, each with its own status
thresholdsUsed: {matchThreshold, reviewThreshold}
modelName, modelVersion
skippedIncompatibleCandidates: number
```

`similarity >= matchThreshold` → MATCHED; `>= reviewThreshold` →
UNCERTAIN; otherwise UNMATCHED. Both boundaries are inclusive and both are
covered by boundary tests.

**A low-confidence match is never PRESENT.** `matchStatusToAttendanceResult`
(`apps/web/src/modules/recognition-results/service.ts`) maps UNCERTAIN to
`NEEDS_REVIEW`, never to `PRESENT` — a question for a human, not an
attendance mark.

`skippedIncompatibleCandidates` counts candidates whose vectors could not
be compared (wrong dimension). It is reported rather than swallowed,
because "could not compare" silently becoming "absent" is precisely the
failure that marks a present student absent.

---

## 5. Model versioning and provenance

Every AI result identifies the model that produced it:

| Field | Meaning |
| --- | --- |
| `modelName` | Model/family identifier |
| `weightsVersion` | The weights release, tag or commit |
| `preprocessingVersion` | Bumped when decode, crop, alignment template, resize, channel order or normalisation changes |
| `modelVersion` | Composite: `<weightsVersion>+pp<preprocessingVersion>` |
| `embeddingDim` | Vector length |
| `contractVersion` | Wire-contract version |
| `thresholdsUsed` | The thresholds actually applied (on match results) |

The composite `modelVersion` exists because `FaceEmbedding` has exactly
one column for it and the database schema is not changing in this phase.
Folding preprocessing into it means the existing insert path captures full
provenance with no schema migration — and, more importantly, a
preprocessing change invalidates stored vectors just as surely as a
weights change does, so both belong in the identifier that decides
comparability.

What is *not* stored: no raw images, no source image bytes, no
intermediate crops. Provenance is metadata about the model, not about the
person.

### Startup declaration

The service loads its model in a `lifespan` handler, not lazily on first
request. A bad artefact, a missing execution provider or a backend barred
by the licensing guard therefore fails the container at boot, where an
orchestrator can act on it — rather than surfacing as a 500 on a
student's enrolment attempt minutes after a deploy looked successful.

On every boot with a non-production-eligible backend it logs a warning.
A stub quietly running in an environment people believe is doing real
recognition is the failure mode worth shouting about.

---

## 6. Class-scoped candidate search

**A detected face is never searched against every student in the
institution.**

`findCandidateEmbeddingsForCohort(cohortId, model?)`
(`apps/web/src/modules/recognition-results/repository.ts`) is the only
function in the codebase that retrieves face-embedding candidates. There
is deliberately no unscoped variant. The scoping is enforced by the
function's signature — a caller cannot ask for a global search because no
such call exists.

This matters for:

- **Performance** — 40 candidates, not 4,000.
- **Privacy** — a classroom capture is compared only against students
  enrolled in that class.
- **Accuracy and false positives** — a smaller candidate pool means fewer
  opportunities for a near-collision.
- **Cross-class identity leakage** — a student from another section
  cannot be matched into this session's attendance at all.

The optional `model` argument narrows candidates to one model build.
Vectors from two different models (or two preprocessing versions of the
same weights) occupy unrelated spaces, so a cosine score between them is a
meaningless number that happens to fall in range — and a meaningless
number near 1.0 is a false match against a real student.

The AI service cannot widen this scope: `/v1/match` scores exactly the
candidate list it is handed, and the service has no database access to
find any others.

---

## 7. Image and biometric data handling

- **Classroom images are not permanently stored by default.** They are
  processed and discarded. Persistent retention requires an explicit
  institution policy decision; the architecture supports temporary secure
  processing, not default retention.
- Images are never written to logs, never included in error messages, and
  never returned in API responses.
- **No third-party hosted AI APIs.** Not Google Vision, not AWS
  Rekognition, not Azure Face, not any hosted face-recognition service.
  Biometric material does not leave infrastructure we run. The inference
  stack runs locally by design.
- Raw embeddings are not exposed through normal APIs (§4).
- The audit trail carries model metadata and identifiers, never vectors or
  images, so it stays safe to export and read broadly.

---

## 8. What we took from the reference repositories

### InsightFace — concepts, not code

Studied for the shape of a working pipeline. **No InsightFace code was
copied into this repository, and no InsightFace pretrained weights are
used.**

Adopted:

- **Detect → align → embed as three separable stages.** This is why the
  contract exposes landmarks between stages rather than hiding a monolith
  behind one endpoint.
- **Five-point similarity-transform alignment** onto a fixed template.
  Alignment is not cosmetic cropping; a recogniser trained on aligned
  faces degrades sharply on unaligned input, which shows up as a quiet
  accuracy loss rather than an error.
- **Cosine similarity as the comparison metric**, with a configurable
  accept threshold rather than a hardcoded one.
- **Letterbox resize preserving aspect ratio**, with detections scaled
  back to original image coordinates — the step whose omission produces
  systematically offset boxes.
- **Detection and NMS thresholds as explicit configuration.**
- **The critical detail:** ArcFace-style models emit embeddings that are
  **not** L2-normalised. Normalisation happens implicitly inside the
  similarity computation. An adapter that stores raw output and compares
  with a dot product elsewhere gets subtly wrong scores. Hence the
  interface rule that `embed()` returns a normalised vector, and the
  `embeddingNormalized` flag in `FaceModelInfo`.

Not adopted: the model zoo and auto-download mechanism (it fetches
research-only weights), the face-swapping and generation components
(irrelevant and separately restricted), the training pipeline, and the
`FaceAnalysis` orchestration class — our orchestration lives in the
provider interface and belongs to us.

### ONNX Runtime — the inference layer

Treated as the runtime, never as the algorithm.

Adopted:

- `InferenceSession` with **explicitly specified execution providers**.
  Since ONNX Runtime 1.10 the provider list must be explicit; relying on a
  default is how a deployment silently runs on CPU when a GPU was
  provisioned. `FACE_MODEL_EXECUTION_PROVIDERS` is configuration, and
  providers are tried in priority order.
- `SessionOptions` for graph optimisation level and thread counts, so a
  small VPS and a GPU box can be tuned without code changes.
- Session construction at startup, reused across requests — building a
  session per request would dominate latency.
- A warmup inference after load, so the first real request does not pay
  allocation costs.
- `IOBinding` noted as the way to avoid host↔device copies if a GPU
  deployment justifies it.

Deliberately unresolved: the ONNX Runtime documentation contains no
explicit statement about the thread-safety of concurrent `run()` calls on
one session. The scaffold records this; a real deployment must settle it
(session pool, or serialised access) before serving concurrent classroom
uploads.

Not adopted: training/fine-tuning integrations, quantisation tooling, and
the mobile/web runtimes.

---

## 9. Model licensing

Verified 2026-09-15 against official sources.

### Source code

| Component | License | Commercial use |
| --- | --- | --- |
| InsightFace **source code** | MIT | Permitted — the project states there is no limitation for academic or commercial usage |
| ONNX Runtime | MIT (Copyright © Microsoft Corporation) | Permitted |

### Pretrained weights — this is the part that blocks

InsightFace's own README states that its **training data and the models
trained on it are available for non-commercial research purposes only**,
and explicitly extends that to *both* manually downloaded models from the
GitHub repository *and* models auto-downloaded by the Python library.

Therefore:

> **`buffalo_l`, `antelopev2` and the other InsightFace pretrained model
> packs are NOT cleared for commercial use in this product.** Using them
> in production would require a separate commercial licence, obtained by
> contacting the project (`recognition-oss-pack@insightface.ai` for the
> recognition packs).

This is a hard stop, not a caution. The MIT licence on the code does not
carry over to the weights, and an open-source repository does not imply
freely usable models.

### Where that leaves us

**DEVELOPMENT MODEL** → the shipped `mock` backend. Synthetic vectors from
a hash. No real recognition, no licensing exposure, usable for evaluation
and testing of everything around the model. Any real model used for
evaluation must have a licence that permits evaluation.

**PRODUCTION MODEL** → **not selected. License verification required
before production deployment.** No model in this repository is cleared for
commercial deployment. Per the standing rule: when current commercial
licensing terms cannot be confidently determined, stop at the architecture
decision rather than proceeding quietly.

The open paths, in rough order of effort:

1. Obtain a commercial licence for InsightFace's pretrained packs.
2. Find a model whose **weights** carry a genuinely permissive licence
   (verified clause by clause, not inferred from the code's licence).
3. Train our own weights on a commercially usable dataset — highest
   effort, cleanest licence story.

Candidate evaluations and the mandatory backend log live in
`services/face-ai/app/models/LICENSING.md`. See also ADR-0006.

### The rule is enforced in code, not just prose

`MODEL_REGISTRY` entries carry `commercial_use` and a `licence_note`.
With `FACE_AI_REQUIRE_PRODUCTION_MODEL=true`, the service **refuses to
start** on a backend that is not cleared, and the error names
`LICENSING.md`. A test asserts that no shipped backend claims
`"permitted"`, so flipping a status to silence the guard fails CI instead
of shipping.

---

## 10. Where this fits the attendance workflow

Unchanged by this phase, and restated because the AI layer exists to serve
it:

```
Teacher starts session → capture → quality check → detect → align → embed
  → class-scoped vector search → confidence engine
  → PRESENT / NEEDS_REVIEW / ABSENT (advisory)
  → faculty review → faculty calls names → manual confirmation
  → final attendance
```

**AI is an assistant. Faculty remains the final authority.** `aiResult`
and `aiConfidence` are immutable once written. `finalResult` changes only
through `correctAttendanceRecord`, which records an `AttendanceCorrection`.
No AI output writes a final attendance mark directly.

---

## 11. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FACE_MODEL_BACKEND` | `mock` | Registry key of the provider to load |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `false` | Refuse to start unless the backend is licence-cleared |
| `FACE_MODEL_DIR` | unset | Directory holding ONNX weights |
| `FACE_MODEL_EXECUTION_PROVIDERS` | `CPUExecutionProvider` | Comma-separated, in priority order |
| `FACE_MODEL_INTRA_OP_THREADS` | `0` (runtime default) | Intra-op thread count |

CPU versus GPU is configuration. It is not an architectural change and
does not touch `apps/web`.

---

## 12. Known risks

| Risk | Current state |
| --- | --- |
| **Model licensing** | Blocking. No production-cleared model exists. §9. |
| **Recognition accuracy** | Unmeasured — there is no real model to measure. No accuracy claim can be made yet. |
| **Classroom image quality** | Distance, angle and lighting in a real classroom are materially harder than enrolment captures. Quality metrics are defined in the contract but not yet implemented (`unavailable`). |
| **CPU/GPU performance** | Unbenchmarked. ONNX Runtime session concurrency is an open question (§8). |
| **False matches** | Mitigated structurally by class-scoped candidates and a threshold band; not yet validated numerically. |
| **Uncertain matches** | Routed to faculty review by construction. The UNCERTAIN band's width is a policy dial that will need real data to set. |
| **Spoofing / presentation attack** | **No liveness detection exists.** A printed photo or a phone screen would not be rejected by anything in the current pipeline. Faculty presence during capture is the only control today. |
| **Privacy and biometric regulation** | Embeddings are biometric data under several regimes. Consent, retention and deletion policy are product decisions still to be made. |

---

## Related documents

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — system-wide architecture
- [`docs/adr/0002-face-ai-service-isolation-and-statelessness.md`](adr/0002-face-ai-service-isolation-and-statelessness.md)
- [`docs/adr/0005-embedding-model-swap-contract-and-licensing.md`](adr/0005-embedding-model-swap-contract-and-licensing.md)
- [`docs/adr/0006-model-provider-abstraction-and-insightface-licensing-verdict.md`](adr/0006-model-provider-abstraction-and-insightface-licensing-verdict.md)
- [`services/face-ai/app/models/LICENSING.md`](../services/face-ai/app/models/LICENSING.md) — the backend log
