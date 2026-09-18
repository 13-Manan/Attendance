# ADR-0006: Full model-provider abstraction; InsightFace pretrained weights are research-only

## Status

Accepted (Phase 3.1). Supersedes the licensing portion of
[ADR-0005](0005-embedding-model-swap-contract-and-licensing.md), which
recorded InsightFace's weight licensing as "not confirmed". It is now
confirmed, and the answer is no.

## Context

Two questions were open after Phase 3.

**First: is InsightFace usable commercially?** ADR-0005 flagged the
question but left it hedged. A hedge is not a decision — it is something
that gets forgotten and then discovered late, in production, by a customer
or a lawyer.

**Second: was the abstraction real?** ADR-0005's `EmbeddingModel`
interface had a single pipeline method, `detect_and_embed()`. That is
enough to swap a stub, but it hides detection, alignment, quality and
comparison inside one call. A real backend would have had nowhere to
expose landmarks, so alignment — the step that most affects accuracy —
would have had to happen implicitly, and `/v1/detect` and `/v1/embed`
would each have re-run detection independently.

Separately, `/v1/match` returned the top-scoring candidate unconditionally.
No threshold existed anywhere in either language. Nothing structurally
prevented a similarity of 0.11 from being read as a match.

## Decision

### 1. InsightFace pretrained weights are not a production option

InsightFace's README states that its training data and the models trained
on it are available for **non-commercial research purposes only**, and
explicitly applies this to both manually downloaded models and models
auto-downloaded by the Python library. `buffalo_l`, `antelopev2` and the
other packs are therefore **not** cleared for this product. The MIT licence
covers the source code only.

The InsightFace *code* remains a legitimate reference for technique, and
the pipeline concepts it demonstrates are adopted (independently
implemented) — see `docs/FACE_AI_ARCHITECTURE.md` §8.

**No production model is selected. License verification is required before
production deployment.**

### 2. Widen `EmbeddingModel` into `FaceModelProvider`

`detect() / assess_quality() / align() / embed() / detect_and_embed() /
compare_embeddings() / model_info()`, with declarative provenance
(`name`, `weights_version`, `preprocessing_version`, `runtime`,
`commercial_use`). `EmbeddingModel` survives as an alias so existing
routers are untouched.

`compare_embeddings` and `model_info` are concrete: how two vectors are
scored, and how provenance is composed, are not decisions a backend gets
to make differently.

### 3. Carry landmarks across the contract

Detection returns 5-point landmarks; `/v1/embed` accepts them. Bounding
boxes are documented as pixel coordinates, origin top-left.

### 4. Normalise match outcomes

`MATCHED / UNCERTAIN / UNMATCHED`, with thresholds supplied by `apps/web`
(institution policy) and echoed back in the response. `UNCERTAIN` maps to
`NEEDS_REVIEW`, never `PRESENT`.

### 5. Make the licensing rule mechanical

`MODEL_REGISTRY` entries carry `commercial_use` and `licence_note`. With
`FACE_AI_REQUIRE_PRODUCTION_MODEL=true` the service refuses to start on an
uncleared backend. A test asserts no shipped backend claims `"permitted"`.

### 6. Load the model at startup

A `lifespan` handler primes the provider, so a bad artefact fails the
container rather than a student's enrolment.

## Rationale

The licensing verdict had to be reached now, because it is the kind of
finding that is cheap to act on during a foundation phase and extremely
expensive to act on after a recognition pipeline, a threshold calibration
and an enrolled student population have all been built on top of a model
we cannot ship.

The interface had to widen now for the same reason. An abstraction is only
proven by a second implementation, and the shape of the second
implementation — a real ONNX recogniser needing landmarks between stages —
is what revealed that the first interface was too narrow. Discovering that
during Phase 5 would have meant changing the wire contract after
`apps/web` depended on it.

Encoding the licence status in the registry rather than only in prose
follows from the same reasoning: a rule that lives in a Markdown file is
followed until someone is in a hurry.

## Consequences

- Recognition remains a stub. Phase 4 can be built against the contract,
  but no demo may be described as working recognition.
- Sourcing a licence-clean model is now an explicit, tracked prerequisite
  for production — not a detail to resolve later.
- `modelVersion` is a composite `<weights>+pp<preprocessing>`. Full
  provenance with no schema change, at the cost of a parsing convention
  that must be documented wherever the column is read.
- Stored embeddings are only comparable within one `modelName` +
  `modelVersion`. `findCandidateEmbeddingsForCohort` takes an optional
  model filter for this; a model swap requires re-enrolment of every
  student, which is a migration event to plan, not a background detail.
- The 512-d embedding dimension remains fixed. A model with a different
  native dimension must project into 512, or the pgvector column changes —
  a phase-boundary event.
