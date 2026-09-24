import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import { getCohortById } from "@/modules/cohorts/repository";
import type { Cohort } from "@/modules/cohorts/types";
import { resolveFacePolicy } from "@/modules/admin-settings/policy";
import { getInstitutionById } from "@/modules/institutions/repository";
import type { Institution } from "@/modules/institutions/types";
import {
  findCandidateEmbeddingsWithVectorsForCohort,
  findCandidateEmbeddingsWithVectorsForCohortSubject,
} from "@/modules/recognition-results/repository";
import type { CandidateEmbeddingWithVector } from "@/modules/recognition-results/repository";
import { matchStatusToAttendanceResult } from "@/modules/recognition-results/service";
import { getSessionById } from "@/modules/sessions/repository";
import type { AttendanceSession } from "@/modules/sessions/types";
import type {
  DetectEmbedRequest,
  DetectEmbedResponse,
  FaceQualityReason,
  IdentificationStatus,
  IdentifyCandidate,
  IdentifyRequest,
  IdentifyResponse,
  MatchStatus,
  ModelInfoResponse,
  RejectedFace,
  RejectedFaceReason,
} from "@attendance/shared-types";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import { calibrateScore, resolveCalibration } from "./calibration";
import type {
  AggregationDowngrade,
  CandidateTemplate,
  FaceDemotion,
  FaceRecognitionResult,
  RecognitionPolicy,
  RecognitionRunInput,
  RecognitionRunSummary,
  StudentObservation,
  StudentRecognitionAggregate,
} from "./types";
import { MAX_CAPTURES_PER_SESSION } from "@/modules/attendance-capture/types";
import { requireCohortSubjectAccess } from "@/modules/authorization/cohort-access";
import { inspectEmbedding } from "@/modules/face-enrollment/policy";
import {
  GALLERY_CANDIDATE_FLOOR,
  GALLERY_MAX_CANDIDATES,
  GALLERY_RECOGNITION_THRESHOLDS,
  galleryIdForCohort,
  isGalleryModel,
} from "@/modules/face-gallery/policy";
import { findGalleryCandidates, type GalleryCandidate } from "@/modules/face-gallery/repository";

/**
 * Phase 5 recognition engine.
 *
 * Orchestrates the "for each classroom image, decide which enrolled students
 * are present" pipeline (docs/RECOGNITION_ENGINE.md):
 *
 *     quality + detect + embed  (face-ai, per-image, batched)
 *       -> class-scoped candidate pool  (apps/web, this module)
 *       -> cosine scoring against every candidate
 *       -> confidence policy: presentMin / reviewMin + ambiguity margin
 *       -> quality cap: a flagged face is never above UNCERTAIN
 *       -> one-to-one assignment of faces to students within each image
 *       -> within-image and cross-image deduplication by studentId
 *       -> advisory per-student result (PRESENT / NEEDS_REVIEW / ABSENT)
 *
 * The engine ONLY produces an advisory summary — it deliberately writes no
 * database rows. Turning advisory results into AttendanceRecord rows is a
 * faculty-review affordance that lives in a later phase; see the invariant
 * in the Phase 5 spec: "Do NOT directly finalize attendance."
 *
 * Cosine similarity is implemented here in-process using the same
 * L2-normalised dot-product face-ai's `matching.py::cosine_similarity`
 * uses. Duplicating the scoring lets recognition run against a large
 * candidate pool without shipping every candidate vector over HTTP just to
 * receive a score back — face-ai's `/v1/match` accepts a supplied
 * candidate list, but for a 50-student classroom the payload plus
 * repeated normalisation dominates; keeping scoring local is a wire-size
 * decision, not a correctness one, because the math is identical.
 */

// ---------------------------------------------------------------------------
// Math (must match services/face-ai/app/matching.py)
// ---------------------------------------------------------------------------

/** Cosine similarity in [-1, 1]. Zero vectors score 0 rather than NaN so a
 * single corrupt template cannot fail a whole classroom run — same
 * conservative rule the Python side applies. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Policy construction from institution settings
// ---------------------------------------------------------------------------

/**
 * All four policy values now come from `Institution.settings`.
 *
 * `presentMin` and `reviewMin` always did. `ambiguityMargin` and
 * `minDetectionConfidence` were constants with an override hook no caller
 * used, which made this type's own promise — "nothing is hardcoded so
 * real-world benchmarking can adjust them without redeploying code" — true of
 * half its fields. `resolveFacePolicy` closes that, and its defaults are
 * `DEFAULT_AMBIGUITY_MARGIN` and `DEFAULT_MIN_DETECTION_CONFIDENCE` exactly,
 * so an institution that has configured nothing gets the values this function
 * returned before (`admin-settings/policy.test.ts` pins that equality).
 *
 * One reading changes, and only for a configuration that was already broken:
 * a stored pair with `reviewMin >= presentMin` now falls back to the defaults
 * instead of being used. That pair leaves no uncertain band at all, so
 * recognition would never route anything to a human — the single behaviour
 * this product exists to guarantee. Falling back is the conservative arm.
 *
 * `overrides` is kept, still ahead of settings, because the benchmark harness
 * and the tests construct policies directly.
 */
export function buildRecognitionPolicyForInstitution(
  institution: Institution,
  overrides: Partial<RecognitionPolicy> = {},
): RecognitionPolicy {
  const configured = resolveFacePolicy(institution.settings);
  return {
    presentMin: overrides.presentMin ?? configured.presentMin,
    reviewMin: overrides.reviewMin ?? configured.reviewMin,
    ambiguityMargin: overrides.ambiguityMargin ?? configured.ambiguityMargin,
    minDetectionConfidence:
      overrides.minDetectionConfidence ?? configured.minDetectionConfidence,
  };
}

// ---------------------------------------------------------------------------
// Pure scoring / classification (unit-testable without any I/O)
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  studentId: string;
  /** On the product's scale — the number `presentMin` and `reviewMin` are
   * written against. Equal to `rawSimilarity` when the backend publishes no
   * calibration. */
  similarity: number;
  embeddingId: string | null;
  /** The backend's own cosine, before calibration. Kept because the raw
   * ambiguity margin is measured on this scale and because a stored result
   * stays explainable after a recalibration. */
  rawSimilarity: number;
}

