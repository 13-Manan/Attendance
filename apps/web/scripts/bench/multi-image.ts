/**
 * MULTI-IMAGE TEST — is 3 photographs actually better than 1?
 *
 * The brief says: "DO NOT blindly assume 3 images is always better." The
 * code gives a specific reason to take that seriously.
 *
 * `aggregateByStudent` keeps, for each student, the single **highest**
 * similarity that student attracted across every face in every image. Adding
 * an image can therefore only ever raise a student's best similarity; it can
 * never lower it. That is a max over more samples, and a max over more
 * samples moves *both* ways at once:
 *
 *   - a genuinely present student gets more chances to be seen well
 *     → false rejection falls
 *   - an absent student gets more chances for some stranger's face, or a
 *     classmate's, to score spuriously high against their template
 *     → false acceptance rises
 *
 * You cannot get the first without the second. So "3 images is better" is
 * not a fact, it is a trade, and this benchmark measures which side of the
 * trade wins at each embedding quality and each class size.
 *
 * There is a second, subtler effect worth watching. The ambiguity margin
 * demotes a MATCHED face to UNCERTAIN when the runner-up is close. But
 * `aggregateByStudent` only carries that demotion forward if the *winning*
 * face was the ambiguous one. An ambiguous 0.80 in image 1 followed by a
 * clean 0.82 in image 3 aggregates to a confident PRESENT — the review gate
 * that fired on image 1 is gone. More images can dissolve a review gate.
 * This benchmark counts how often that happens.
 *
 * Everything below drives the real exported functions
 * (`scoreFaceAgainstCandidates`, `aggregateByStudent`) over the synthetic
 * geometry described in `synthetic.ts`. The geometry is simulated; the
 * decision logic under measurement is the shipped code.
 */

import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import {
  aggregateByStudent,
  scoreFaceAgainstCandidates,
} from "../../src/modules/recognition-engine/service.ts";
import type {
  CandidateTemplate,
  FaceRecognitionResult,
  RecognitionPolicy,
} from "../../src/modules/recognition-engine/types.ts";
import {
  DEFAULT_AMBIGUITY_MARGIN,
  DEFAULT_MIN_DETECTION_CONFIDENCE,
} from "../../src/modules/recognition-engine/types.ts";
import {
  CONDITION_PENALTY,
  QUALITY_REGIMES,
  makeRng,
  randomUnitVector,
  vectorAtCosine,
  type QualityRegime,
} from "./synthetic.ts";

export const COHORT_SIZES = [10, 20, 50, 100] as const;
export const IMAGE_COUNTS = [1, 2, 3] as const;

/** Fraction of enrolled students who are actually in the room. The absent
 * ones are what make a false-acceptance rate measurable at all — a benchmark
 * where everybody is present cannot detect the failure that matters most. */
const ATTENDANCE_RATE = 0.85;

/** Probability a present student is captured in any one photograph. Below 1
 * on purpose: a single frame misses people behind heads, at the edge, or
 * looking down. This is the mechanism by which extra images help, so it is
 * named rather than buried. */
const VISIBLE_PER_IMAGE = 0.75;

/** People in frame who are not enrolled in this class — a student from
 * another section, somebody walking past the door. Persistent across the
 * three photographs, because the same person does not become a different
 * person between frames. */
const STRANGERS_PER_CLASS = 3;

/** Share of those strangers built to resemble an enrolled student who is
 * absent. 1-in-3 is high on purpose: this is the adversarial case, and a
 * benchmark that samples it rarely reports a comfortable number with wide
 * error bars instead of a useful one. The rate is a property of the test,
 * not a claim about how often it happens in a school. */
const STRANGER_LOOKALIKE_RATE = 0.34;

/** Conditions, and how often each occurs. Front-facing is the plurality but
 * not the majority: a real classroom photograph is mostly not portraits. */
const CONDITION_MIX: ReadonlyArray<[keyof typeof CONDITION_PENALTY, number]> = [
  ["front_facing", 0.3],
  ["different_angle", 0.2],
  ["low_light", 0.12],
  ["bright_light", 0.06],
  ["glasses", 0.1],
  ["partial_obstruction", 0.1],
  ["mid_distance", 0.07],
  ["far_distance", 0.05],
];

