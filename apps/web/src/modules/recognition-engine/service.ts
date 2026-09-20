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
  AggregationDowngrade,
  CandidateTemplate,
  FaceRecognitionResult,
  RecognitionPolicy,
  RecognitionRunInput,
  RecognitionRunSummary,
  StudentObservation,
  StudentRecognitionAggregate,
} from "./types";
import { MAX_CAPTURES_PER_SESSION } from "@/modules/attendance-capture/types";
import { requireCohortSubjectAccess } from "@/modules/authorization/cohort-access";

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
  embeddingId: string | null;
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
    const scored: ScoredCandidate = {
      studentId: c.studentId,
      similarity: s,
      embeddingId: c.embeddingId ?? null,
    };
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
  if (!best) {
    return {
      best: null,
      runnerUp: null,
      decision: "UNMATCHED",
      wasAmbiguous: false,
      skippedIncompatible: skipped,
    };
  }
  let decision = classifyBySimilarity(best.similarity, policy);
  // Ambiguity rule: two *different students* near-tied for the top match must
  // never auto-mark a "confident" match — the spec explicitly forbids silently
  // converting uncertainty into PRESENT.
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
      wasAmbiguous: r.decision === "UNCERTAIN" && r.runnerUpSimilarity !== null,
      candidateEmbeddingId: r.candidateEmbeddingId,
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
    let matchStatus: MatchStatus = classifyBySimilarity(representative.similarity, policy);

    // Step 3: demotions.
    const downgrades: AggregationDowngrade[] = [];
    if (representative.matchStatus === "UNCERTAIN" && matchStatus === "MATCHED") {
      // A face-level ambiguity downgrade must survive aggregation, or the
      // review gate could be escaped simply by re-deriving the band.
      downgrades.push("ambiguous_face");
      matchStatus = "UNCERTAIN";
    }
    // Two distinct faces in one photograph both claiming to be this student.
    // A person appears once in a still image; two hits mean the recogniser is
    // confusing people, and confusion must not read as confident presence.
    const facesPerCapture = new Map<number, number>();
    for (const o of observations) {
      facesPerCapture.set(o.captureNumber, (facesPerCapture.get(o.captureNumber) ?? 0) + 1);
    }
    if (Array.from(facesPerCapture.values()).some((n) => n > 1) && matchStatus === "MATCHED") {
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
      advisoryResult: matchStatusToAttendanceResult(matchStatus),
      matchStatus,
      wasAmbiguous: downgrades.length > 0,
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
        faceIndex: idx,
        candidateStudentId: null,
        candidateEmbeddingId: null,
        similarityScore: null,
        runnerUpSimilarity: null,
        runnerUpStudentId: null,
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
      faceIndex: idx,
      candidateStudentId: scored.best?.studentId ?? null,
      candidateEmbeddingId: scored.best?.embeddingId ?? null,
      similarityScore: scored.best?.similarity ?? null,
      runnerUpSimilarity: scored.runnerUp?.similarity ?? null,
      runnerUpStudentId: scored.runnerUp?.studentId ?? null,
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

  const summary: RecognitionRunSummary = {
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
    completedAt: (deps.now ?? (() => new Date()))().toISOString(),
    durationMs,
    perFace,
    perStudent,
    unmatchedStudentIds,
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
      modelName: summary.modelName,
      modelVersion: summary.modelVersion,
      productionEligible: summary.productionEligible,
      durationMs: summary.durationMs,
    }),
  );
}