/**
 * Score one detected face's embedding against every compatible candidate,
 * returning the best match plus the best match belonging to *another*
 * student, and a decision.
 *
 * ## Why the runner-up must be a different student
 *
 * The ambiguity rule exists to catch one situation: two students whose
 * templates the model cannot tell apart. It fires when the top two scores are
 * within `ambiguityMargin` of each other.
 *
 * A student may hold up to `MAX_SAMPLES_PER_STUDENT` (5) templates, and the
 * enrollment UI actively encourages several — "different light recognises them
 * more reliably". Those samples are, by construction, all of the same face, so
 * they score within a hair of each other. Ranking them against one another
 * meant the runner-up was almost always the *same person's* second photograph,
 * the margin was almost always tiny, and every well-enrolled student was
 * demoted MATCHED → UNCERTAIN. The better somebody enrolled, the more certainly
 * they were sent to manual review — the exact inverse of the intent, and it
 * made multi-sample enrollment actively harmful.
 *
 * So a student's own templates compete to represent that student, and only the
 * best score from a *different* student can be the runner-up. Two are still
 * enough for the rule; nothing downstream needs the full ranking.
 */
export function scoreFaceAgainstCandidates(
  faceEmbedding: number[],
  candidates: CandidateTemplate[],
  embeddingDim: number,
  policy: RecognitionPolicy,
): {
  best: ScoredCandidate | null;
  runnerUp: ScoredCandidate | null;
  decision: MatchStatus;
  wasAmbiguous: boolean;
  skippedIncompatible: number;
  /** Each student's best template score, highest first — one entry per
   * student however many templates they hold. The input to the one-to-one
   * assignment in `assignFacesOneToOne`. */
  byStudent: ScoredCandidate[];
} {
  let best: ScoredCandidate | null = null;
  let runnerUp: ScoredCandidate | null = null;
  let skipped = 0;
  const perStudent = new Map<string, ScoredCandidate>();
  for (const c of candidates) {
    if (c.embedding.length !== embeddingDim) {
      // Enrolled under a different model build — comparing would be
      // meaningless. Count so the caller can report the skip.
      skipped++;
      continue;
    }
    const raw = cosineSimilarity(faceEmbedding, c.embedding);
    // Calibrated here, at the one place raw cosines are produced, so that
    // everything downstream — the thresholds, the assignment, the aggregate,
    // the number shown to a teacher — is on a single scale.
    const s = calibrateScore(raw, policy.calibration);
    const scored: ScoredCandidate = {
      studentId: c.studentId,
      similarity: s,
      embeddingId: c.embeddingId ?? null,
      rawSimilarity: raw,
    };
    const own = perStudent.get(c.studentId);
    if (!own || s > own.similarity) perStudent.set(c.studentId, scored);
    if (!best || s > best.similarity) {
      // The displaced leader becomes the runner-up only if it was somebody
      // else. When the same student simply beat their own earlier sample,
      // the existing runner-up (already a different student) stands.
      if (best && best.studentId !== c.studentId) runnerUp = best;
      best = scored;
    } else if (
      c.studentId !== best.studentId &&
      (!runnerUp || s > runnerUp.similarity)
    ) {
      runnerUp = scored;
    }
  }
  // Invariant maintained by both branches above: `runnerUp` is never the same
  // student as `best`.
  const byStudent = [...perStudent.values()].sort(bySimilarityThenStudent);
  if (!best) {
    return {
      best: null,
      runnerUp: null,
      decision: "UNMATCHED",
      wasAmbiguous: false,
      skippedIncompatible: skipped,
      byStudent,
    };
  }
  let decision = classifyBySimilarity(best.similarity, policy);
  // Ambiguity rule: two *different students* near-tied for the top match must
  // never auto-mark a "confident" match — the spec explicitly forbids silently
  // converting uncertainty into PRESENT.
  //
  // Two margins, and either one is enough to demote. The institution's margin
  // is in calibrated points, which is what an administrator can reason about.
  // The backend's own margin is in raw points, because calibration stretches
  // the top of the scale: two students 0.002 raw apart are the same face to
  // the recogniser however far apart their calibrated scores end up.
  const rawMargin = policy.calibration?.rawAmbiguityMargin ?? 0;
  const wasAmbiguous =
    decision === "MATCHED" &&
    runnerUp !== null &&
    (best.similarity - runnerUp.similarity < policy.ambiguityMargin ||
      best.rawSimilarity - runnerUp.rawSimilarity < rawMargin);
  if (wasAmbiguous) decision = "UNCERTAIN";
  return { best, runnerUp, decision, wasAmbiguous, skippedIncompatible: skipped, byStudent };
}

/**
 * The gallery counterpart of `scoreFaceAgainstCandidates`: the provider has
 * already ranked people, so this maps its person ids to students and applies
 * the same rules — best per student, a runner-up from a *different* student,
 * the ambiguity margin, the review floor.
 *
 * A person id that resolves to nobody is never guessed at: it is a student
 * who has left the class (or is not in this subject), or a face whose sample
 * has been retired. It is not attributed, but it is not forgotten either — a
 * face that resembles somebody off this register about as much as its best
 * student on it is exactly the near-collision the ambiguity margin exists
 * for, so it counts as a runner-up for that rule. `confidence` is the
 * provider's number and stands in for `similarity`; the policy passed in must
 * be the gallery one.
 */
export function scoreGalleryCandidates(
  candidates: readonly IdentifyCandidate[],
  studentOfPerson: ReadonlyMap<string, { studentId: string; embeddingId: string | null }>,
  policy: RecognitionPolicy,
): {
  best: ScoredCandidate | null;
  runnerUp: ScoredCandidate | null;
  decision: MatchStatus;
  wasAmbiguous: boolean;
  byStudent: ScoredCandidate[];
} {
  const perStudent = new Map<string, ScoredCandidate>();
  let strongestUnresolved: number | null = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.confidence)) continue;
    const owner = studentOfPerson.get(candidate.personId);
    if (!owner) {
      if (strongestUnresolved === null || candidate.confidence > strongestUnresolved) {
        strongestUnresolved = candidate.confidence;
      }
      continue;
    }
    const own = perStudent.get(owner.studentId);
    if (!own || candidate.confidence > own.similarity) {
      perStudent.set(owner.studentId, {
        studentId: owner.studentId,
        // A provider confidence, already on its own scale and judged against
        // the gallery thresholds. No embedding calibration applies: there is
        // no cosine here to calibrate.
        similarity: candidate.confidence,
        embeddingId: owner.embeddingId,
        rawSimilarity: candidate.confidence,
      });
    }
  }
  const byStudent = [...perStudent.values()].sort(bySimilarityThenStudent);
  const best = byStudent[0] ?? null;
  const runnerUp = byStudent[1] ?? null;
  if (!best) {
    return { best: null, runnerUp: null, decision: "UNMATCHED", wasAmbiguous: false, byStudent };
  }
  let decision = classifyBySimilarity(best.similarity, policy);
  const closest = Math.max(runnerUp?.similarity ?? -Infinity, strongestUnresolved ?? -Infinity);
  const wasAmbiguous =
    decision === "MATCHED" &&
    Number.isFinite(closest) &&
    best.similarity - closest < policy.ambiguityMargin;
  if (wasAmbiguous) decision = "UNCERTAIN";
  return { best, runnerUp, decision, wasAmbiguous, byStudent };
}