function pickCondition(rng: () => number): keyof typeof CONDITION_PENALTY {
  let r = rng();
  for (const [name, weight] of CONDITION_MIX) {
    r -= weight;
    if (r <= 0) return name;
  }
  return "front_facing";
}

interface SyntheticFace {
  image: 1 | 2 | 3;
  faceId: string;
  embedding: number[];
  detectionConfidence: number;
  qualityScore: number;
  /** null for a stranger — nobody enrolled is actually this person. */
  trueStudentId: string | null;
}

interface Scenario {
  candidates: CandidateTemplate[];
  faces: SyntheticFace[];
  actuallyPresent: Set<string>;
  /** Pairs of students whose templates were deliberately placed close
   * together. See `LOOKALIKE_PAIR_FRACTION`. */
  lookalikePairs: Array<[string, string]>;
}

/**
 * Fraction of the cohort placed into look-alike pairs.
 *
 * ## Why this exists, and why the first run of this benchmark was wrong
 *
 * The first version of this file gave every student an independent uniform
 * random unit vector. That produced a false-acceptance rate of exactly 0.00%
 * in all 48 cells — and the threshold sweep, finding every operating point
 * "clean", duly recommended the *lowest* threshold on the grid. Both results
 * were artefacts.
 *
 * The cause is geometry: two independent unit vectors in R^512 have cosine
 * ~ N(0, 0.044). The largest of 50 such draws is around 0.11. It is not
 * physically possible for an impostor to reach a 0.62 present threshold, so
 * the benchmark could not observe the failure it exists to observe.
 *
 * Real cohorts are not independent draws. A classroom is one age band, often
 * one uniform, frequently siblings, occasionally twins — the inter-class
 * similarity distribution has a right tail that isotropy does not model, and
 * that tail is where every real false acceptance lives.
 *
 * So a share of the cohort is paired, with the pair's template similarity
 * swept as an explicit axis (`LOOKALIKE_LEVELS`) rather than fixed at a
 * guess. The interesting quantity is then conditional: among pairs where one
 * member is in the room and the other is not, how often does the absent one
 * get marked present — and does that get worse as images are added?
 */
const LOOKALIKE_PAIR_FRACTION = 0.2;

/** Template-to-template cosine for a look-alike pair. `0` disables pairing.
 * The upper end is deliberately implausible for anyone but identical twins;
 * it is included to locate the point where the policy fails rather than to
 * claim classrooms look like that. */
export const LOOKALIKE_LEVELS = [0, 0.5, 0.7, 0.85, 0.95] as const;

/** Used by the main grid. Siblings-and-similar-looking, not twins. */
const DEFAULT_LOOKALIKE = 0.5;

