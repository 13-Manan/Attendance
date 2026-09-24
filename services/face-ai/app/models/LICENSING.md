# Embedding model licensing — read before adding a real backend

**Status: a production-cleared backend exists.**
`azure_detection_own_recognition` was verified and cleared on 2026-09-24 and
is what production runs. One residual question about its training data has
been **referred to legal review** and is recorded below; it is not resolved,
and nothing in this repository may describe it as resolved. Every other
backend that runs weights in this container is still uncleared, and the rule
that a backend's **weights** licence must be verified and written into the log
below before it serves anybody is unchanged.

This service ships five backends:

- `MockEmbeddingModel` — deterministic fake vectors, no real recognition.
- `OnnxFaceModelProvider` — a scaffold that refuses to load without weights.
- `OpenCVFaceModelProvider` — **real recognition** (YuNet + SFace). Added in
  Phase 5. It is **not production-eligible**: `commercial_use = "unclear"`,
  so `FACE_AI_REQUIRE_PRODUCTION_MODEL=true` refuses to start on it.
- `AzureFaceModelProvider` — Azure AI Face for both detection and
  identification. Detection is permitted under the subscription;
  identification is a Limited Access feature that was never approved for this
  resource, so the backend detected faces and identified nobody. Superseded by
  the one below, which does not need that approval at all.
- `AzureDetectionOwnRecognitionProvider` — **what production runs.** Azure AI
  Face is asked one question per image (*where are the faces, and where are
  their landmarks*); everything that decides *who* a face belongs to happens
  in this process, on weights that are in the public domain. Cleared:
  `commercial_use = "permitted"`.

`opencv` is the backend with unresolved licensing exposure, and the reason it
is still `unclear` is recorded below. It is usable for local development and
evaluation and must not serve a paying customer until that entry changes.

