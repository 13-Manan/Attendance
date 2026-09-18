# Embedding model licensing — read before adding a real backend

**Status: no production-cleared model exists. License verification is
required before production deployment.**

This service ships `MockEmbeddingModel` (deterministic fake vectors, no
real face recognition) and `OnnxFaceModelProvider` (a scaffold that
refuses to load without configured weights). Neither performs real
recognition; neither carries licensing exposure.

## Verified findings (2026-09-15)

Checked against the projects' own published terms.

| Component | License | Commercial use |
| --- | --- | --- |
| InsightFace **source code** | MIT | **Permitted.** The project states there is no limitation for academic or commercial usage. |
| InsightFace **training data and pretrained models** | Non-commercial research only | **NOT permitted.** |
| ONNX Runtime | MIT (© Microsoft Corporation) | **Permitted.** |

InsightFace's README states that its training data and the models trained
on it are available for non-commercial research purposes only, and
explicitly extends that to *both* models downloaded manually from the
GitHub repository *and* models auto-downloaded by the Python library.

> **`buffalo_l`, `antelopev2` and the other InsightFace pretrained packs
> are NOT cleared for commercial use in this product.** Production use
> would require a separate commercial licence, obtained by contacting the
> project (`recognition-oss-pack@insightface.ai` for the recognition
> packs; `contact@insightface.ai` for inswapper).

The MIT licence on the code does **not** carry over to the weights. An
open-source repository does not imply freely usable models. Do not
reintroduce this assumption.

ONNX Runtime is the inference **runtime**, not a face-recognition model.
Its MIT licence says nothing about the licence of any model you run on it.

## Rules

- Any backend added here must have its **weights** licence explicitly
  verified — not the inference code's licence — and the verification
  recorded in the backend log below before it reaches any paying customer.
- The `FaceModelProvider` interface in `base.py` exists so a model can be
  swapped without touching `apps/web`. The Next.js side depends only on a
  fixed-length embedding vector, the shared `FaceQualityAssessment`
  vocabulary and the normalized match statuses — never on a specific model.
- This rule is enforced in code, not only here: `MODEL_REGISTRY` in
  `app/config.py` carries each backend's `commercial_use` status, and with
  `FACE_AI_REQUIRE_PRODUCTION_MODEL=true` the service refuses to start on
  an uncleared backend. A test asserts that no shipped backend claims
  `"permitted"`, so flipping a status to silence the guard fails CI.

## Selection checklist

Before wiring a backend into `FACE_MODEL_BACKEND`, fill in each row of the
backend log below with:

- **Model** — the exact model name/family (e.g. `arcface-r100`,
  `facenet-vggface2`, `mobilefacenet`).
- **Model version** — a specific weights release, tag, or commit — never
  "latest".
- **Weights source** — direct link to the downloaded artifact.
- **Weights license** — the license of the WEIGHTS, not the inference
  code. If the license is unclear, treat that as "not verified".
- **Commercial-use status** — one of: `permitted`, `research-only`,
  `unclear` (do not deploy). Include the specific clause consulted.
- **Replacement strategy** — how a future swap is triggered if the license
  changes or a better weights license becomes available. Every backend in
  the log must document this so we never have a "stuck" backend.
- **Verifier** — the person who confirmed the license, and the date.
- **Limitations** — what the model is documented or measured as being bad
  at. See the next section; this is not optional.

If any row is `unclear` or empty, DO NOT wire that backend as the default
via `FACE_MODEL_BACKEND=<name>`; keep it behind a feature flag or in a
research-only build. The service must fail to start if `FACE_MODEL_BACKEND`
selects a backend that lacks a `Commercial use permitted?` entry.

## Backend log