/**
 * Distinct unknown people when there are no vectors to compare them by: the
 * largest number seen in any one photograph. Faces in one photo are different
 * people; across photos they cannot be told apart, so the smaller, certain
 * number is reported — the same rule the register uses when it combines
 * rounds.
 */
export function countUnknownFacesWithoutVectors(captureNumbers: readonly number[]): number {
  const perCapture = new Map<number, number>();
  for (const n of captureNumbers) perCapture.set(n, (perCapture.get(n) ?? 0) + 1);
  return Math.max(0, ...perCapture.values());
}

function bySimilarityThenStudent(a: ScoredCandidate, b: ScoredCandidate): number {
  return b.similarity - a.similarity || (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0);
}

export function classifyBySimilarity(similarity: number, policy: RecognitionPolicy): MatchStatus {
  if (similarity >= policy.presentMin) return "MATCHED";
  if (similarity >= policy.reviewMin) return "UNCERTAIN";
  return "UNMATCHED";
}

/** One scored face as the one-to-one assignment sees it. */
export interface AssignableFace {
  faceIndex: number;
  /** Each student's best score for this face, highest first. */
  byStudent: ScoredCandidate[];
}

export interface FaceAssignment {
  /** The student this face was given, or null when it was given nobody. */
  assigned: ScoredCandidate | null;
  /** True when `assigned` is not this face's own best candidate. */
  reassigned: boolean;
  /** This face's own best candidate at or above the review floor, whether or
   * not it got them. Null when nobody reached the floor. */
  topChoice: ScoredCandidate | null;
}

/**
 * Assigns the faces of ONE photograph to students, one to one.
 *
 * A person appears once in a still photograph, so no student may be given two
 * faces from it, and no face may be given two students. Scoring each face
 * independently allowed both: in a class photo of forty, two look-alike
 * faces could each name the same student, and the student was then "seen"
 * twice while the other person went unaccounted for.
 *
 * Greedy on similarity: every (face, student) pair at or above `reviewMin` is
 * ranked, strongest first, and taken if both sides are still free. Ties break
 * on face index, then student id, so the result depends only on the scores.
 * Greedy rather than an optimal (Hungarian) matching on purpose: it never
 * gives a student to a weaker face in order to improve some total, which is
 * the property a reviewer can reason about — "the clearest face got them".
 *
 * A face that lost its best candidate to a stronger face may be given its
 * next free candidate above the floor, but that is recorded as `reassigned`
 * and is never a confident match. A face with no free candidate left is
 * given nobody: it becomes an unknown face, never a guess.
 *
 * `contested` names every student who was the top choice of two or more faces.
 * They keep the stronger face, but the aggregate still sends them to review:
 * two faces resembling one person means the model is confusing people.
 */
export function assignFacesOneToOne(
  faces: AssignableFace[],
  policy: RecognitionPolicy,
): { assignments: FaceAssignment[]; contested: Set<string> } {
  const pairs: Array<{ face: number; candidate: ScoredCandidate }> = [];
  const topChoices = new Map<string, number>();
  const assignments: FaceAssignment[] = faces.map((face, i) => {
    const eligible = face.byStudent.filter((c) => c.similarity >= policy.reviewMin);
    for (const candidate of eligible) pairs.push({ face: i, candidate });
    const top = eligible[0] ?? null;
    if (top) topChoices.set(top.studentId, (topChoices.get(top.studentId) ?? 0) + 1);
    return { assigned: null, reassigned: false, topChoice: top };
  });
  pairs.sort(
    (a, b) =>
      b.candidate.similarity - a.candidate.similarity ||
      faces[a.face].faceIndex - faces[b.face].faceIndex ||
      bySimilarityThenStudent(a.candidate, b.candidate),
  );
  const takenStudents = new Set<string>();
  for (const { face, candidate } of pairs) {
    const slot = assignments[face];
    if (slot.assigned || takenStudents.has(candidate.studentId)) continue;
    slot.assigned = candidate;
    slot.reassigned = candidate.studentId !== slot.topChoice?.studentId;
    takenStudents.add(candidate.studentId);
  }
  const contested = new Set(
    [...topChoices].filter(([, n]) => n > 1).map(([studentId]) => studentId),
  );
  return { assignments, contested };
}

/**
 * How many distinct unknown people a run saw.
 *
 * An unknown face in photo 1 and one in photo 2 may be the same visitor.
 * Faces in the SAME photo are different people by definition; faces in
 * different photos are merged when their calibrated similarity reaches
 * `presentMin` — the same bar a face must clear to be suggested as a student.
 * Single-linkage, processed in capture order, so the count is deterministic.
 *
 * Works on vectors held in memory for the length of the run. Nothing about
 * an unknown face is stored or returned — only this count.
 */
export function countDistinctUnknownFaces(
  faces: Array<{ captureNumber: number; embedding: number[] }>,
  policy: Pick<RecognitionPolicy, "presentMin" | "calibration">,
): number {
  const clusters: Array<{ captures: Set<number>; members: number[][] }> = [];
  for (const face of faces) {
    let bestCluster: (typeof clusters)[number] | null = null;
    let bestScore = policy.presentMin;
    for (const cluster of clusters) {
      if (cluster.captures.has(face.captureNumber)) continue;
      for (const member of cluster.members) {
        // Calibrated, like every other comparison. Raw scores read against
        // presentMin would merge every stranger in the room into one visitor
        // on a backend whose raw scale sits high — the count a teacher uses
        // to decide whether somebody who should not be there was.
        const s = calibrateScore(
          cosineSimilarity(face.embedding, member),
          policy.calibration,
        );
        if (s >= bestScore) {
          bestScore = s;
          bestCluster = cluster;
        }
      }
    }
    if (bestCluster) {
      bestCluster.captures.add(face.captureNumber);
      bestCluster.members.push(face.embedding);
    } else {
      clusters.push({ captures: new Set([face.captureNumber]), members: [face.embedding] });
    }
  }
  return clusters.length;
}

