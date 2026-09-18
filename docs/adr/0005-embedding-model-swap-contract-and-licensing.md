# ADR-0005: Embedding model swap contract; InsightFace licensing is unresolved

## Status

Accepted (foundation phase). No real model is selected yet — this is
intentional, not an oversight.

## Context

The product brief explicitly warns: do not assume InsightFace's pretrained
model weights are commercially free. InsightFace's inference code is
MIT-licensed, but its pretrained weights (buffalo_l, antelopev2, etc.) are
trained on datasets whose licenses are separate from the code and are not
confirmed to permit commercial deployment. Committing to a specific model
before that is verified risks having to rip it out later.

## Decision

Define an abstract `EmbeddingModel` contract (`services/face-ai/app/models/base.py`):
`load()`, `detect_and_embed(image) -> DetectedFace[]`, with `name`,
`version`, `embedding_dim` properties. `apps/web` and the rest of
`services/face-ai` depend only on this interface (and the fixed 512-d vector
shape in the REST contract), never on a specific model. Ship only a
`MockEmbeddingModel` (deterministic fake vectors, seeded from an image
hash) in this phase — no real recognition, no licensing exposure.

## Rationale

This directly implements the product requirement: "the architecture must
allow replacing the model without rewriting the attendance system."
Everything upstream of the embedding — vector search, the confidence
engine, the correction workflow — operates purely on 512-length float
arrays and has no idea which model, or even which company's model,
produced them.

## Consequences

- No attendance run in this phase does real face recognition. That's
  correct for a foundation phase; it must not be mistaken for "the pipeline
  works" in any later demo.
- Before adding a real backend: verify the weight license (not just the
  inference code's license) and record it in
  `services/face-ai/app/models/LICENSING.md`'s backend log. A backend must
  not ship to a paying customer without that entry filled in.
- If a future model has a different native embedding dimension, either
  project it to 512 inside the new `EmbeddingModel` implementation, or bump
  `FACE_AI_CONTRACT_VERSION` (`packages/shared-types/src/face-ai-contract.ts`)
  and update both the TypeScript and Pydantic schemas together — never
  silently change the dimension.