| Backend name | Model | Model version | Weights source | Weights license | Commercial use permitted? | Replacement strategy | Verifier · date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mock` | Deterministic hash → normalized vector | 0.1.0+pp1 | N/A — synthetic | N/A | `not-applicable` — never for production recognition | Replace with a licensed real model before any paying customer sees the product. | Phase 3 (this repo) |
| `onnx` | *(none configured)* | `unconfigured` | Set by `FACE_MODEL_DIR` at deploy time | **Unknown — depends entirely on which weights are placed in `FACE_MODEL_DIR`** | `unclear` — refuses to load without weights; not production-eligible | The scaffold is the replacement mechanism: point it at different weights and bump `weights_version`. Fill in this row before wiring it as the default. | Phase 3.1 — scaffold only, no weights verified |

## Documented limitations

A licence answers "may we use this model". It does not answer "on whom does
it fail". Both must be recorded before a backend serves real attendance,
because an undocumented failure mode becomes an accusation against a student.

For each backend, record in the limitations log below:

1. **Training-data population** — what the weights were trained on, and
   therefore whom they have seen least of. Face recognition error rates are
   well documented as varying across demographic groups; a model whose
   training distribution is unknown is a model whose error distribution is
   unknown.
2. **Measured weak conditions** — from an actual benchmark run
   ([`../../bench/README.md`](../../bench/README.md)), not from the model
   card: distance, lighting, occlusion, angle, eyewear. Report the per-slice
   numbers, not just the overall figure.
3. **Input constraints** — minimum usable face size in pixels, expected
   colour space, alignment requirement. A classroom back row that falls below
   the minimum face size is a detection problem no threshold can fix.
4. **Known failure modes** — twins and siblings, heavy occlusion, masks,
   significant appearance change since enrolment, motion blur.
5. **What was never tested** — carried over from the benchmark's coverage
   gaps. An untested condition is a limitation, not a pass.

These feed the product's own safeguards: uncertain matches route to faculty
review rather than being resolved silently, and the ambiguity margin exists
precisely for the twins/siblings case. See
[`docs/RECOGNITION_ENGINE.md`](../../../../docs/RECOGNITION_ENGINE.md).

### Limitations log

| Backend | Training-data population | Measured weak conditions | Input constraints | Known failure modes | Never tested |
| --- | --- | --- | --- | --- | --- |
| `mock` | None — no training occurred. Embeddings are a SHA-256 hash of the image bytes. | Not applicable. Two photos of the same person produce unrelated vectors, so real-world recognition rate is ~0%. | None — image bytes are never decoded. | Everything. It recognises nobody, by construction. | Everything. Never benchmark a product decision against it. |
| `onnx` | Unknown — depends entirely on the weights placed in `FACE_MODEL_DIR`. Record before deploying. | **Unmeasured.** No benchmark run exists. | Set by the loaded model; the scaffold does not assume. | Unknown. | Everything. |

## Candidate real backends — evaluate before choosing

The list below is guidance only. Filling in the table above is what
actually authorizes a backend.

- **facenet-pytorch (Inception ResNet v1, VGGFace2 weights)** — inference
  code is MIT; VGGFace2's dataset was withdrawn by the publishers,
  so weights derived from it are best treated as research-only until a
  legal review confirms otherwise.
- **InsightFace (arcface, buffalo_l/antelopev2)** — **resolved: code MIT,
  weights non-commercial research only.** See the verified findings above.
  Do not productionize these weights without a commercial licence in
  writing. The code remains a valid reference for technique.
- **MobileFaceNet on a training-from-scratch pipeline using a
  commercially-licensed dataset (e.g. WebFace260M under its research
  license, or a proprietary dataset)** — the "own weights" path. Highest
  effort, cleanest license story.
- **Managed API (AWS Rekognition, Azure Face, Google Cloud Vision)** —
  **currently out of scope by product decision.** Third-party hosted face
  recognition is not to be introduced without explicit approval: it sends
  biometric material off our infrastructure, adds per-request cost, and
  changes the privacy posture the product is built around. Listed here
  only so the option is not silently forgotten.

If the model license is not suitable, stop before productionizing that
model. Ship the mock in staging and keep the recognition pipeline behind
a feature flag until the licensing question is settled.

## Development vs production

**DEVELOPMENT MODEL** — the `mock` backend, or any real model whose licence
explicitly permits evaluation and testing. Evaluation use does not imply
deployment rights; check the clause, not the repository.

**PRODUCTION MODEL** — must have explicit commercial-use rights or an
appropriate commercial licence, verified and recorded in the backend log
above. **None currently qualifies.**

## Contract stability across a swap

- Embedding dimension is fixed at 512 (see `EMBEDDING_DIMENSION` in
  `packages/shared-types/src/face-ai-contract.ts`). A backend with a
  different native dim must project into 512 (learned projection or
  linear) — a schema change to the pgvector column is a Phase-boundary
  event, not a per-backend detail.
- The quality vocabulary (`FaceQualityReason`) is authoritative. Real
  models must map their own error modes onto these reasons; a new reason
  is a contract bump.
- Store `modelName` and `modelVersion` on every FaceEmbedding row so a
  future re-enrollment migration can identify which rows need
  regeneration after a backend change.
- `modelVersion` is the composite `<weights_version>+pp<preprocessing_version>`.
  A preprocessing change (decode, crop, alignment template, resize,
  channel order, normalisation) invalidates stored vectors exactly as a
  weights change does, so both move the identifier that decides which
  vectors are comparable. Bump `preprocessing_version` when you change any
  of them.
- Vectors are only comparable within one `modelName` + `modelVersion`.
  `findCandidateEmbeddingsForCohort` in `apps/web` takes an optional model
  filter for this reason. A model swap means re-enrolling every student —
  plan it as a migration, not a config change.
