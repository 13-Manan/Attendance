/**
 * CLASS-SPECIFIC SEARCH — how the candidate scan scales, and what the
 * database actually costs.
 *
 * The brief asks for 50 / 500 / 5,000 enrolled students and insists search
 * stay class-scoped. Before measuring, it is worth being precise about what
 * is being measured, because the architecture makes one of those numbers
 * hypothetical:
 *
 *   `findCandidateEmbeddingsWithVectorsForCohort` loads the ACTIVE templates
 *   of the students enrolled in ONE cohort and scores them in-process. It
 *   deliberately does not use pgvector's `<=>` operator (see the comment on
 *   the query). So the pool size on the hot path is the class size — 50, or
 *   100 in a large lecture — and never the institution's whole student body.
 *
 * 500 and 5,000 are therefore measured here as *stress* points, answering
 * "what would it cost if the scope were ever widened" — which is exactly the
 * evidence needed to answer the DATABASE question without guessing.
 *
 * Two costs are separated, because they have very different fixes:
 *
 *   PARSE  — `embedding::text` comes back as "[0.1,0.2,...]" and is parsed
 *            into a number[] per candidate. 512 `Number()` calls per row.
 *   SCAN   — the cosine loop in `scoreFaceAgainstCandidates`.
 *
 * If parse dominates, the answer is a binary transfer format or a `<=>`
 * pre-filter, not a different database. Measuring them apart is the only way
 * to know which.
 */

import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import { scoreFaceAgainstCandidates } from "../../src/modules/recognition-engine/service.ts";
import type {
  CandidateTemplate,
  RecognitionPolicy,
} from "../../src/modules/recognition-engine/types.ts";
import {
  DEFAULT_AMBIGUITY_MARGIN,
  DEFAULT_MIN_DETECTION_CONFIDENCE,
} from "../../src/modules/recognition-engine/types.ts";
import { parsePgVectorLiteral } from "../../src/modules/recognition-results/repository.ts";
import { makeRng, randomUnitVector, summarise, vectorAtCosine } from "./synthetic.ts";

/** The shipped plumbing defaults. No dataset has validated these — that is
 * the whole point of Phase 12 — but the scan cost does not depend on them. */
const POLICY: RecognitionPolicy = {
  presentMin: 0.62,
  reviewMin: 0.45,
  ambiguityMargin: DEFAULT_AMBIGUITY_MARGIN,
  minDetectionConfidence: DEFAULT_MIN_DETECTION_CONFIDENCE,
};

export const POOL_SIZES = [50, 100, 500, 5000] as const;

/** Faces in one classroom photograph. A face is scored against every
 * candidate, so the real per-image cost is faces × candidates. 30 is a
 * plausible count for a full room; it is reported so the multiplication is
 * visible rather than hidden inside an average. */
const FACES_PER_IMAGE = 30;

export interface ScaleRow {
  poolSize: number;
  /** Milliseconds to parse `poolSize` pgvector text literals. */
  parseMs: ReturnType<typeof summarise>;
  /** Milliseconds for ONE face against `poolSize` candidates. */
  scanOneFaceMs: ReturnType<typeof summarise>;
  /** Milliseconds for a whole image: FACES_PER_IMAGE faces. */
  scanPerImageMs: ReturnType<typeof summarise>;
  /** Bytes of pgvector text on the wire for the whole pool. */
  wireBytes: number;
}

function buildPool(rng: () => number, size: number): CandidateTemplate[] {
  const pool = new Array<CandidateTemplate>(size);
  for (let i = 0; i < size; i++) {
    pool[i] = {
      studentId: `stu-${i}`,
      embedding: randomUnitVector(rng, EMBEDDING_DIMENSION),
      modelName: "bench",
      modelVersion: "synthetic-1",
    };
  }
  return pool;
}

/** The exact shape Postgres hands back for a `vector(512)` cast to text. */
function toPgVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export function runSearchScale(seed = 20260917): ScaleRow[] {
  const rng = makeRng(seed);
  const rows: ScaleRow[] = [];

  for (const poolSize of POOL_SIZES) {
    const pool = buildPool(rng, poolSize);
    const literals = pool.map((c) => toPgVectorLiteral(c.embedding));
    const wireBytes = literals.reduce((n, s) => n + s.length, 0);

    // A probe that genuinely matches one pool member, so the branch
    // behaviour (best/runner-up bookkeeping) is the same as in production
    // rather than the degenerate "nothing ever beats the best" path.
    const probe = vectorAtCosine(rng, pool[0].embedding, 0.7);

    // Warm up: let the JIT settle before anything is recorded, otherwise the
    // first sample measures the compiler.
    for (let i = 0; i < 5; i++) {
      literals.forEach(parsePgVectorLiteral);
      scoreFaceAgainstCandidates(probe, pool, EMBEDDING_DIMENSION, POLICY);
    }

    const parseSamples: number[] = [];
    const scanSamples: number[] = [];
    const imageSamples: number[] = [];
    const iterations = poolSize >= 5000 ? 20 : 60;

    for (let i = 0; i < iterations; i++) {
      let t0 = performance.now();
      for (const lit of literals) parsePgVectorLiteral(lit);
      parseSamples.push(performance.now() - t0);

      t0 = performance.now();
      scoreFaceAgainstCandidates(probe, pool, EMBEDDING_DIMENSION, POLICY);
      scanSamples.push(performance.now() - t0);

      t0 = performance.now();
      for (let f = 0; f < FACES_PER_IMAGE; f++) {
        scoreFaceAgainstCandidates(probe, pool, EMBEDDING_DIMENSION, POLICY);
      }
      imageSamples.push(performance.now() - t0);
    }

    rows.push({
      poolSize,
      parseMs: summarise(parseSamples),
      scanOneFaceMs: summarise(scanSamples),
      scanPerImageMs: summarise(imageSamples),
      wireBytes,
    });
  }

  return rows;
}

export const FACES_PER_IMAGE_USED = FACES_PER_IMAGE;