/** Face-level demotion → the aggregate downgrade it becomes, in the order
 * they are reported. */
const FACE_TO_AGGREGATE_DOWNGRADE: ReadonlyArray<readonly [FaceDemotion, AggregationDowngrade]> = [
  ["ambiguous", "ambiguous_face"],
  ["reassigned", "reassigned_face"],
  ["low_quality", "low_quality_face"],
];

/**
 * Reduce a flat list of per-face results into one row per candidate student —
 * the deduplication requirement: "if Rahul appears in image 1 and image 2,
 * Rahul must only count once".
 *
 * The policy this implements is written out in full on
 * `StudentRecognitionAggregate` in ./types.ts. In short: pick a deterministic
 * representative observation, classify it, then apply demotion rules that can
 * only ever make the answer more cautious. Nothing here can promote a student
 * above what their own best face earned.
 *
 * A student whose only face-level results were UNMATCHED does not appear in the
 * aggregate at all — `unmatchedStudentIds` is computed separately from the
 * candidate pool so that "no candidate for me anywhere" stays distinguishable
 * from "someone pointed at me weakly".
 */
export function aggregateByStudent(
  perFace: FaceRecognitionResult[],
  policy: RecognitionPolicy,
): StudentRecognitionAggregate[] {
  // Step 0: collect every observation per student, preserving capture order.
  const observationsByStudent = new Map<string, StudentObservation[]>();
  for (const r of perFace) {
    if (!r.candidateStudentId || r.similarityScore === null) continue;
    if (r.decision === "UNMATCHED") continue;
    const list = observationsByStudent.get(r.candidateStudentId) ?? [];
    list.push({
      captureNumber: r.imageSequenceNumber,
      faceIndex: r.faceIndex,
      detectedFaceId: r.detectedFaceId,
      similarity: r.similarityScore,
      detectionConfidence: r.detectionConfidence,
      qualityScore: r.qualityScore,
      matchStatus: r.decision,
      wasAmbiguous: r.demotions?.length
        ? r.demotions.includes("ambiguous")
        : r.decision === "UNCERTAIN" && r.runnerUpSimilarity !== null,
      candidateEmbeddingId: r.candidateEmbeddingId,
      demotions: r.demotions ?? [],
      qualityFlags: r.qualityFlags ?? [],
      faceSize: r.faceSize ?? null,
      contested: r.contested ?? false,
    });
    observationsByStudent.set(r.candidateStudentId, list);
  }

  const aggregates: StudentRecognitionAggregate[] = [];
  for (const [studentId, observations] of observationsByStudent) {
    observations.sort(
      (a, b) => a.captureNumber - b.captureNumber || a.faceIndex - b.faceIndex,
    );

    // Step 1: the representative observation. Deterministic on ties — highest
    // similarity, then highest detection confidence, then earliest capture —
    // so the same set of observations always produces the same register,
    // whatever order the detector happened to return faces in.
    const representative = observations.reduce((bestSoFar, candidate) =>
      candidate.similarity > bestSoFar.similarity ||
      (candidate.similarity === bestSoFar.similarity &&
        candidate.detectionConfidence > bestSoFar.detectionConfidence)
        ? candidate
        : bestSoFar,
    );

    // Step 2: classify from the raw similarity, so a policy change applies
    // consistently to the aggregate and not only to the face.
    const banded: MatchStatus = classifyBySimilarity(representative.similarity, policy);
    let matchStatus = banded;

    // Step 3: demotions. A face-level demotion must survive aggregation, or
    // the review gate could be escaped simply by re-deriving the band.
    const downgrades: AggregationDowngrade[] = [];
    if (banded === "MATCHED") {
      const faceLevel = FACE_TO_AGGREGATE_DOWNGRADE.filter(([d]) =>
        representative.demotions.includes(d),
      ).map(([, a]) => a);
      if (faceLevel.length === 0 && representative.matchStatus === "UNCERTAIN") {
        // A face result from before face-level reasons were recorded: the only
        // rule that could have demoted it was the ambiguity margin.
        faceLevel.push("ambiguous_face");
      }
      if (faceLevel.length > 0) {
        downgrades.push(...faceLevel);
        matchStatus = "UNCERTAIN";
      }
    }
    // Two distinct faces in one photograph both claiming to be this student.
    // A person appears once in a still image; two hits mean the recogniser is
    // confusing people, and confusion must not read as confident presence.
    // The one-to-one assignment gives the student only one of those faces, so
    // it reports the conflict as `contested` on the face it kept; results
    // assembled without that assignment show it as two observations instead.
    const facesPerCapture = new Map<number, number>();
    for (const o of observations) {
      facesPerCapture.set(o.captureNumber, (facesPerCapture.get(o.captureNumber) ?? 0) + 1);
    }
    const duplicated =
      observations.some((o) => o.contested) ||
      Array.from(facesPerCapture.values()).some((n) => n > 1);
    if (duplicated && banded === "MATCHED") {
      downgrades.push("duplicate_within_capture");
      matchStatus = "UNCERTAIN";
    }

    // Step 4 is structural: there is no branch above that raises a status.
    aggregates.push({
      studentId,
      bestSimilarity: representative.similarity,
      bestDetectionConfidence: representative.detectionConfidence,
      bestQualityScore: representative.qualityScore,
      bestFaceId: representative.detectedFaceId,
      bestEmbeddingId: representative.candidateEmbeddingId,
      bestQualityFlags: representative.qualityFlags,
      advisoryResult: matchStatusToAttendanceResult(matchStatus),
      matchStatus,
      // "Was this student confusable with somebody else" — a quality demotion
      // alone is not that, and must not be reported as it.
      wasAmbiguous: downgrades.some((d) => d !== "low_quality_face"),
      downgrades,
      observations,
    });
  }
  return aggregates;
}

// ---------------------------------------------------------------------------
// Full orchestration (I/O)
// ---------------------------------------------------------------------------

type DetectEmbedFn = (req: DetectEmbedRequest) => Promise<DetectEmbedResponse>;
type IdentifyFn = (req: IdentifyRequest) => Promise<IdentifyResponse>;
type LoadGalleryCandidatesFn = (
  galleryId: string,
  scope: { cohortId: string; cohortSubjectId?: string },
  model: { modelName: string; modelVersion: string },
) => Promise<GalleryCandidate[]>;
type ModelInfoFn = () => Promise<ModelInfoResponse>;
type LoadCandidatesFn = (
  cohortId: string,
  model?: { modelName: string; modelVersion: string },
) => Promise<CandidateEmbeddingWithVector[]>;