function buildScenario(
  rng: () => number,
  cohortSize: number,
  regime: QualityRegime,
  lookalikeCos: number,
): Scenario {
  const candidates: CandidateTemplate[] = [];
  for (let i = 0; i < cohortSize; i++) {
    candidates.push({
      embeddingId: `emb-${i}`,
      studentId: `stu-${i}`,
      embedding: randomUnitVector(rng, EMBEDDING_DIMENSION),
      modelName: "bench",
      modelVersion: "synthetic-1",
    });
  }

  // Pair up the first slice of the cohort, rewriting the second member of
  // each pair to sit at `lookalikeCos` from the first.
  const lookalikePairs: Array<[string, string]> = [];
  if (lookalikeCos > 0) {
    const pairCount = Math.floor((cohortSize * LOOKALIKE_PAIR_FRACTION) / 2);
    for (let p = 0; p < pairCount; p++) {
      const a = candidates[p * 2];
      const b = candidates[p * 2 + 1];
      b.embedding = vectorAtCosine(rng, a.embedding, lookalikeCos);
      lookalikePairs.push([a.studentId, b.studentId]);
    }
  }

  const actuallyPresent = new Set<string>();
  for (const c of candidates) {
    if (rng() < ATTENDANCE_RATE) actuallyPresent.add(c.studentId);
  }

  /**
   * People in frame who are not enrolled in this class.
   *
   * These are built as persistent identities rather than fresh vectors per
   * image, because that is what makes the multi-image question sharp: the
   * same stranger reappearing in image 2 and image 3 gives the max-pooling
   * in `aggregateByStudent` more chances to promote them.
   *
   * A share of them are deliberately built to resemble an *absent* enrolled
   * student. That combination — resembles someone, and that someone has no
   * face of their own in the room to out-score them — is the only way this
   * system produces a confident false PRESENT. A look-alike who is actually
   * enrolled cannot do it: their template is always beaten by the genuine
   * student's own face, so they land as runner-up, where the ambiguity
   * margin is waiting. An unenrolled look-alike has no such competitor.
   */
  const absentStudents = candidates.filter((c) => !actuallyPresent.has(c.studentId));
  const strangers: Array<{ identity: number[] }> = [];
  for (let s = 0; s < STRANGERS_PER_CLASS; s++) {
    const resembles =
      lookalikeCos > 0 && absentStudents.length > 0 && rng() < STRANGER_LOOKALIKE_RATE;
    if (resembles) {
      const target = absentStudents[Math.floor(rng() * absentStudents.length)];
      strangers.push({ identity: vectorAtCosine(rng, target.embedding, lookalikeCos) });
    } else {
      strangers.push({ identity: randomUnitVector(rng, EMBEDDING_DIMENSION) });
    }
  }

  const faces: SyntheticFace[] = [];
  let faceCounter = 0;

  for (const image of IMAGE_COUNTS) {
    for (const c of candidates) {
      if (!actuallyPresent.has(c.studentId)) continue;
      if (rng() >= VISIBLE_PER_IMAGE) continue;

      const condition = pickCondition(rng);
      const raw =
        regime.genuineMean +
        gaussianFrom(rng) * regime.genuineSd -
        CONDITION_PENALTY[condition];
      const cos = Math.max(-0.2, Math.min(0.99, raw));

      faces.push({
        image,
        faceId: `f${faceCounter++}`,
        embedding: vectorAtCosine(rng, c.embedding, cos),
        // Harder conditions also detect worse; the engine drops faces below
        // `minDetectionConfidence` before scoring, and that drop is part of
        // what is being measured.
        detectionConfidence: Math.max(
          0.2,
          Math.min(0.99, 0.9 - CONDITION_PENALTY[condition] * 2 + gaussianFrom(rng) * 0.08),
        ),
        qualityScore: Math.max(0, Math.min(1, 0.8 - CONDITION_PENALTY[condition])),
        trueStudentId: c.studentId,
      });
    }

    for (const stranger of strangers) {
      if (rng() >= VISIBLE_PER_IMAGE) continue;
      const condition = pickCondition(rng);
      const raw =
        regime.genuineMean +
        gaussianFrom(rng) * regime.genuineSd -
        CONDITION_PENALTY[condition];
      const cos = Math.max(-0.2, Math.min(0.99, raw));
      faces.push({
        image,
        faceId: `f${faceCounter++}`,
        // A photograph of the stranger: same generative model as anyone
        // else, at the stranger's own identity vector. Whether that lands
        // near an enrolled template depends on how the identity was built.
        embedding: vectorAtCosine(rng, stranger.identity, cos),
        detectionConfidence: Math.max(0.2, Math.min(0.99, 0.85 + gaussianFrom(rng) * 0.08)),
        qualityScore: 0.75,
        trueStudentId: null,
      });
    }
  }

  return { candidates, faces, actuallyPresent, lookalikePairs };
}