This file is the policy — how a backend gets cleared at all, and the log of
every backend that has been through it. The full audit of the one that is
actually shipping, stage by stage and dependency by dependency, is
[`../../docs/MODEL_LICENSES.md`](../../docs/MODEL_LICENSES.md); how the
pipeline works is [`../../docs/RECOGNITION.md`](../../docs/RECOGNITION.md).

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
  an uncleared backend. A test (`tests/test_provider_contract.py`) pins the
  set of backends allowed to claim `"permitted"` to exactly the two that have
  been through this log, and asserts that no other backend claims it — so
  flipping a status to silence the guard fails CI, and clearing a backend is
  an edit to the test and to this file together rather than a single flag
  flip.

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
| `azure` | Azure AI Face, managed by Microsoft: `detection_03` + `recognition_04` | `detection_03.recognition_04+pp1` | None shipped or run here. The model runs in Microsoft's service; this container calls it over HTTPS with the resource key (`AZURE_FACE_ENDPOINT`, `AZURE_FACE_KEY`). | Microsoft Product Terms for Azure AI services, under the subscription that owns resource `attendance-azure-face`. | **`permitted`** for detection. **Identification and verification are Limited Access features** that need Microsoft's separate approval ([aka.ms/facerecognition](https://aka.ms/facerecognition)). That gate is checked live (`identification` on `/v1/model-info`), not assumed. As of 2026-09-24 the resource answers `403 UnsupportedFeature`, so this backend detects faces and identifies nobody. | Templates live in Azure LargePersonGroups, one per class (`att-<cohortId>`), and cannot be moved to another backend. Switching away means re-enrolling every student under the new backend. **Superseded** by `azure_detection_own_recognition`, which is the switch that was made. | 2026-09-24 — detection verified live; identification **never approved for this resource**, and nothing in production waits on it any more |
| `azure_detection_own_recognition` | **What production runs.** Azure AI Face `detection_03` for detection and landmarks *only*; `dlib_face_recognition_resnet_model_v1` — dlib's ResNet, 128-d and L2-normalised — for alignment and recognition, in this container. Identify, Verify and the PersonGroup APIs are never called, so nothing here waits on Microsoft's Limited Access approval. | `dlib-models-2a61575+pp1+al1.detection_03`, i.e. `<weights>+pp<preprocessing>+al<alignment>`. The alignment component carries Azure's detection model because the landmarks *are* part of the alignment: if Microsoft changes `detection_03`, the chips change and the templates stop being comparable. | **Detector:** nothing is downloaded or run here — Microsoft operates the model and this container calls it over HTTPS (`AZURE_FACE_ENDPOINT`, `AZURE_FACE_KEY`). **Recogniser:** [`dlib_face_recognition_resnet_model_v1.dat.bz2`](https://github.com/davisking/dlib-models/raw/2a61575dd45d818271c085ff8cd747613a48f20d/dlib_face_recognition_resnet_model_v1.dat.bz2), commit `2a61575` of davisking/dlib-models. Archive sha256 `abb1f61041e434465855ce81c2bd546e830d28bcbed8d27ffbe5bb408b11553a` (21,428,389 B); decompressed `.dat` sha256 `55533b28a95800a551ba546ba62fe69625c7e95a7061c338adffead08719da30` (22,466,066 B). Both pinned in `app/models/model_files.py`, baked into the image at `/srv/models`, and re-verified at every startup so a layer altered after the build does not serve. | **Weights: public domain**, by the author's explicit statement in the dlib-models README — *"anyone can do whatever they want with these model files as I've released them into the public domain"* — in a repository licensed CC0-1.0. **Library:** dlib 20.0.1 under the **Boost Software License 1.0**, which imposes no notice requirement on the binary form this image ships. **Detector:** Microsoft Product Terms for Azure AI services. **No licence key, API key, registration or approval is required for the model.** The one credential in the system is the Azure resource key, and that buys detection as a service, not a licence to a model. | **`permitted`**, on the strength of the licence actually granted for every artefact shipped. **One question is referred, not answered:** about half the recogniser's training images came from FaceScrub (CC BY-NC-ND 3.0) and VGG Face (CC BY-NC 4.0), and whether a non-commercially licensed *dataset* restricts commercial use of a *model* trained on it is an unsettled question of law rather than a defect in the licence we were granted. It is not a question for an engineer. Flagged here, in the registry entry in `app/config.py`, in the embedder's stage descriptor on `/v1/model-info`, and in [`../../docs/MODEL_LICENSES.md`](../../docs/MODEL_LICENSES.md). **Do not record it anywhere as resolved.** | The weights are one checksum-pinned artefact behind one `MODEL_REGISTRY` entry. Replacing them changes `weights_version`, therefore `modelVersion`, which flips every stored template to `NEEDS_REENROLLMENT` automatically rather than silently mixing model versions — the mechanism, not a manual step. The detector, the alignment, the calibration machinery and every line of `apps/web` stay exactly as they are. Templates are our own vectors in our own database, so a swap is a re-enrolment and never an extraction from somebody else's service. | 2026-09-24 — this deployment. Weights licence read from the dlib-models README and the repository's LICENSE; Boost 1.0 from LICENSE.txt in the pinned sdist; checksums by `scripts/fetch_models.py`, which fails the build on any mismatch; Azure's detection-only posture verified live against the production resource (Detect without `returnFaceId` → 200, every Identify-family call → `403 UnsupportedFeature`). Training-data position **REFERRED** to legal review. |

### The one open licence question, recorded rather than buried

The production backend is cleared, and there is exactly one thing about it
that is not settled. The dlib-models README says about half the recogniser's
training images came from VGG Face and FaceScrub, and both of those research
corpora carry non-commercial licences — CC BY-NC 4.0 and CC BY-NC-ND 3.0
respectively.

The weights themselves were released into the public domain by the person who
trained them, and using them requires no permission from him. What is unsettled
is the separate question of whether a non-commercially licensed *dataset* can
reach through a trained model and restrict its commercial use. That is a
question of law on which reasonable lawyers disagree, and it is not one an
engineer should decide by writing a sentence in a licence file.

**The position taken here, deliberately:** the backend is marked `permitted`
on the strength of the licence granted for the artefact we actually ship, and
the question is written down — here, in `app/config.py`, on `/v1/model-info`
and in [`../../docs/MODEL_LICENSES.md`](../../docs/MODEL_LICENSES.md) — so that
it is visible rather than buried. **It is referred to legal review and it is
open.** If that review comes back negative, the replacement strategy in the log
above is the whole of the work: one pinned artefact, one registry entry, and a
`modelVersion` bump that re-enrols everybody.

This is the same standard that keeps `opencv` out of production. Its SFace
artefact has permissive licence files and an *undocumented* training corpus,
which is less evidence than we have here, not more.

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
| `azure_detection_own_recognition` | **Recogniser:** the author's README says about half the images came from VGG Face and FaceScrub, 7,485 identities in total, with no overlap with LFW. Both of those corpora are non-commercially licensed — the referred question above. Neither their demographic composition nor the other half's is published, so the demographic error distribution of these weights is **unknown**, as it is for every backend whose training set is undocumented. The author publishes 0.993833 on LFW; **that is a curated academic benchmark of public figures and it says nothing about this product**, which photographs children in classrooms. **Detector:** Microsoft does not publish Azure's training population either. | **Measured for this deployment on public-domain adult portraits** — not on classroom photographs and not on children ([`../../docs/CALIBRATION.md`](../../docs/CALIBRATION.md)). The thresholds derived from it are **provisional**. Two corpora: A (212 images, 61 genuine pairs) and B (142 images, 40 genuine pairs, every impostor comparison between two South Asian adults — the harder and more relevant set, and the one the thresholds were set from). Corpus B clean: rank-1 40/40, genuine minimum 0.9032, impostor maximum 0.9453, **0** impostors at or above the present knot (raw 0.955), 22 of 40 auto-present. Degraded, the system stops claiming rather than starts guessing: resampled to 64 px wide, 14 present and 23 to review; at 48 px, 7 present; at 64 px with a Gaussian blur of 1.2, and again at 36 px, **nothing** is auto-marked present at all and rank-1 falls to 38/40. **Across every condition 0 faces were wrongly marked present, and none of the 62 strangers was ever marked present.** At 36 px the smallest genuine margin is **−0.0077** — the wrong person outscored the right one on one probe — caught by the present knot and the raw ambiguity margin rather than by luck. Occlusion (Corpus A): mouth covered, rank-1 57/61; eyes covered, 56/61; 0 wrongly present in both. Corpus B was then re-run end to end through the production path — re-encoded payloads, live Azure Detect — and **every decision was identical**: 0 impostors at or above the present knot, 0 strangers marked present, the same 22/16/2. Rank-1 moved to 39/40; that one probe scores below the review floor and is reported as an unknown face rather than attributed to anybody. | A face whose shorter side is under **32 px** (`MIN_EMBEDDABLE_FACE_PX`) is reported `face_too_small` and never embedded — upscaling a smaller face invents the detail the network keys on. Recognition needs Azure's landmarks: a face whose landmarks are not plausibly a face is reported `alignment_failed` and is **never embedded from an unaligned crop**, because a chip the network did not expect yields a vector that is confidently wrong. The chip is a 150×150 similarity-transform crop aligned on dlib's own 5-point template and cut from the **full-resolution original**; the fifth point is derived from Azure's nostril out-tips with an offset measured over 151 portraits. Images are re-encoded as JPEG before they reach Azure, and an image beyond Azure's limits (4096 px on a side, 6 MB) is scaled down for detection only. | Twins and siblings, heavy occlusion, masks, large appearance change since enrolment, motion blur and extreme pose — the usual set for this model family, none of them measured here. Small faces, quantified in the degradation table above. Separately: a template written by a different build is not comparable with a current one, which is a deployment failure mode rather than a model one and is handled by `modelVersion` filtering rather than by hope. | **Children** — both corpora are adults, and this product is deployed in schools. **Real classroom photographs** — every probe is a portrait degraded synthetically, one condition at a time, where a real capture combines motion blur, mixed lighting within one frame, turned heads and students occluding one another. **Twins and siblings**, the case the ambiguity margin exists for. Glasses as a variable. Per-group error rates: Corpus B holds a handful of people per group and **no Pakistani men at all**, so no demographic number from it should be quoted. And sample size: 40 genuine pairs cannot establish a false-accept rate at the scale a school needs. |

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
  hosted face *recognition* remains out of scope without explicit approval:
  it sends biometric material off our infrastructure, adds per-request cost,
  and changes the privacy posture the product is built around. What production
  actually does is narrower and was approved on those terms: a managed service
  is used for **detection**, and the recognition — the part that decides who
  somebody is — runs on our own weights in our own container, so no face
  template ever leaves our infrastructure. The distinction is the whole reason
  `azure_detection_own_recognition` exists rather than `azure`.

If the model license is not suitable, stop before productionizing that
model. Ship the mock in staging and keep the recognition pipeline behind
a feature flag until the licensing question is settled.

## Development vs production

**DEVELOPMENT MODEL** — the `mock` backend, or any real model whose licence
explicitly permits evaluation and testing. Evaluation use does not imply
deployment rights; check the clause, not the repository.

**PRODUCTION MODEL** — must have explicit commercial-use rights or an
appropriate commercial licence, verified and recorded in the backend log
above. **`azure_detection_own_recognition` qualifies, and it is what
production runs.** Its detector operates under the subscription's product
terms, its recogniser's weights were released into the public domain by the
person who trained them, and dlib itself is Boost 1.0 — no licence key, no
registration, no approval for any of it, and no waiting on Microsoft.

That clearance is about the licences granted for the artefacts shipped. It is
not a statement that the training-data question is closed: that is referred to
legal review and stays open until somebody qualified closes it. And it is not
an accuracy claim — the thresholds it runs on were measured on adult
portraits, never on a classroom and never on a child.

`mock`, `onnx` and `opencv` remain exactly what they were, and
`FACE_AI_REQUIRE_PRODUCTION_MODEL=true` still refuses to start on any of them.

## Contract stability across a swap

- Embedding dimension is fixed at **128** (see `EMBEDDING_DIMENSION` in
  `packages/shared-types/src/face-ai-contract.ts`), which is SFace's native
  output width and, as it happens, the dlib recogniser's as well — so the
  move to `azure_detection_own_recognition` needed no contract change. It was
  512 until Phase 5 — a placeholder chosen before any model was. A backend with a different native dim needs a contract and schema
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
  of them. A backend whose alignment depends on a *third party* — as
  `azure_detection_own_recognition`'s does, because Azure supplies the
  landmarks the chip is cut from — carries a third component,
  `+al<alignment_version>`, so that a change to the detection model moves the
  identifier too. `FaceEmbedding.alignmentVersion` (nullable, migration
  `20260924180000_face_embedding_alignment_version`) stores that component on
  its own, so "which templates need re-enrolling" can be answered without
  parsing the composite string.
- Vectors are only comparable within one `modelName` + `modelVersion`.
  `findCandidateEmbeddingsForCohort` in `apps/web` takes an optional model
  filter for this reason. A model swap means re-enrolling every student —
  plan it as a migration, not a config change.