export interface RunRecognitionForSessionDeps {
  getSessionById?: (id: string) => Promise<AttendanceSession | null>;
  getCohortById?: (id: string) => Promise<Cohort | null>;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
  requireCohortSubjectAccess?: (u: SessionUser, cohortSubjectId: string) => Promise<void>;
  loadCandidateEmbeddings?: LoadCandidatesFn;
  loadSubjectCandidateEmbeddings?: LoadCandidatesFn;
  detectEmbed?: DetectEmbedFn;
  /** Gallery backends (templateKind "gallery"): identify against the class
   * gallery, and resolve its person ids to this class's students. */
  identifyFaces?: IdentifyFn;
  loadGalleryCandidates?: LoadGalleryCandidatesFn;
  fetchModelInfo?: ModelInfoFn;
  policyOverrides?: Partial<RecognitionPolicy>;
  /**
   * Ceiling on the whole face-ai round trip, in ms.
   *
   * The per-image analyse path has always had one; this one did not, so a
   * face-ai process that accepted the connection and then stopped responding
   * held the Server Action — and the teacher's "Processing…" screen — open
   * indefinitely. A bounded failure the wizard can offer a retry for is the
   * only acceptable outcome.
   */
  detectTimeoutMs?: number;
  now?: () => Date;
}

/** Rejects with `face_ai_timeout` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("face_ai_timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What either front half hands the shared back half. */
interface FaceSource {
  sequenceNumber: 1 | 2 | 3;
  detectionConfidence: number;
  qualityScore?: number | null;
  qualityFlags?: FaceQualityReason[];
  faceSize?: number | null;
  /** Vector path only. Used to count distinct unknown faces, then dropped. */
  embedding?: number[];
}

interface ScoredFace {
  detectedFaceId: string;
  sequenceNumber: 1 | 2 | 3;
  faceIndex: number;
  face: FaceSource;
  /** Null when the face was not compared at all; `dropReason` says why. */
  scored: {
    best: ScoredCandidate | null;
    runnerUp: ScoredCandidate | null;
    decision: MatchStatus;
    wasAmbiguous: boolean;
    byStudent: ScoredCandidate[];
  } | null;
  dropReason?: "low_detection_confidence" | "identification_unavailable";
}

interface FrontHalf {
  policy: RecognitionPolicy;
  candidateScope: RecognitionRunSummary["candidateScope"];
  /** Distinct students who could have been named. */
  candidateStudentIds: string[];
  skippedIncompatibleCandidates: number;
  faces: ScoredFace[];
  rejectedFaces: readonly Pick<RejectedFace, "reason">[];
  durationMs: number;
  gallery?: { identification: IdentificationStatus; galleryReady: boolean };
}

type RunSession = Pick<AttendanceSession, "id" | "cohortId" | "cohortSubjectId">;

/**
 * Numbers faces `<seq>:<n>` per photograph, in the order face-ai returned
 * them — human-readable and stable within one run — and drops any face below
 * the detection floor before `score` sees it. A background poster or a
 * blurred corner is not scored and cannot push anyone into NEEDS_REVIEW, but
 * keeps its row so the review UI can explain why nothing came of that frame.
 */
function scoreEachFace<F extends FaceSource>(
  faces: readonly F[],
  policy: RecognitionPolicy,
  score: (face: F) => Pick<ScoredFace, "scored" | "dropReason">,
): ScoredFace[] {
  const out: ScoredFace[] = [];
  const perImageCounter = new Map<number, number>();
  for (const face of faces) {
    const idx = (perImageCounter.get(face.sequenceNumber) ?? -1) + 1;
    perImageCounter.set(face.sequenceNumber, idx);
    const base = {
      detectedFaceId: `${face.sequenceNumber}:${idx}`,
      sequenceNumber: face.sequenceNumber,
      faceIndex: idx,
      face,
    };
    if (face.detectionConfidence < policy.minDetectionConfidence) {
      out.push({ ...base, scored: null, dropReason: "low_detection_confidence" });
      continue;
    }
    out.push({ ...base, ...score(face) });
  }
  return out;
}

