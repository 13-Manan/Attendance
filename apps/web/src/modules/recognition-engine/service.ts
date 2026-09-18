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
  MatchStatus,
  ModelInfoResponse,
} from "@attendance/shared-types";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import type {
  CandidateTemplate,
  FaceRecognitionResult,
  RecognitionPolicy,
  RecognitionRunInput,
  RecognitionRunSummary,
  StudentRecognitionAggregate,
} from "./types";

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

interface ScoredCandidate {
  studentId: string;
  similarity: number;
}

/**
 * Score one detected face's embedding against every compatible candidate,
 * returning the top-two by similarity (best + runner-up) plus a decision.
 * Two are enough for the ambiguity rule; nothing downstream needs the full
 * ranking.
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
} {
  let best: ScoredCandidate | null = null;
  let runnerUp: ScoredCandidate | null = null;
  let skipped = 0;
  for (const c of candidates) {
    if (c.embedding.length !== embeddingDim) {
      // Enrolled under a different model build — comparing would be
      // meaningless. Count so the caller can report the skip.
      skipped++;
      continue;
    }
    const s = cosineSimilarity(faceEmbedding, c.embedding);
    if (!best || s > best.similarity) {
      runnerUp = best;
      best = { studentId: c.studentId, similarity: s };
    } else if (!runnerUp || s > runnerUp.similarity) {
      runnerUp = { studentId: c.studentId, similarity: s };
    }
  }
  if (!best) {
    return { best: null, runnerUp: null, decision: "UNMATCHED", wasAmbiguous: false, skippedIncompatible: skipped };
  }
  let decision = classifyBySimilarity(best.similarity, policy);
  // Ambiguity rule: two candidates near-tied for the top match must never
  // auto-mark a "confident" match — the Phase 5 spec explicitly forbids
  // silently converting uncertainty into PRESENT.
  const wasAmbiguous =
    decision === "MATCHED" &&
    runnerUp !== null &&
    best.similarity - runnerUp.similarity < policy.ambiguityMargin;
  if (wasAmbiguous) decision = "UNCERTAIN";
  return { best, runnerUp, decision, wasAmbiguous, skippedIncompatible: skipped };
}

export function classifyBySimilarity(similarity: number, policy: RecognitionPolicy): MatchStatus {
  if (similarity >= policy.presentMin) return "MATCHED";
  if (similarity >= policy.reviewMin) return "UNCERTAIN";
  return "UNMATCHED";
}

/**
 * Reduce a flat list of per-face results into one row per candidate
 * student — the whole point of the Phase 5 deduplication requirement:
 * "if Rahul appears in image 1 and image 2, Rahul must only count once".
 *
 * For each student that any face pointed at, we take that student's
 * highest similarity across all faces (from any image). Ties on similarity
 * fall back to detection confidence. A student whose only face-level
 * results were UNMATCHED does not appear in the aggregate at all — the
 * "unmatchedStudentIds" list is computed separately from the candidate
 * pool so that "no candidate for me anywhere" is distinguishable from
 * "someone pointed at me weakly".
 */
export function aggregateByStudent(
  perFace: FaceRecognitionResult[],
  policy: RecognitionPolicy,
): StudentRecognitionAggregate[] {
  const bestByStudent = new Map<string, FaceRecognitionResult>();
  for (const r of perFace) {
    if (!r.candidateStudentId || r.similarityScore === null) continue;
    if (r.decision === "UNMATCHED") continue;
    const existing = bestByStudent.get(r.candidateStudentId);
    const isBetter =
      !existing ||
      (r.similarityScore ?? -Infinity) > (existing.similarityScore ?? -Infinity) ||
      ((r.similarityScore ?? -Infinity) === (existing.similarityScore ?? -Infinity) &&
        r.detectionConfidence > existing.detectionConfidence);
    if (isBetter) bestByStudent.set(r.candidateStudentId, r);
  }
  return Array.from(bestByStudent.values()).map<StudentRecognitionAggregate>((r) => {
    // Recompute decision from the winning face's raw similarity so that
    // any policy change is applied consistently to the aggregate too.
    let matchStatus: MatchStatus =
      r.similarityScore === null ? "UNMATCHED" : classifyBySimilarity(r.similarityScore, policy);
    // Ambiguity that fired at the face level carries forward — a review
    // gate must persist even after cross-image aggregation.
    const wasAmbiguous = r.decision === "UNCERTAIN" && matchStatus === "MATCHED";
    if (wasAmbiguous) matchStatus = "UNCERTAIN";
    return {
      studentId: r.candidateStudentId!,
      bestSimilarity: r.similarityScore,
      bestDetectionConfidence: r.detectionConfidence,
      bestQualityScore: r.qualityScore,
      bestFaceId: r.detectedFaceId,
      advisoryResult: matchStatusToAttendanceResult(matchStatus),
      matchStatus,
      wasAmbiguous,
    };
  });
}

