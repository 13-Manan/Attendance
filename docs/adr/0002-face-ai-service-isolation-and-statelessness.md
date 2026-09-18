# ADR-0002: Face AI service is stateless and DB-less

## Status

Accepted (foundation phase).

## Context

The recognition pipeline needs face detection, alignment, embedding, and a
class-scoped nearest-neighbor search. Face inference wants Python (ONNX
Runtime); the rest of the product is Next.js/TypeScript. Where does the
line between them go?

## Decision

`services/face-ai` does image → detect → align → embed only, over a private
REST contract (`POST /v1/detect-embed`), and nothing else. It holds no
database credentials and never runs the vector similarity search.
`apps/web` performs the pgvector nearest-neighbor query (via
`prisma.$queryRaw`, scoped to the session's cohort) and applies the
confidence engine (`modules/recognition-results`) to turn a similarity score
into Present/Absent/Needs-Review.

## Rationale

- **Swappability**: because the Python service is a pure function (image
  in, embedding out) with no side effects and no schema dependency,
  replacing the embedding model — required given the InsightFace licensing
  uncertainty (ADR-0005) — never touches `apps/web`.
- **Attack surface**: a service with no DB credentials that only accepts
  images and returns vectors is a much smaller target than one with
  read/write Postgres access.
- **Where policy lives**: confidence thresholds, and the definition of
  Present/Absent/Needs-Review, are product decisions that vary per
  institution (`Institution.settings.confidenceThresholds`). Keeping that
  logic in TypeScript alongside the rest of the attendance domain avoids
  splitting product policy across two languages.

## Consequences

- Every recognition request costs one extra network hop
  (Next.js → Python → Next.js) compared to doing everything in one process.
  Acceptable: this runs once per classroom session, not per request.
- `services/face-ai` can be scaled/deployed independently and stays trivial
  to unit test (pure function in, structured data out).