/** The vector path: embed every face, compare in process. */
async function scoreAgainstEmbeddings(
  session: RunSession,
  input: RecognitionRunInput,
  modelInfo: ModelInfoResponse,
  policy: RecognitionPolicy,
  deps: RunRecognitionForSessionDeps,
): Promise<FrontHalf> {
  const loadCandidates =
    deps.loadCandidateEmbeddings ??
    (async (cid, model) => findCandidateEmbeddingsWithVectorsForCohort(cid, model));
  const loadSubjectCandidates =
    deps.loadSubjectCandidateEmbeddings ??
    (async (csid, model) => findCandidateEmbeddingsWithVectorsForCohortSubject(csid, model));

  const modelFilter = {
    modelName: modelInfo.modelName,
    modelVersion: modelInfo.modelVersion,
  };

  // Scope selection. A session attached to a CohortSubject is a college
  // subject class, and the enrolled population for that subject is the
  // correct — and smaller, therefore safer — search space.
  //
  // The fallback exists because per-student subject enrollment is optional
  // in the data model: a non-elective subject can legitimately have no
  // StudentSubjectEnrollment rows at all. Treating "no subject enrollment"
  // as "nobody to compare against" would mark an entire class absent, which
  // is a far worse failure than searching the slightly wider cohort. Which
  // scope was actually used is reported, never inferred by the caller.
  let candidateScope: RecognitionRunSummary["candidateScope"] = "cohort";
  let rawCandidates: CandidateEmbeddingWithVector[] = [];
  if (session.cohortSubjectId) {
    rawCandidates = await loadSubjectCandidates(session.cohortSubjectId, modelFilter);
    if (rawCandidates.length > 0) {
      candidateScope = "cohortSubject";
    }
  }
  if (rawCandidates.length === 0) {
    rawCandidates = await loadCandidates(session.cohortId, modelFilter);
  }

  // The loaders filter by model build in SQL; this is the second lock on the
  // same door. A template from any other build — even one of the same width —
  // is dropped here and counted, never scored.
  const sameBuild = rawCandidates.filter(
    (c) => c.modelName === modelFilter.modelName && c.modelVersion === modelFilter.modelVersion,
  );
  const otherBuildTemplates = rawCandidates.length - sameBuild.length;
  const candidates: CandidateTemplate[] = sameBuild.map((c) => ({
    embeddingId: c.id,
    studentId: c.studentId,
    embedding: c.embedding,
    modelName: c.modelName,
    modelVersion: c.modelVersion,
  }));

  const detectEmbed: DetectEmbedFn =
    deps.detectEmbed ??
    (async (req) => {
      const { detectEmbed } = await import("@/lib/face-ai-client");
      return detectEmbed(req);
    });

  // A single batched call: face-ai's `/v1/detect-embed` accepts multiple
  // images in one request precisely so a classroom capture (1–3 photos)
  // can share detector/recogniser sessions across images. Individual
  // per-image calls would re-warm the pipeline on every frame.
  const startedAtMs = Date.now();
  const response = await withTimeout(
    detectEmbed({
      sessionId: session.id,
      images: input.images,
    }),
    deps.detectTimeoutMs ?? 60_000,
  );
  const durationMs = Date.now() - startedAtMs;

  // The candidate pool was filtered by the model `/v1/model-info` named, but
  // the embeddings came from a second request. A revision rollout between the
  // two would score one model's faces against another model's templates —
  // and the mock and SFace are both 128-d, so the dimension check below
  // would not notice. Refuse rather than report nonsense as "no match".
  if (
    response.modelName !== modelInfo.modelName ||
    response.modelVersion !== modelInfo.modelVersion
  ) {
    throw new Error("face_ai_model_changed");
  }
  // Same contract enrollment enforces on the template side. A NaN or a
  // wrong-length vector scores as a silent UNMATCHED; it is a service fault,
  // and the teacher should see it as one.
  for (const face of response.faces) {
    const check = inspectEmbedding(face.embedding);
    if (!check.ok) throw new Error(`face_ai_invalid_embedding:${check.problem}`);
  }

  // Skipped counts accumulate across faces because each face iterates the
  // candidate list independently — surface the max rather than summing
  // (every face sees the same incompatible candidates).
  let skippedIncompatibleCandidates = otherBuildTemplates;
  const faces = scoreEachFace(response.faces, policy, (face) => {
    const scored = scoreFaceAgainstCandidates(face.embedding, candidates, EMBEDDING_DIMENSION, policy);
    if (otherBuildTemplates + scored.skippedIncompatible > skippedIncompatibleCandidates) {
      skippedIncompatibleCandidates = otherBuildTemplates + scored.skippedIncompatible;
    }
    return { scored };
  });

  return {
    policy,
    candidateScope,
    // Candidates are templates, and a student may hold several. Every figure
    // built from this is about students, so collapse first — otherwise one
    // unmatched student with three samples reads as "No match found: 3".
    candidateStudentIds: [...new Set(candidates.map((c) => c.studentId))],
    skippedIncompatibleCandidates,
    faces,
    rejectedFaces: response.rejectedFaces ?? [],
    durationMs,
  };
}

/**
 * The gallery path (Azure AI Face): the provider holds each class's
 * templates and answers "who is this?" with person ids.
 *
 * Only this class's gallery is searched, and a person id only means a student
 * if an *active* sample placed it there and the student is still actively
 * enrolled in the class (and subject) — see `findGalleryCandidates`.
 *
 * When the provider refuses identification (Limited Access not granted), the
 * run still reports every face it detected, but compares nobody: each face is
 * dropped as `identification_unavailable` and no student is matched, ruled
 * out or counted as unknown. The register then leaves every student to the
 * teacher, which is what an honest detection-only run can support.
 */
async function identifyAgainstGallery(
  session: RunSession,
  input: RecognitionRunInput,
  modelInfo: ModelInfoResponse,
  institutionPolicy: RecognitionPolicy,
  deps: RunRecognitionForSessionDeps,
): Promise<FrontHalf> {
  // The provider's confidence is not a cosine similarity, so the
  // institution's pair does not apply. Its detection floor does. Nor does an
  // embedding backend's calibration: there is no cosine here to calibrate,
  // and applying one would re-band every gallery result against a map
  // measured on somebody else's scale.
  const policy: RecognitionPolicy = {
    ...institutionPolicy,
    ...GALLERY_RECOGNITION_THRESHOLDS,
    ...deps.policyOverrides,
    calibration: null,
  };
  const modelFilter = {
    modelName: modelInfo.modelName,
    modelVersion: modelInfo.modelVersion,
  };
  const galleryId = galleryIdForCohort(session.cohortId);
  const load: LoadGalleryCandidatesFn = deps.loadGalleryCandidates ?? findGalleryCandidates;

  // Same scope rule, and the same fallback, as the vector path.
  let candidateScope: RecognitionRunSummary["candidateScope"] = "cohort";
  let pool: GalleryCandidate[] = [];
  if (session.cohortSubjectId) {
    pool = await load(
      galleryId,
      { cohortId: session.cohortId, cohortSubjectId: session.cohortSubjectId },
      modelFilter,
    );
    if (pool.length > 0) candidateScope = "cohortSubject";
  }
  if (pool.length === 0) {
    pool = await load(galleryId, { cohortId: session.cohortId }, modelFilter);
  }
  const studentOfPerson = new Map(
    pool.map((c) => [c.personId, { studentId: c.studentId, embeddingId: c.faceEmbeddingId }] as const),
  );

  const identify: IdentifyFn =
    deps.identifyFaces ??
    (async (req) => {
      const { identifyFaces } = await import("@/lib/face-ai-client");
      return identifyFaces(req);
    });

  // Called even with an empty pool: the face counts are still real, and the
  // teacher is owed them.
  const startedAtMs = Date.now();
  const response = await withTimeout(
    identify({
      sessionId: session.id,
      images: input.images,
      galleryId,
      maxCandidates: GALLERY_MAX_CANDIDATES,
      confidenceThreshold: GALLERY_CANDIDATE_FLOOR,
    }),
    deps.detectTimeoutMs ?? 60_000,
  );
  const durationMs = Date.now() - startedAtMs;

  if (
    response.modelName !== modelInfo.modelName ||
    response.modelVersion !== modelInfo.modelVersion
  ) {
    throw new Error("face_ai_model_changed");
  }

  const identifying = response.identification === "enabled";
  const faces = scoreEachFace(response.faces, policy, (face) =>
    identifying
      ? { scored: scoreGalleryCandidates(face.candidates, studentOfPerson, policy) }
      : { scored: null, dropReason: "identification_unavailable" },
  );

  return {
    policy,
    candidateScope,
    candidateStudentIds: [...new Set(pool.map((c) => c.studentId))],
    // Vector templates of the class are never loaded on this path, so there
    // is nothing of another build to skip.
    skippedIncompatibleCandidates: 0,
    faces,
    rejectedFaces: response.rejectedFaces,
    durationMs,
    gallery: { identification: response.identification, galleryReady: response.galleryReady },
  };
}