// Local copy of the Box-Muller draw so this module does not depend on the
// order in which `synthetic.ts` consumes the stream.
function gaussianFrom(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface MultiImageCell {
  cohortSize: number;
  regime: string;
  imageCount: number;
  /** Template similarity within look-alike pairs for this cell. */
  lookalikeCos: number;
  /** Look-alike pairs where exactly one member was in the room — i.e. the
   * pairs that could produce a look-alike false acceptance at all. */
  lookalikeOpportunities: number;
  /** Of those, the absent member marked PRESENT. */
  lookalikeFalseAccepts: number;
  /** Of those, the absent member routed to review instead. The design
   * intends this to be the outcome when two templates are close. */
  lookalikeRoutedToReview: number;
  /** Students marked PRESENT who were in the room. */
  truePresent: number;
  /** Students marked PRESENT who were NOT in the room. The number that
   * matters most: an advisory PRESENT is what a rushed faculty member
   * confirms without looking. */
  falseAccept: number;
  /** In-the-room students the system did not put forward as present and did
   * not route to review either. */
  falseReject: number;
  /** Routed to a human. Not a failure — the design intends uncertainty to
   * land here — but it is the cost side of a conservative threshold. */
  uncertain: number;
  /** Of `uncertain`, how many were actually absent. These are the ones a
   * reviewer will (correctly) reject. */
  uncertainAbsent: number;
  /** Correctly left alone. */
  trueAbsent: number;
  totalPresent: number;
  totalAbsent: number;
  /** Faces dropped below `minDetectionConfidence` before any comparison. */
  droppedFaces: number;
  scoredFaces: number;
  /** Present students with at least one face that survived detection. */
  capturedStudents: number;
  /** Times a review gate that had fired at face level was dissolved by a
   * later, cleaner, higher-scoring face in another image. */
  reviewGatesDissolved: number;
  scoringMs: number;
}

const BASE_POLICY: Omit<RecognitionPolicy, "presentMin" | "reviewMin"> = {
  ambiguityMargin: DEFAULT_AMBIGUITY_MARGIN,
  minDetectionConfidence: DEFAULT_MIN_DETECTION_CONFIDENCE,
};

/**
 * Score one scenario restricted to the first `imageCount` images.
 *
 * Mirrors what `runRecognitionForSession` does per face: drop below the
 * detection floor, otherwise score against the class-scoped pool, then
 * aggregate. The two functions under test are imported, not reimplemented.
 */
function evaluate(
  scenario: Scenario,
  imageCount: number,
  policy: RecognitionPolicy,
): Omit<MultiImageCell, "cohortSize" | "regime" | "imageCount" | "lookalikeCos"> {
  const perFace: FaceRecognitionResult[] = [];
  let dropped = 0;
  let scored = 0;
  const capturedStudents = new Set<string>();

  /**
   * Position of a face within its own image.
   *
   * The scenario's `faceId` is a run-wide label ("f7"), which is what the
   * composite `detectedFaceId` wants; the aggregation policy wants the
   * per-image index, because "two faces in the same capture named this
   * student" is a within-image question. Counted here so the bench feeds
   * `aggregateByStudent` the same shape production does.
   */
  const facesSeenPerImage = new Map<number, number>();
  const indexWithinImage = (face: { image: number }): number => {
    const next = facesSeenPerImage.get(face.image) ?? 0;
    facesSeenPerImage.set(face.image, next + 1);
    return next;
  };

  const t0 = performance.now();
  for (const face of scenario.faces) {
    if (face.image > imageCount) continue;

    if (face.detectionConfidence < policy.minDetectionConfidence) {
      dropped++;
      perFace.push({
        detectedFaceId: `${face.image}:${face.faceId}`,
        imageSequenceNumber: face.image,
        faceIndex: indexWithinImage(face),
        candidateStudentId: null,
        candidateEmbeddingId: null,
        similarityScore: null,
        runnerUpSimilarity: null,
        runnerUpStudentId: null,
        detectionConfidence: face.detectionConfidence,
        qualityScore: face.qualityScore,
        decision: "UNMATCHED",
        dropReason: "low_detection_confidence",
      });
      continue;
    }

    scored++;
    if (face.trueStudentId) capturedStudents.add(face.trueStudentId);

    const r = scoreFaceAgainstCandidates(
      face.embedding,
      scenario.candidates,
      EMBEDDING_DIMENSION,
      policy,
    );
    perFace.push({
      detectedFaceId: `${face.image}:${face.faceId}`,
      imageSequenceNumber: face.image,
      faceIndex: indexWithinImage(face),
      candidateStudentId: r.best?.studentId ?? null,
      candidateEmbeddingId: r.best?.embeddingId ?? null,
      similarityScore: r.best?.similarity ?? null,
      runnerUpSimilarity: r.runnerUp?.similarity ?? null,
      runnerUpStudentId: r.runnerUp?.studentId ?? null,
      detectionConfidence: face.detectionConfidence,
      qualityScore: face.qualityScore,
      decision: r.decision,
      dropReason: null,
    });
  }

  const aggregates = aggregateByStudent(perFace, policy);
  const scoringMs = performance.now() - t0;

  // A review gate is "dissolved" when some face pointed at this student with
  // an UNCERTAIN decision, yet the aggregate came out MATCHED — i.e. a
  // different, higher-scoring face overrode the caution.
  const uncertainAtFaceLevel = new Set<string>();
  for (const f of perFace) {
    if (f.decision === "UNCERTAIN" && f.candidateStudentId) {
      uncertainAtFaceLevel.add(f.candidateStudentId);
    }
  }
  let reviewGatesDissolved = 0;

  let truePresent = 0;
  let falseAccept = 0;
  let uncertain = 0;
  let uncertainAbsent = 0;
  const decided = new Set<string>();

  for (const a of aggregates) {
    decided.add(a.studentId);
    const reallyHere = scenario.actuallyPresent.has(a.studentId);
    if (a.matchStatus === "MATCHED") {
      if (uncertainAtFaceLevel.has(a.studentId) && !a.wasAmbiguous) reviewGatesDissolved++;
      if (reallyHere) truePresent++;
      else falseAccept++;
    } else if (a.matchStatus === "UNCERTAIN") {
      uncertain++;
      if (!reallyHere) uncertainAbsent++;
    }
  }

  let falseReject = 0;
  let trueAbsent = 0;
  for (const c of scenario.candidates) {
    if (decided.has(c.studentId)) continue;
    // Not in the aggregate at all: nothing pointed at this student above the
    // review floor, so the advisory result is ABSENT.
    if (scenario.actuallyPresent.has(c.studentId)) falseReject++;
    else trueAbsent++;
  }
  // Students in the aggregate but UNMATCHED land the same way.
  for (const a of aggregates) {
    if (a.matchStatus !== "UNMATCHED") continue;
    if (scenario.actuallyPresent.has(a.studentId)) falseReject++;
    else trueAbsent++;
  }

  // Look-alike accounting, restricted to pairs that split present/absent —
  // a pair where both are in the room cannot produce a false acceptance, and
  // including it would dilute the rate into meaninglessness.
  const statusOf = new Map(aggregates.map((a) => [a.studentId, a.matchStatus]));
  let lookalikeOpportunities = 0;
  let lookalikeFalseAccepts = 0;
  let lookalikeRoutedToReview = 0;
  for (const [a, b] of scenario.lookalikePairs) {
    const aHere = scenario.actuallyPresent.has(a);
    const bHere = scenario.actuallyPresent.has(b);
    if (aHere === bHere) continue;
    lookalikeOpportunities++;
    const absentOne = aHere ? b : a;
    const status = statusOf.get(absentOne);
    if (status === "MATCHED") lookalikeFalseAccepts++;
    else if (status === "UNCERTAIN") lookalikeRoutedToReview++;
  }

  return {
    truePresent,
    falseAccept,
    falseReject,
    uncertain,
    uncertainAbsent,
    trueAbsent,
    lookalikeOpportunities,
    lookalikeFalseAccepts,
    lookalikeRoutedToReview,
    totalPresent: scenario.actuallyPresent.size,
    totalAbsent: scenario.candidates.length - scenario.actuallyPresent.size,
    droppedFaces: dropped,
    scoredFaces: scored,
    capturedStudents: capturedStudents.size,
    reviewGatesDissolved,
    scoringMs,
  };
}

export interface MultiImageOptions {
  presentMin?: number;
  reviewMin?: number;
  trials?: number;
  seed?: number;
  cohortSizes?: readonly number[];
  lookalikeCos?: number;
  regimes?: readonly QualityRegime[];
}

/**
 * The whole grid: cohort size × quality regime × image count.
 *
 * Counts are summed across trials rather than averaged as rates per trial —
 * a rate computed on a 10-student cohort with 2 absentees is mostly noise,
 * and summing first is the difference between a measurement and an anecdote.
 */
export function runMultiImage(options: MultiImageOptions = {}): MultiImageCell[] {
  const {
    presentMin = 0.62,
    reviewMin = 0.45,
    trials = 40,
    seed = 20260917,
    cohortSizes = COHORT_SIZES,
    lookalikeCos = DEFAULT_LOOKALIKE,
    regimes = QUALITY_REGIMES,
  } = options;

  const policy: RecognitionPolicy = { ...BASE_POLICY, presentMin, reviewMin };
  const cells: MultiImageCell[] = [];

  for (const cohortSize of cohortSizes) {
    for (const regime of regimes) {
      const totals: Record<number, MultiImageCell> = {};
      for (const k of IMAGE_COUNTS) {
        totals[k] = {
          cohortSize,
          regime: regime.name,
          imageCount: k,
          lookalikeCos,
          lookalikeOpportunities: 0,
          lookalikeFalseAccepts: 0,
          lookalikeRoutedToReview: 0,
          truePresent: 0,
          falseAccept: 0,
          falseReject: 0,
          uncertain: 0,
          uncertainAbsent: 0,
          trueAbsent: 0,
          totalPresent: 0,
          totalAbsent: 0,
          droppedFaces: 0,
          scoredFaces: 0,
          capturedStudents: 0,
          reviewGatesDissolved: 0,
          scoringMs: 0,
        };
      }

      for (let t = 0; t < trials; t++) {
        // One scenario per trial, evaluated at 1, 2 and 3 images. Sharing
        // the scenario is essential: it makes the comparison paired, so a
        // difference between image counts cannot be a different classroom.
        const rng = makeRng(seed + t * 7919 + cohortSize * 31 + regime.name.length * 104729);
        const scenario = buildScenario(rng, cohortSize, regime, lookalikeCos);
        for (const k of IMAGE_COUNTS) {
          const r = evaluate(scenario, k, policy);
          const acc = totals[k];
          acc.lookalikeOpportunities += r.lookalikeOpportunities;
          acc.lookalikeFalseAccepts += r.lookalikeFalseAccepts;
          acc.lookalikeRoutedToReview += r.lookalikeRoutedToReview;
          acc.truePresent += r.truePresent;
          acc.falseAccept += r.falseAccept;
          acc.falseReject += r.falseReject;
          acc.uncertain += r.uncertain;
          acc.uncertainAbsent += r.uncertainAbsent;
          acc.trueAbsent += r.trueAbsent;
          acc.totalPresent += r.totalPresent;
          acc.totalAbsent += r.totalAbsent;
          acc.droppedFaces += r.droppedFaces;
          acc.scoredFaces += r.scoredFaces;
          acc.capturedStudents += r.capturedStudents;
          acc.reviewGatesDissolved += r.reviewGatesDissolved;
          acc.scoringMs += r.scoringMs;
        }
      }

      for (const k of IMAGE_COUNTS) cells.push(totals[k]);
    }
  }

  return cells;
}

/** Rates, derived once so no report recomputes them differently. */
export function rates(cell: MultiImageCell) {
  const cohortTotal = cell.totalPresent + cell.totalAbsent;
  return {
    falseAcceptanceRate: cell.totalAbsent ? cell.falseAccept / cell.totalAbsent : 0,
    falseRejectionRate: cell.totalPresent ? cell.falseReject / cell.totalPresent : 0,
    uncertainRate: cohortTotal ? cell.uncertain / cohortTotal : 0,
    correctPresentRate: cell.totalPresent ? cell.truePresent / cell.totalPresent : 0,
    captureRate: cell.totalPresent ? cell.capturedStudents / cell.totalPresent : 0,
    detectionRate: cell.scoredFaces + cell.droppedFaces
      ? cell.scoredFaces / (cell.scoredFaces + cell.droppedFaces)
      : 0,
    lookalikeFalseAcceptanceRate: cell.lookalikeOpportunities
      ? cell.lookalikeFalseAccepts / cell.lookalikeOpportunities
      : 0,
    lookalikeReviewRate: cell.lookalikeOpportunities
      ? cell.lookalikeRoutedToReview / cell.lookalikeOpportunities
      : 0,
  };
}

/**
 * The look-alike axis on its own: how close do two students' templates have
 * to be before the policy calls an absent one present, and does adding
 * images make that worse?
 *
 * Run separately from the main grid because it is the one experiment where
 * the answer to "are 3 images better" can plausibly be *no*, and burying it
 * inside a 48-row table would hide it.
 */
export function runLookalikeSweep(
  options: MultiImageOptions & { levels?: readonly number[] } = {},
): MultiImageCell[] {
  const { levels = LOOKALIKE_LEVELS, ...rest } = options;
  const out: MultiImageCell[] = [];
  for (const level of levels) {
    out.push(
      ...runMultiImage({
        trials: 60,
        cohortSizes: [50],
        regimes: QUALITY_REGIMES.filter((r) => r.name === "strong"),
        ...rest,
        lookalikeCos: level,
      }),
    );
  }
  return out;
}
