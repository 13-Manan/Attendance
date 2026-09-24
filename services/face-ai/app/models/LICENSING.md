# Embedding model licensing — read before adding a real backend

**Status: no production-cleared model exists. License verification is
required before production deployment.**

This service ships three backends:

- `MockEmbeddingModel` — deterministic fake vectors, no real recognition.
- `OnnxFaceModelProvider` — a scaffold that refuses to load without weights.
- `OpenCVFaceModelProvider` — **real recognition** (YuNet + SFace). Added in
  Phase 5. It is **not production-eligible**: `commercial_use = "unclear"`,
  so `FACE_AI_REQUIRE_PRODUCTION_MODEL=true` refuses to start on it.

The third one is the one with licensing exposure, and the reason it is still
`unclear` is recorded below. It is usable for local development and evaluation
and must not serve a paying customer until that entry changes.

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
| `opencv` | YuNet (detector) + SFace (recogniser), via OpenCV | `yunet-2023mar+sface-2021dec+pp1` | `face_detection_yunet_2023mar.onnx` sha256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` (232,589 B) from [HF opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet); `face_recognition_sface_2021dec.onnx` sha256 `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` (38,696,353 B) from [HF opencv/face_recognition_sface](https://huggingface.co/opencv/face_recognition_sface) | **Weights:** YuNet MIT (© 2020 Shiqi Yu); SFace Apache-2.0. Both directories state the licence covers all files in them, including the `.onnx`. **Training data:** YuNet on WIDER Face (CC BY-NC-ND 4.0 / academic-only per CUHK terms); SFace's upstream names CASIA-WebFace, VGGFace2 and MS-Celeb-1M — all research-restricted or withdrawn — and **which one produced this artefact is not documented anywhere**. | **`unclear` — NOT permitted.** The weight licences are permissive; the training-data provenance behind the distributed SFace artefact is unresolved for commercial biometric use, and a permissive licence applied downstream does not resolve whether the upstream corpus permitted commercial derivation. | Swap the recogniser for one with documented, commercially-usable training data, or obtain written clearance for this artefact. Both are pinned by SHA-256 in `app/models/model_files.py`; changing either forces a `weights_version` bump and full re-enrollment. | Phase 4.5 audit — technical facts verified from the model graphs and OpenCV source; **licensing question referred, not resolved** |
| `azure` | Azure AI Face, managed by Microsoft: `detection_03` + `recognition_04` | `detection_03.recognition_04+pp1` | None shipped or run here. The model runs in Microsoft's service; this container calls it over HTTPS with the resource key (`AZURE_FACE_ENDPOINT`, `AZURE_FACE_KEY`). | Microsoft Product Terms for Azure AI services, under the subscription that owns resource `attendance-azure-face`. | **`permitted`** for detection. **Identification and verification are Limited Access features** that need Microsoft's separate approval ([aka.ms/facerecognition](https://aka.ms/facerecognition)). That gate is checked live (`identification` on `/v1/model-info`), not assumed. As of 2026-09-24 the resource answers `403 UnsupportedFeature`, so production detects faces and identifies nobody. | Templates live in Azure LargePersonGroups, one per class (`att-<cohortId>`), and cannot be moved to another backend. Switching away means re-enrolling every student under the new backend. | 2026-09-24 — detection verified live; identification **pending Microsoft approval** |

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
| `opencv` | **Not documented for the distributed artefact.** Upstream names CASIA-WebFace / VGGFace2 / MS-Celeb-1M as the SFace project's datasets; which trained `2021dec` is unstated. Demographic composition therefore unknown, and so is the demographic error distribution. | **Calibrated on adult portraits only** (2026-09-24, 61 public-domain pairs + 89 singles; [`docs/FACE_RECOGNITION_CALIBRATION.md`](../../../../docs/FACE_RECOGNITION_CALIBRATION.md)): rank-1 61/61, 0 of 9,089 impostors ≥ 0.45, 96.7% genuine ≥ 0.62. Weak under synthetic degradation: faces < 28 px, over-exposure > ~210, heavy blur. No classroom data. Upstream's published figures — SFace 0.9940 on LFW, YuNet 0.7503 AP on WIDER "hard" — are benchmarks on curated datasets and say nothing about this product. | Aligned 112×112 BGR crop, raw 0–255 values. YuNet is documented as detecting faces roughly 10×10 to 300×300 px, so both a back row and a close-up front row can fall outside it. Enrolment additionally refuses faces under `ENROLLMENT_PROFILE.min_face_px` (64 px, `app/quality.py`), or `face_min_enrolment_face_pixels` when set. | Unknown for this artefact. Generally for this model family: twins and siblings, heavy occlusion, masks, large appearance change since enrolment, motion blur, extreme pose. | Children, turned heads (pose limits are estimates), relatives in one class, demographic error rates, real classroom photos. Thresholds are calibrated on adults only. |
| `azure` | Microsoft does not publish the training population. Its [transparency note](https://learn.microsoft.com/legal/cognitive-services/face/transparency-note) documents demographic evaluation at a high level only. | **Unmeasured on this product's photos.** Identification could not be exercised: it is not approved for this resource. Detection verified on public-domain adult portraits. | Faces at least 36 px for detection. This backend enrols only faces Azure rates `qualityForRecognition: high` and at least 100 px, and never sends `low`-quality classroom faces to Identify. At most 10 faces per Identify request; larger classes are batched. | Documented by Microsoft: children, strong pose, occlusion, masks and poor lighting reduce accuracy. Confidence is not a probability and is not comparable with the embedding backends' similarity. | Children, real classroom photos, the confidence thresholds used in apps/web (0.75 present / 0.5 review, uncalibrated). |

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

- Embedding dimension is fixed at **128** (see `EMBEDDING_DIMENSION` in
  `packages/shared-types/src/face-ai-contract.ts`), which is SFace's native
  output width. It was 512 until Phase 5 — a placeholder chosen before any
  model was. A backend with a different native dim needs a contract and schema
  change, which is a Phase-boundary event, not a per-backend detail. Projecting
  or padding into a wider vector was considered and rejected: it adds no
  information and multiplies the cost of every comparison.
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