/**
 * The end-to-end recognition run: authorisation → candidate load →
 * face-ai detect+embed → in-process scoring → dedup → advisory summary.
 *
 * Deliberately dependency-injected so unit tests can substitute the whole
 * I/O surface (Prisma, HTTP, cohort-access) without touching a database
 * or spinning up FastAPI. The default implementations are lazily imported
 * for the same reason face-enrollment does it: keep `@/lib/env` (which
 * validates process.env at import time) out of the unit-test import graph.
 */
export async function runRecognitionForSession(
  actor: SessionUser,
  input: RecognitionRunInput,
  deps: RunRecognitionForSessionDeps = {},
): Promise<RecognitionRunSummary> {
  requirePermission(actor, "attendanceSession.capture");

  // Bound the batch before anything else looks at it. The Server Action's
  // schema caps this too, but the service is also reachable from the internal
  // process route and from tests, and "how many images may one run carry" is
  // a product rule, not a serialisation detail.
  if (input.images.length === 0) throw new Error("no_images");
  if (input.images.length > MAX_CAPTURES_PER_SESSION) {
    throw new Error("too_many_images");
  }
  const sequences = new Set(input.images.map((i) => i.sequenceNumber));
  if (sequences.size !== input.images.length) {
    // Two payloads claiming to be capture 2 would produce colliding
    // `detectedFaceId`s and double-count one photograph's faces.
    throw new Error("duplicate_image_sequence");
  }

  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(input.sessionId);
  if (!session) throw new Error("session_not_found");
  requireSameInstitution(actor, session.institutionId);

  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, session.cohortId);

  // A subject session is taught by a particular member of staff, and
  // `createAttendanceSessionForRequest` already demands that link before it
  // will open one. Recognition demanded only cohort access, so a colleague who
  // teaches the same class a different subject could process this register.
  // Same check, same place in the flow, so both ends of a session's life agree
  // about who owns it.
  if (session.cohortSubjectId) {
    const checkSubject = deps.requireCohortSubjectAccess ?? requireCohortSubjectAccess;
    await checkSubject(actor, session.cohortSubjectId);
  }

  // A closed register must not be re-derived. `generateAttendanceCandidates`
  // refuses to write to one, but recognition would still have shipped the
  // classroom photographs to face-ai first — work done on behalf of a session
  // that can no longer accept it.
  if (session.status === "FINALIZED" || session.status === "CANCELLED") {
    throw new Error(`session_locked:${session.status}`);
  }

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(session.cohortId);
  if (!cohort) throw new Error("cohort_not_found");

  const getInstitution = deps.getInstitutionById ?? getInstitutionById;
  const institution = await getInstitution(cohort.institutionId);
  if (!institution) throw new Error("institution_not_found");
  const policy = buildRecognitionPolicyForInstitution(institution, deps.policyOverrides);

  // Resolve the running model *first* so we can scope the candidate pool
  // to templates enrolled under the same model build. Templates from a
  // different backend cannot be scored against the current one and are
  // counted as `skippedIncompatibleCandidates` on the way through.
  const modelInfo = await (deps.fetchModelInfo ??
    (async () => {
      const { faceModelInfo } = await import("@/lib/face-ai-client");
      return faceModelInfo();
    }))();

  // How to read this backend's numbers. Throws when a production embedding
  // backend publishes no map rather than assuming its raw scale is ours —
  // that assumption is what would mark a room full of strangers present.
  const scoredPolicy: RecognitionPolicy = {
    ...policy,
    calibration: resolveCalibration(modelInfo),
  };

  // Two front halves, one back half. Each front half decides who every face
  // might be — by comparing vectors here, or by asking the provider that holds
  // the class gallery — and everything after that (one-to-one assignment,
  // demotions, aggregation, the summary) is the same code for both.
  const run = isGalleryModel(modelInfo)
    ? await identifyAgainstGallery(session, input, modelInfo, policy, deps)
    : await scoreAgainstEmbeddings(session, input, modelInfo, scoredPolicy, deps);
  const scoredFaces = run.faces;
  const runPolicy = run.policy;

  const detectedFacesTotal = scoredFaces.length;
  const scoredFacesTotal = scoredFaces.filter((f) => f.scored).length;
  const perFace: FaceRecognitionResult[] = [];

  // Pass 2: one photograph at a time, give each face at most one student and
  // each student at most one face. See `assignFacesOneToOne`.
  const assignmentOf = new Map<string, FaceAssignment>();
  const contestedIn = new Map<number, Set<string>>();
  for (const sequenceNumber of new Set(scoredFaces.map((f) => f.sequenceNumber))) {
    const inImage = scoredFaces.filter((f) => f.sequenceNumber === sequenceNumber && f.scored);
    const { assignments, contested } = assignFacesOneToOne(
      inImage.map((f) => ({ faceIndex: f.faceIndex, byStudent: f.scored!.byStudent })),
      runPolicy,
    );
    inImage.forEach((f, i) => assignmentOf.set(f.detectedFaceId, assignments[i]));
    contestedIn.set(sequenceNumber, contested);
  }

  const unknownEmbeddings: Array<{ captureNumber: number; embedding: number[] }> = [];
  const unknownCaptures: number[] = [];
  const flaggedFaces: RecognitionRunSummary["flaggedFaces"] = {};
  for (const { detectedFaceId, sequenceNumber, faceIndex, face, scored, dropReason } of scoredFaces) {
    const qualityFlags: FaceQualityReason[] = face.qualityFlags ?? [];
    const common = {
      detectedFaceId,
      imageSequenceNumber: sequenceNumber,
      faceIndex,
      detectionConfidence: face.detectionConfidence,
      qualityScore: face.qualityScore ?? null,
      qualityFlags,
      faceSize: face.faceSize ?? null,
    };
    if (!scored) {
      perFace.push({
        ...common,
        candidateStudentId: null,
        candidateEmbeddingId: null,
        similarityScore: null,
        runnerUpSimilarity: null,
        runnerUpStudentId: null,
        decision: "UNMATCHED",
        dropReason: dropReason ?? "low_detection_confidence",
        demotions: [],
        contested: false,
        unknown: false,
      });
      continue;
    }
    for (const flag of new Set(qualityFlags)) flaggedFaces[flag] = (flaggedFaces[flag] ?? 0) + 1;

    const assignment = assignmentOf.get(detectedFaceId)!;
    const given = assignment.assigned;
    if (!given) {
      // Nobody within the review floor, or everybody it resembled was already
      // accounted for by a stronger face in this photo. Either way it is an
      // unknown face, and an unknown face is never attributed to a student.
      unknownCaptures.push(sequenceNumber);
      if (face.embedding) {
        unknownEmbeddings.push({ captureNumber: sequenceNumber, embedding: face.embedding });
      }
      perFace.push({
        ...common,
        candidateStudentId: null,
        candidateEmbeddingId: null,
        similarityScore: null,
        // What it most resembled, for diagnostics — not an attribution.
        runnerUpSimilarity: scored.best?.similarity ?? null,
        runnerUpStudentId: assignment.topChoice?.studentId ?? null,
        decision: "UNMATCHED",
        dropReason: null,
        demotions: assignment.topChoice ? ["reassigned"] : [],
        contested: false,
        unknown: true,
      });
      continue;
    }

    const demotions: FaceDemotion[] = [];
    let decision: MatchStatus;
    let runnerUp: ScoredCandidate | null;
    if (assignment.reassigned) {
      // Its best candidate went to a stronger face. The student it was given
      // instead is a second choice, and a second choice is never confident.
      demotions.push("reassigned");
      decision =
        classifyBySimilarity(given.similarity, runPolicy) === "UNMATCHED" ? "UNMATCHED" : "UNCERTAIN";
      runnerUp = assignment.topChoice;
    } else {
      decision = scored.decision;
      runnerUp = scored.runnerUp;
      if (scored.wasAmbiguous) demotions.push("ambiguous");
    }
    if (qualityFlags.length > 0 && classifyBySimilarity(given.similarity, runPolicy) === "MATCHED") {
      // A small, blurred or badly lit face can resemble anybody. It may still
      // point a reviewer at a student; it may not suggest them present.
      demotions.push("low_quality");
      decision = "UNCERTAIN";
    }
    perFace.push({
      ...common,
      candidateStudentId: given.studentId,
      candidateEmbeddingId: given.embeddingId,
      similarityScore: given.similarity,
      runnerUpSimilarity: runnerUp?.similarity ?? null,
      runnerUpStudentId: runnerUp?.studentId ?? null,
      decision,
      dropReason: null,
      demotions,
      contested: contestedIn.get(sequenceNumber)?.has(given.studentId) ?? false,
      unknown: false,
    });
  }

  const rejectedFaces: RecognitionRunSummary["rejectedFaces"] = {};
  for (const rejected of run.rejectedFaces) {
    const reason: RejectedFaceReason = rejected.reason;
    rejectedFaces[reason] = (rejectedFaces[reason] ?? 0) + 1;
  }

  const perStudent = aggregateByStudent(perFace, runPolicy);
  const claimedStudentIds = new Set(perStudent.map((s) => s.studentId));
  // A detection-only run compared nobody, so it rules nobody out: "not
  // detected" would claim a search that never happened.
  const compared = !run.gallery || run.gallery.identification === "enabled";
  const unmatchedStudentIds = compared
    ? run.candidateStudentIds.filter((id) => !claimedStudentIds.has(id))
    : [];

  const summary: RecognitionRunSummary = {
    sessionId: session.id,
    cohortId: session.cohortId,
    candidateScope: run.candidateScope,
    candidatePoolSize: run.candidateStudentIds.length,
    skippedIncompatibleCandidates: run.skippedIncompatibleCandidates,
    detectedFacesTotal,
    scoredFacesTotal,
    modelName: modelInfo.modelName,
    modelVersion: modelInfo.modelVersion,
    productionEligible: modelInfo.productionEligible,
    policy: runPolicy,
    completedAt: (deps.now ?? (() => new Date()))().toISOString(),
    durationMs: run.durationMs,
    perFace,
    perStudent,
    unmatchedStudentIds,
    rejectedFaces,
    flaggedFaces,
    // Without vectors, unknown faces in different photos cannot be compared
    // with each other, so the certain lower bound is reported instead.
    unknownFacesTotal: run.gallery
      ? countUnknownFacesWithoutVectors(unknownCaptures)
      : countDistinctUnknownFaces(unknownEmbeddings, runPolicy),
    recommendRetake: (rejectedFaces.face_too_small ?? 0) > 0 || (flaggedFaces.face_too_small ?? 0) > 0,
    ...(run.gallery
      ? {
          templateKind: "gallery" as const,
          identification: run.gallery.identification,
          galleryReady: run.gallery.galleryReady,
          comparableStudentIds: run.candidateStudentIds,
        }
      : {}),
  };

  logRecognitionRun(summary);
  return summary;
}