// ---------------------------------------------------------------------------
// Full orchestration (I/O)
// ---------------------------------------------------------------------------

type DetectEmbedFn = (req: DetectEmbedRequest) => Promise<DetectEmbedResponse>;
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
  loadCandidateEmbeddings?: LoadCandidatesFn;
  loadSubjectCandidateEmbeddings?: LoadCandidatesFn;
  detectEmbed?: DetectEmbedFn;
  fetchModelInfo?: ModelInfoFn;
  policyOverrides?: Partial<RecognitionPolicy>;
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

  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(input.sessionId);
  if (!session) throw new Error("session_not_found");
  requireSameInstitution(actor, session.institutionId);

  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, session.cohortId);

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

  const candidates: CandidateTemplate[] = rawCandidates.map((c) => ({
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
  const response = await detectEmbed({
    sessionId: session.id,
    images: input.images,
  });

  let detectedFacesTotal = 0;
  let scoredFacesTotal = 0;
  let skippedIncompatibleCandidates = 0;
  const perFace: FaceRecognitionResult[] = [];

  // Face-ai returns detected faces annotated with the image they came from
  // via `sequenceNumber`. We index the running faceId per image so
  // `detectedFaceId` reads as `<seq>:<n>` — human-readable and stable
  // within one run.
  const perImageCounter = new Map<number, number>();
  for (const face of response.faces) {
    detectedFacesTotal++;
    const idx = (perImageCounter.get(face.sequenceNumber) ?? -1) + 1;
    perImageCounter.set(face.sequenceNumber, idx);
    const detectedFaceId = `${face.sequenceNumber}:${idx}`;

    if (face.detectionConfidence < policy.minDetectionConfidence) {
      // A background poster or a blurred corner. Do not score it, do not
      // let it push anyone into NEEDS_REVIEW, but keep the row so the
      // review UI can explain why nothing came of that frame.
      perFace.push({
        detectedFaceId,
        imageSequenceNumber: face.sequenceNumber,
        candidateStudentId: null,
        similarityScore: null,
        runnerUpSimilarity: null,
        detectionConfidence: face.detectionConfidence,
        qualityScore: face.qualityScore ?? null,
        decision: "UNMATCHED",
        dropReason: "low_detection_confidence",
      });
      continue;
    }
    scoredFacesTotal++;
    const scored = scoreFaceAgainstCandidates(
      face.embedding,
      candidates,
      EMBEDDING_DIMENSION,
      policy,
    );
    // Skipped counts accumulate across faces because each face iterates
    // the candidate list independently — surface the max rather than
    // summing (every face sees the same incompatible candidates).
    if (scored.skippedIncompatible > skippedIncompatibleCandidates) {
      skippedIncompatibleCandidates = scored.skippedIncompatible;
    }
    perFace.push({
      detectedFaceId,
      imageSequenceNumber: face.sequenceNumber,
      candidateStudentId: scored.best?.studentId ?? null,
      similarityScore: scored.best?.similarity ?? null,
      runnerUpSimilarity: scored.runnerUp?.similarity ?? null,
      detectionConfidence: face.detectionConfidence,
      qualityScore: face.qualityScore ?? null,
      decision: scored.decision,
      dropReason: null,
    });
  }

  const perStudent = aggregateByStudent(perFace, policy);
  const claimedStudentIds = new Set(perStudent.map((s) => s.studentId));
  const unmatchedStudentIds = candidates
    .map((c) => c.studentId)
    .filter((id) => !claimedStudentIds.has(id));

  return {
    sessionId: session.id,
    cohortId: session.cohortId,
    candidateScope,
    candidatePoolSize: candidates.length,
    skippedIncompatibleCandidates,
    detectedFacesTotal,
    scoredFacesTotal,
    modelName: modelInfo.modelName,
    modelVersion: modelInfo.modelVersion,
    productionEligible: modelInfo.productionEligible,
    policy,
    perFace,
    perStudent,
    unmatchedStudentIds,
  };
}
