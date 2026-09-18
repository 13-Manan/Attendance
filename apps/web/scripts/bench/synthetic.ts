/**
 * Synthetic embedding geometry for the Phase 12 benchmarks.
 *
 * ## What this is, and what it is emphatically not
 *
 * This file generates **embedding vectors**, not faces. It cannot tell you
 * how well a face model recognises a person in a badly lit classroom,
 * because no face model is involved: there is no detector, no alignment, no
 * pixels. What it *can* tell you — and what Phase 12 actually needs — is how
 * the recognition *decision policy* behaves on a given embedding geometry:
 * the present/review thresholds, the ambiguity margin, and the cross-image
 * aggregation in `aggregateByStudent`.
 *
 * That distinction matters because the one thing this repository cannot
 * currently measure is face-model accuracy: no model here is licensed for
 * production (`services/face-ai/app/models/LICENSING.md`), and there is no
 * authorised face dataset. Simulating a model and calling the output an
 * accuracy number would be a fabrication. Simulating the *geometry* and
 * measuring the real `scoreFaceAgainstCandidates` / `aggregateByStudent`
 * code over it is a real measurement of real code, as long as the generative
 * model is stated. So it is stated:
 *
 * ## The generative model
 *
 * 1. Every enrolled student gets one identity vector: a uniformly random
 *    unit vector in R^512.
 *
 *    The impostor distribution therefore is not a parameter — it falls out
 *    of the geometry. Two independent uniform unit vectors in R^d have
 *    cosine ~ N(0, 1/sqrt(d)), i.e. sd ≈ 0.044 at d = 512. That is close to
 *    what published ArcFace-family impostor distributions look like, and it
 *    is *not* something this file gets to choose, which is the point.
 *
 * 2. A photograph of student i produces a probe vector at an exactly
 *    controlled cosine `c` to student i's identity vector, where `c` is
 *    drawn from N(mu, sd) for the regime under test and then reduced by a
 *    per-condition penalty (angle, lighting, glasses, obstruction,
 *    distance).
 *
 *    `mu` is the only knob that stands in for "how good is the model". It is
 *    never assumed — every benchmark sweeps it across regimes, and results
 *    are reported per regime, so a reader can find the row matching whatever
 *    a real model eventually measures rather than trusting one guess.
 *
 * 3. Everything is seeded. The same seed gives the same numbers on every
 *    machine, which is what makes a benchmark re-runnable after a threshold
 *    change.
 */

/** mulberry32 — small, fast, and good enough that the statistics are not an
 * artefact of the generator. Explicitly seeded so runs are reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller. The tail behaviour matters here: similarity outliers are
 * exactly the events that produce a false acceptance, so a uniform
 * approximation would flatter the results. */
export function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomUnitVector(rng: () => number, dim: number): number[] {
  const v = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const g = gaussian(rng);
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/**
 * A unit vector whose cosine to `base` is exactly `targetCos`.
 *
 * Built as `base * c + orthonormal * sqrt(1 - c^2)`, so the cosine is
 * constructed rather than sampled-and-hoped-for. That exactness is what lets
 * the multi-image benchmark attribute a change in outcome to the decision
 * policy instead of to noise in the generator.
 */
export function vectorAtCosine(
  rng: () => number,
  base: number[],
  targetCos: number,
): number[] {
  const dim = base.length;
  const c = Math.max(-1, Math.min(1, targetCos));

  // A random direction, then the component along `base` removed.
  const r = randomUnitVector(rng, dim);
  let dot = 0;
  for (let i = 0; i < dim; i++) dot += r[i] * base[i];
  const o = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = r[i] - dot * base[i];
    o[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  // Degenerate only if `r` landed parallel to `base`, which at d = 512 does
  // not happen in practice; falling back to `base` keeps it total.
  if (norm < 1e-12) return base.slice();

  const s = Math.sqrt(Math.max(0, 1 - c * c));
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = c * base[i] + (s * o[i]) / norm;
  return out;
}

/**
 * How much each capture condition costs, in cosine similarity.
 *
 * These are penalties applied to the genuine-pair cosine, and they are the
 * least defensible numbers in this file: they are an ordering ("a partially
 * obstructed face is harder than a front-facing one") with plausible
 * magnitudes, not measurements. They are here because the brief asks for the
 * conditions to be represented, and the honest form of that with no dataset
 * is a declared assumption rather than a silent one.
 *
 * Every report produced from them repeats this caveat. Replace this table
 * with measured per-condition deltas as soon as a real dataset exists — the
 * rest of the harness does not change.
 */
export const CONDITION_PENALTY: Readonly<Record<string, number>> = {
  front_facing: 0.0,
  different_angle: 0.08,
  low_light: 0.06,
  bright_light: 0.04,
  glasses: 0.03,
  partial_obstruction: 0.12,
  near_distance: 0.0,
  mid_distance: 0.03,
  far_distance: 0.09,
};

export type ConditionName = keyof typeof CONDITION_PENALTY;

/**
 * An "embedding quality regime" — the stand-in for a face model.
 *
 * `genuineMean` is the average cosine between two photographs of the same
 * person. Published ArcFace-family numbers on clean benchmarks sit in the
 * 0.55–0.75 band; a weak model or a hostile classroom sits lower. The
 * regimes below bracket that range deliberately, because the purpose is to
 * find where the *policy* breaks, not to claim a model achieves any of them.
 */
export interface QualityRegime {
  name: string;
  genuineMean: number;
  genuineSd: number;
  note: string;
}

export const QUALITY_REGIMES: readonly QualityRegime[] = [
  {
    name: "weak",
    genuineMean: 0.42,
    genuineSd: 0.12,
    note: "Poor separation. Stands in for a small/quantised model, or a very hostile room.",
  },
  {
    name: "moderate",
    genuineMean: 0.55,
    genuineSd: 0.1,
    note: "Genuine and impostor distributions still overlap in the tails.",
  },
  {
    name: "strong",
    genuineMean: 0.68,
    genuineSd: 0.08,
    note: "Roughly where a well-behaved ArcFace-family model on cooperative images sits.",
  },
  {
    name: "excellent",
    genuineMean: 0.78,
    genuineSd: 0.06,
    note: "Near-ideal. Included to show which failures do NOT go away with a better model.",
  },
];

/** p50 / p95 / mean over a sample, used by every benchmark in this folder. */
export function summarise(values: number[]): {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
} {
  if (values.length === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  let total = 0;
  for (const v of sorted) total += v;
  return {
    count: sorted.length,
    mean: total / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}