/**
 * One structured line per run.
 *
 * Every field here is a count, an identifier an operator already holds, or a
 * model version. Deliberately absent, and the reason this is a function rather
 * than an inline `console.log`: no image, no embedding, no similarity score and
 * no student id. A similarity score is an inference drawn from a biometric
 * template, and a log line naming a student next to one is a biometric record
 * sitting in a log aggregator with a different retention policy from the
 * database — see ADR-0008.
 */
function logRecognitionRun(summary: RecognitionRunSummary): void {
  const matched = summary.perStudent.filter((s) => s.matchStatus === "MATCHED").length;
  const uncertain = summary.perStudent.filter((s) => s.matchStatus === "UNCERTAIN").length;
  console.info(
    JSON.stringify({
      // `log` rather than `event`, matching the key `modules/integrations`
      // already emits, so one aggregation query finds every structured line
      // this application writes.
      log: "recognition.run",
      sessionId: summary.sessionId,
      cohortId: summary.cohortId,
      candidateScope: summary.candidateScope,
      candidatePoolSize: summary.candidatePoolSize,
      skippedIncompatibleCandidates: summary.skippedIncompatibleCandidates,
      capturesProcessed: new Set(summary.perFace.map((f) => f.imageSequenceNumber)).size,
      detectedFaces: summary.detectedFacesTotal,
      scoredFaces: summary.scoredFacesTotal,
      matched,
      uncertain,
      unmatched: summary.unmatchedStudentIds.length,
      unknownFaces: summary.unknownFacesTotal,
      rejectedFaces: summary.rejectedFaces,
      flaggedFaces: summary.flaggedFaces,
      modelName: summary.modelName,
      modelVersion: summary.modelVersion,
      productionEligible: summary.productionEligible,
      templateKind: summary.templateKind ?? "embedding",
      identification: summary.identification,
      durationMs: summary.durationMs,
    }),
  );
}
