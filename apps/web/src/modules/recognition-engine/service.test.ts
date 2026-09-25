import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateByStudent,
  assignFacesOneToOne,
  buildRecognitionPolicyForInstitution,
  countDistinctUnknownFaces,
  classifyBySimilarity,
  cosineSimilarity,
  findLookalikeStudents,
  runRecognitionForSession,
  scoreFaceAgainstCandidates,
} from "./service.ts";
import { DEFAULT_AMBIGUITY_MARGIN, DEFAULT_MIN_DETECTION_CONFIDENCE } from "./types.ts";
import type { CandidateTemplate, FaceRecognitionResult, RecognitionPolicy } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { CandidateEmbeddingWithVector } from "../recognition-results/repository.ts";
import type { AttendanceSession } from "../sessions/types.ts";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";
import type { DetectEmbedRequest, DetectEmbedResponse, ModelInfoResponse } from "@attendance/shared-types";

// ---------------------------------------------------------------------------
// Vector fixtures
//
// Every test embedding lives in the plane spanned by the first two axes of a
// contract-width space: v(theta) = [cos t, sin t, 0, 0, ...]. Cosine similarity
// between v(a) and v(b) is then exactly cos(a - b), so a test can ask for a
// pair of vectors at a *precise* similarity instead of hand-tuning floats.
// ---------------------------------------------------------------------------

const DIM = EMBEDDING_DIMENSION;

function angleVec(theta: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}

/** A vector whose cosine similarity to `angleVec(0)` is exactly `s`. */
function vecAtSimilarity(s: number): number[] {
  return angleVec(Math.acos(s));
}

const REFERENCE = angleVec(0);

function policy(overrides: Partial<RecognitionPolicy> = {}): RecognitionPolicy {
  return {
    presentMin: 0.62,
    reviewMin: 0.45,
    ambiguityMargin: DEFAULT_AMBIGUITY_MARGIN,
    minDetectionConfidence: DEFAULT_MIN_DETECTION_CONFIDENCE,
    ...overrides,
  };
}

/**
 * One enrolled template. `sampleId` distinguishes several templates belonging
 * to the same student — the situation the runner-up rule has to survive.
 */
function candidate(studentId: string, similarity: number, sampleId = "a"): CandidateTemplate {
  return {
    embeddingId: `emb-${studentId}-${sampleId}`,
    studentId,
    embedding: vecAtSimilarity(similarity),
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
  };
}

function faceResult(overrides: Partial<FaceRecognitionResult> = {}): FaceRecognitionResult {
  return {
    detectedFaceId: "1:0",
    imageSequenceNumber: 1,
    faceIndex: 0,
    candidateStudentId: "stu-1",
    candidateEmbeddingId: "emb-stu-1-a",
    similarityScore: 0.9,
    runnerUpSimilarity: 0.1,
    runnerUpStudentId: "stu-2",
    detectionConfidence: 0.95,
    qualityScore: 0.8,
    decision: "MATCHED",
    dropReason: null,
    qualityFlags: [],
    faceSize: null,
    demotions: [],
    contested: false,
    unknown: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Orchestration fixtures
// ---------------------------------------------------------------------------

function makeUser(
  overrides: Partial<SessionUser> & { permissions?: string[]; roleKey?: string } = {},
): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "faculty@example.com",
    name: overrides.name ?? "Test Faculty",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "FACULTY",
        name: "Faculty",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: (overrides.permissions ?? [
          "cohort.read",
          "attendanceSession.create",
          "attendanceSession.capture",
        ]) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function makeCohort(id = "co-1", institutionId = "inst-A"): Cohort {
  return {
    id,
    institutionId,
    academicUnitId: "unit-1",
    academicSessionId: "as-1",
    name: `Cohort ${id}`,
    termLabel: null,
    createdAt: new Date(),
  };
}

function makeInstitution(id = "inst-A", settings: Record<string, unknown> = {}): Institution {
  return {
    id,
    name: "Test Institution",
    type: "SCHOOL",
    timezone: "UTC",
    settings,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Institution;
}

function makeSession(overrides: Partial<AttendanceSession> = {}): AttendanceSession {
  return {
    id: "sess-1",
    institutionId: "inst-A",
    cohortId: "co-1",
    cohortSubjectId: null,
    facultyId: "user-1",
    sessionDate: new Date(),
    startedAt: new Date(),
    endedAt: null,
    status: "CAPTURING",
    metadata: {},
    ...overrides,
  } as AttendanceSession;
}

function makeModelInfo(overrides: Partial<ModelInfoResponse> = {}): ModelInfoResponse {
  return {
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    weightsVersion: "0.1.0",
    preprocessingVersion: "1",
    embeddingDim: DIM,
    embeddingNormalized: true,
    runtime: "mock/none",
    commercialUse: "not-applicable",
    productionEligible: false,
    contractVersion: "v1",
    ...overrides,
  };
}

/** Candidate rows as the pgvector repository would return them. */
function poolRow(
  studentId: string,
  similarity: number,
  dim: number = DIM,
): CandidateEmbeddingWithVector {
  const embedding = dim === DIM ? vecAtSimilarity(similarity) : new Array<number>(dim).fill(0.5);
  return {
    id: `emb-${studentId}`,
    studentId,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    embeddingDim: dim,
    embedding,
  };
}

function detectedFace(
  sequenceNumber: 1 | 2 | 3,
  embedding: number[],
  detectionConfidence = 0.95,
  qualityScore: number | null = 0.8,
): DetectEmbedResponse["faces"][number] {
  return {
    sequenceNumber,
    boundingBox: { x: 0, y: 0, width: 128, height: 128 },
    embedding,
    detectionConfidence,
    qualityScore,
  } as DetectEmbedResponse["faces"][number];
}

interface RunHarness {
  calls: {
    loadCandidates: Array<[string, unknown]>;
    loadSubjectCandidates: Array<[string, unknown]>;
    detectEmbed: DetectEmbedRequest[];
    requireCohortSubjectAccess: string[];
  };
  deps: Parameters<typeof runRecognitionForSession>[2];
}

function harness(opts: {
  session?: AttendanceSession;
  cohort?: Cohort;
  institution?: Institution;
  pool?: CandidateEmbeddingWithVector[];
  subjectPool?: CandidateEmbeddingWithVector[];
  faces?: DetectEmbedResponse["faces"];
  rejectedFaces?: DetectEmbedResponse["rejectedFaces"];
  modelInfo?: ModelInfoResponse;
  /** What `/v1/detect-embed` claims produced its embeddings. Defaults to the
   * model-info answer, as it does when nothing changes between the calls. */
  responseModel?: { modelName: string; modelVersion: string };
  policyOverrides?: Partial<RecognitionPolicy>;
  /** Made to reject so a test can assert the subject-ownership gate. */
  subjectAccessError?: Error;
} = {}): RunHarness {
  const calls: RunHarness["calls"] = {
    loadCandidates: [],
    loadSubjectCandidates: [],
    detectEmbed: [],
    requireCohortSubjectAccess: [],
  };
  const modelInfo = opts.modelInfo ?? makeModelInfo();
  return {
    calls,
    deps: {
      getSessionById: async () => opts.session ?? makeSession(),
      getCohortById: async () => opts.cohort ?? makeCohort(),
      getInstitutionById: async () => opts.institution ?? makeInstitution(),
      requireCohortAccess: async () => {},
      requireCohortSubjectAccess: async (_user, cohortSubjectId) => {
        calls.requireCohortSubjectAccess.push(cohortSubjectId);
        if (opts.subjectAccessError) throw opts.subjectAccessError;
      },
      fetchModelInfo: async () => modelInfo,
      loadCandidateEmbeddings: async (cohortId, model) => {
        calls.loadCandidates.push([cohortId, model]);
        return opts.pool ?? [];
      },
      loadSubjectCandidateEmbeddings: async (cohortSubjectId, model) => {
        calls.loadSubjectCandidates.push([cohortSubjectId, model]);
        return opts.subjectPool ?? [];
      },
      detectEmbed: async (req) => {
        calls.detectEmbed.push(req);
        return {
          faces: opts.faces ?? [],
          rejectedFaces: opts.rejectedFaces,
          modelName: opts.responseModel?.modelName ?? modelInfo.modelName,
          modelVersion: opts.responseModel?.modelVersion ?? modelInfo.modelVersion,
        } as DetectEmbedResponse;
      },
      policyOverrides: opts.policyOverrides,
    },
  };
}

const ONE_IMAGE = { sessionId: "sess-1", images: [{ sequenceNumber: 1 as const, imageBase64: "x".repeat(64) }] };

// ===========================================================================
// 1. Embedding matching
// ===========================================================================

test("cosineSimilarity returns 1 for identical vectors", () => {
  assert.ok(Math.abs(cosineSimilarity(REFERENCE, REFERENCE) - 1) < 1e-12);
});

test("cosineSimilarity returns 0 for orthogonal vectors", () => {
  assert.ok(Math.abs(cosineSimilarity(angleVec(0), angleVec(Math.PI / 2))) < 1e-12);
});

test("cosineSimilarity is scale-invariant", () => {
  const scaled = REFERENCE.map((x) => x * 17.5);
  assert.ok(Math.abs(cosineSimilarity(REFERENCE, scaled) - 1) < 1e-12);
});

test("cosineSimilarity produces the requested similarity for the angle fixtures", () => {
  for (const target of [0.95, 0.8, 0.62, 0.45, 0.1]) {
    const got = cosineSimilarity(REFERENCE, vecAtSimilarity(target));
    assert.ok(Math.abs(got - target) < 1e-9, `expected ~${target}, got ${got}`);
  }
});

test("cosineSimilarity returns 0 (not NaN) for a zero vector", () => {
  const zero = new Array<number>(DIM).fill(0);
  assert.equal(cosineSimilarity(REFERENCE, zero), 0);
  assert.equal(cosineSimilarity(zero, zero), 0);
});

test("cosineSimilarity returns 0 when dimensions disagree", () => {
  assert.equal(cosineSimilarity(REFERENCE, [1, 0, 0]), 0);
});

// ===========================================================================
// 2. Threshold classification
// ===========================================================================

test("classifyBySimilarity maps the three bands", () => {
  const p = policy({ presentMin: 0.62, reviewMin: 0.45 });
  assert.equal(classifyBySimilarity(0.9, p), "MATCHED");
  assert.equal(classifyBySimilarity(0.5, p), "UNCERTAIN");
  assert.equal(classifyBySimilarity(0.2, p), "UNMATCHED");
});

test("classifyBySimilarity treats both thresholds as inclusive lower bounds", () => {
  const p = policy({ presentMin: 0.62, reviewMin: 0.45 });
  assert.equal(classifyBySimilarity(0.62, p), "MATCHED");
  assert.equal(classifyBySimilarity(0.62 - 1e-9, p), "UNCERTAIN");
  assert.equal(classifyBySimilarity(0.45, p), "UNCERTAIN");
  assert.equal(classifyBySimilarity(0.45 - 1e-9, p), "UNMATCHED");
});

test("buildRecognitionPolicyForInstitution uses institution defaults plus plumbing defaults", () => {
  const p = buildRecognitionPolicyForInstitution(makeInstitution());
  assert.equal(p.presentMin, 0.62);
  assert.equal(p.reviewMin, 0.45);
  assert.equal(p.ambiguityMargin, DEFAULT_AMBIGUITY_MARGIN);
  assert.equal(p.minDetectionConfidence, DEFAULT_MIN_DETECTION_CONFIDENCE);
});

test("buildRecognitionPolicyForInstitution honours per-institution configured thresholds", () => {
  const inst = makeInstitution("inst-A", {
    confidenceThresholds: { presentMin: 0.8, reviewMin: 0.55 },
  });
  const p = buildRecognitionPolicyForInstitution(inst);
  assert.equal(p.presentMin, 0.8);
  assert.equal(p.reviewMin, 0.55);
});

test("buildRecognitionPolicyForInstitution lets explicit overrides win (benchmark tuning)", () => {
  const p = buildRecognitionPolicyForInstitution(makeInstitution(), {
    presentMin: 0.71,
    ambiguityMargin: 0.12,
    minDetectionConfidence: 0.7,
  });
  assert.equal(p.presentMin, 0.71);
  assert.equal(p.reviewMin, 0.45);
  assert.equal(p.ambiguityMargin, 0.12);
  assert.equal(p.minDetectionConfidence, 0.7);
});

// ===========================================================================
// 3. Ambiguous matches
// ===========================================================================

test("scoreFaceAgainstCandidates picks the highest-similarity candidate", () => {
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-far", 0.2), candidate("stu-near", 0.93), candidate("stu-mid", 0.5)],
    DIM,
    policy(),
  );
  assert.equal(result.best?.studentId, "stu-near");
  assert.equal(result.runnerUp?.studentId, "stu-mid");
  assert.equal(result.decision, "MATCHED");
  assert.equal(result.wasAmbiguous, false);
});

test("scoreFaceAgainstCandidates downgrades a near-tie to UNCERTAIN", () => {
  // 0.90 vs 0.88 — inside the 0.05 ambiguity margin, so the top score being
  // above presentMin must NOT produce a confident match.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-a", 0.9), candidate("stu-b", 0.88)],
    DIM,
    policy(),
  );
  assert.equal(result.best?.studentId, "stu-a");
  assert.equal(result.decision, "UNCERTAIN");
  assert.equal(result.wasAmbiguous, true);
});

test("scoreFaceAgainstCandidates keeps MATCHED when the margin is comfortably clear", () => {
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-a", 0.9), candidate("stu-b", 0.7)],
    DIM,
    policy(),
  );
  assert.equal(result.decision, "MATCHED");
  assert.equal(result.wasAmbiguous, false);
});

test("the ambiguity margin is configurable, not hardcoded", () => {
  const candidates = [candidate("stu-a", 0.9), candidate("stu-b", 0.7)];
  const strict = scoreFaceAgainstCandidates(REFERENCE, candidates, DIM, policy({ ambiguityMargin: 0.3 }));
  assert.equal(strict.decision, "UNCERTAIN");
  assert.equal(strict.wasAmbiguous, true);

  const lax = scoreFaceAgainstCandidates(REFERENCE, candidates, DIM, policy({ ambiguityMargin: 0.01 }));
  assert.equal(lax.decision, "MATCHED");
});

test("a near-tie below presentMin stays UNCERTAIN without being flagged ambiguous", () => {
  // Already in the review band — there is nothing to downgrade, so the
  // ambiguity flag must not fire and mislead the reviewer.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-a", 0.52), candidate("stu-b", 0.5)],
    DIM,
    policy(),
  );
  assert.equal(result.decision, "UNCERTAIN");
  assert.equal(result.wasAmbiguous, false);
});

test("a single candidate above presentMin is never ambiguous (no runner-up)", () => {
  const result = scoreFaceAgainstCandidates(REFERENCE, [candidate("stu-a", 0.95)], DIM, policy());
  assert.equal(result.decision, "MATCHED");
  assert.equal(result.wasAmbiguous, false);
  assert.equal(result.runnerUp, null);
});

// ===========================================================================
// 4. No match
// ===========================================================================

test("scoreFaceAgainstCandidates returns UNMATCHED when every candidate is below reviewMin", () => {
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-a", 0.3), candidate("stu-b", 0.1)],
    DIM,
    policy(),
  );
  assert.equal(result.decision, "UNMATCHED");
  // The best candidate is still reported for diagnostics, but the decision
  // is what downstream code acts on.
  assert.equal(result.best?.studentId, "stu-a");
});

test("scoreFaceAgainstCandidates handles an empty candidate pool", () => {
  const result = scoreFaceAgainstCandidates(REFERENCE, [], DIM, policy());
  assert.equal(result.best, null);
  assert.equal(result.runnerUp, null);
  assert.equal(result.decision, "UNMATCHED");
  assert.equal(result.wasAmbiguous, false);
});

test("candidates enrolled at a different embedding dimension are skipped and counted", () => {
  const wrongDim: CandidateTemplate = {
    embeddingId: "emb-legacy",
    studentId: "stu-old-model",
    // The pre-Phase-5 width: a template enrolled under the old contract.
    embedding: new Array<number>(512).fill(0.5),
    modelName: "legacy",
    modelVersion: "0.0.1+pp1",
  };
  const result = scoreFaceAgainstCandidates(REFERENCE, [wrongDim, candidate("stu-a", 0.9)], DIM, policy());
  assert.equal(result.skippedIncompatible, 1);
  assert.equal(result.best?.studentId, "stu-a");
});

// ===========================================================================
// 5. Duplicate removal
// ===========================================================================

test("aggregateByStudent collapses one student seen in two images into a single row", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", imageSequenceNumber: 1, candidateStudentId: "rahul", similarityScore: 0.71 }),
      faceResult({ detectedFaceId: "2:0", imageSequenceNumber: 2, candidateStudentId: "rahul", similarityScore: 0.88 }),
    ],
    policy(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].studentId, "rahul");
  assert.equal(rows[0].bestSimilarity, 0.88);
  assert.equal(rows[0].bestFaceId, "2:0");
});

test("aggregateByStudent breaks similarity ties on detection confidence", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", candidateStudentId: "rahul", similarityScore: 0.8, detectionConfidence: 0.6 }),
      faceResult({
        detectedFaceId: "2:0",
        imageSequenceNumber: 2,
        candidateStudentId: "rahul",
        similarityScore: 0.8,
        detectionConfidence: 0.99,
      }),
    ],
    policy(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bestFaceId, "2:0");
  assert.equal(rows[0].bestDetectionConfidence, 0.99);
});

test("aggregateByStudent ignores UNMATCHED and dropped faces", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ candidateStudentId: "stu-a", similarityScore: 0.2, decision: "UNMATCHED" }),
      faceResult({
        detectedFaceId: "1:1",
        candidateStudentId: null,
        similarityScore: null,
        decision: "UNMATCHED",
        dropReason: "low_detection_confidence",
      }),
    ],
    policy(),
  );
  assert.equal(rows.length, 0);
});

test("aggregateByStudent maps statuses to attendance vocabulary and never turns UNCERTAIN into PRESENT", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ candidateStudentId: "confident", similarityScore: 0.9, decision: "MATCHED" }),
      faceResult({
        detectedFaceId: "1:1",
        candidateStudentId: "borderline",
        similarityScore: 0.5,
        decision: "UNCERTAIN",
      }),
    ],
    policy(),
  );
  const byId = new Map(rows.map((r) => [r.studentId, r]));
  assert.equal(byId.get("confident")?.advisoryResult, "PRESENT");
  assert.equal(byId.get("confident")?.matchStatus, "MATCHED");
  assert.equal(byId.get("borderline")?.advisoryResult, "NEEDS_REVIEW");
  assert.equal(byId.get("borderline")?.matchStatus, "UNCERTAIN");
});

test("aggregateByStudent carries a face-level ambiguity downgrade through aggregation", () => {
  // Similarity alone would re-classify this as MATCHED; the face-level
  // ambiguity verdict must survive so the reviewer still sees it.
  const rows = aggregateByStudent(
    [faceResult({ candidateStudentId: "twin", similarityScore: 0.9, decision: "UNCERTAIN" })],
    policy(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wasAmbiguous, true);
  assert.equal(rows[0].matchStatus, "UNCERTAIN");
  assert.equal(rows[0].advisoryResult, "NEEDS_REVIEW");
});

test("aggregateByStudent keeps distinct students distinct", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", candidateStudentId: "stu-a", similarityScore: 0.9 }),
      faceResult({ detectedFaceId: "1:1", candidateStudentId: "stu-b", similarityScore: 0.85 }),
    ],
    policy(),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.studentId).sort(), ["stu-a", "stu-b"]);
});

// ===========================================================================
// 6. Class scope
// ===========================================================================

test("runRecognitionForSession loads candidates scoped to the session's cohort and running model", async () => {
  const h = harness({ pool: [poolRow("stu-a", 0.9)], faces: [detectedFace(1, REFERENCE)] });
  await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);

  assert.equal(h.calls.loadCandidates.length, 1);
  const [cohortId, model] = h.calls.loadCandidates[0];
  assert.equal(cohortId, "co-1");
  assert.deepEqual(model, { modelName: "mock", modelVersion: "0.1.0+pp1" });
});

test("a subject session searches the subject's enrolled students, not the whole cohort", async () => {
  const h = harness({
    session: makeSession({ cohortSubjectId: "cs-1" }),
    subjectPool: [poolRow("elective-student", 0.95)],
    pool: [poolRow("elective-student", 0.95), poolRow("other-cohort-student", 0.95)],
    faces: [detectedFace(1, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);

  assert.deepEqual(h.calls.loadSubjectCandidates, [
    ["cs-1", { modelName: "mock", modelVersion: "0.1.0+pp1" }],
  ]);
  assert.equal(h.calls.loadCandidates.length, 0, "the wider cohort pool must not be loaded as well");
  assert.equal(summary.candidateScope, "cohortSubject");
  assert.equal(summary.candidatePoolSize, 1);
});

test("a session with no cohortSubjectId never touches the subject loader", async () => {
  const h = harness({ pool: [poolRow("stu-a", 0.9)], faces: [detectedFace(1, REFERENCE)] });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);

  assert.equal(h.calls.loadSubjectCandidates.length, 0);
  assert.equal(summary.candidateScope, "cohort");
});

test("an empty subject enrollment falls back to the cohort rather than marking everyone absent", async () => {
  // Per-student subject enrollment is optional in the data model. A subject
  // with no StudentSubjectEnrollment rows must not produce an empty search
  // space — that would report an entire class as absent.
  const h = harness({
    session: makeSession({ cohortSubjectId: "cs-empty" }),
    subjectPool: [],
    pool: [poolRow("stu-a", 0.95), poolRow("stu-b", 0.2)],
    faces: [detectedFace(1, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);

  assert.equal(h.calls.loadSubjectCandidates.length, 1);
  assert.deepEqual(h.calls.loadCandidates, [
    ["co-1", { modelName: "mock", modelVersion: "0.1.0+pp1" }],
  ]);
  assert.equal(summary.candidateScope, "cohort", "the fallback must be reported, not hidden");
  assert.equal(summary.candidatePoolSize, 2);
  assert.equal(summary.perStudent.find((s) => s.studentId === "stu-a")?.advisoryResult, "PRESENT");
});

test("runRecognitionForSession can only ever match students inside the loaded pool", async () => {
  const h = harness({
    pool: [poolRow("in-class-a", 0.95), poolRow("in-class-b", 0.3)],
    faces: [detectedFace(1, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);

  assert.equal(summary.candidatePoolSize, 2);
  const seen = new Set([
    ...summary.perStudent.map((s) => s.studentId),
    ...summary.unmatchedStudentIds,
    ...summary.perFace.map((f) => f.candidateStudentId).filter((x): x is string => x !== null),
  ]);
  assert.deepEqual([...seen].sort(), ["in-class-a", "in-class-b"]);
});

test("runRecognitionForSession requires the capture permission", async () => {
  const h = harness();
  await assert.rejects(
    () => runRecognitionForSession(makeUser({ permissions: ["cohort.read"] }), ONE_IMAGE, h.deps),
    ForbiddenError,
  );
  // Nothing was loaded and no image was sent anywhere.
  assert.equal(h.calls.loadCandidates.length, 0);
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("runRecognitionForSession refuses a session belonging to another institution", async () => {
  const h = harness({ session: makeSession({ institutionId: "inst-B" }) });
  await assert.rejects(() => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps), ForbiddenError);
  // The classroom photo must not reach face-ai for a tenant we cannot serve.
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("runRecognitionForSession propagates cohort-access denial before any image leaves the process", async () => {
  const h = harness();
  h.deps!.requireCohortAccess = async () => {
    throw new ForbiddenError("not your cohort");
  };
  await assert.rejects(() => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps), ForbiddenError);
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("runRecognitionForSession surfaces incompatible candidate templates instead of swallowing them", async () => {
  const h = harness({
    pool: [poolRow("stu-legacy", 0.9, 512), poolRow("stu-a", 0.9)],
    faces: [detectedFace(1, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.skippedIncompatibleCandidates, 1);
});

// ===========================================================================
// 7. Multiple image aggregation (end to end)
// ===========================================================================

const THREE_IMAGES = {
  sessionId: "sess-1",
  images: [
    { sequenceNumber: 1 as const, imageBase64: "a".repeat(64) },
    { sequenceNumber: 2 as const, imageBase64: "b".repeat(64) },
  ],
};

test("runRecognitionForSession batches every image into one face-ai call", async () => {
  const h = harness({ pool: [poolRow("stu-a", 0.9)], faces: [] });
  await runRecognitionForSession(makeUser(), THREE_IMAGES, h.deps);
  assert.equal(h.calls.detectEmbed.length, 1);
  assert.equal(h.calls.detectEmbed[0].images.length, 2);
  assert.equal(h.calls.detectEmbed[0].sessionId, "sess-1");
});

test("a student appearing in two images produces exactly one attendance advisory", async () => {
  const h = harness({
    pool: [poolRow("rahul", 0.95), poolRow("priya", 0.1)],
    faces: [
      // Rahul, weaker in image 1 and stronger in image 2.
      detectedFace(1, vecAtSimilarity(0.7)),
      detectedFace(2, REFERENCE),
    ],
  });
  const summary = await runRecognitionForSession(makeUser(), THREE_IMAGES, h.deps);

  assert.equal(summary.detectedFacesTotal, 2);
  assert.equal(summary.scoredFacesTotal, 2);
  assert.equal(summary.perFace.length, 2);
  const rahulRows = summary.perStudent.filter((s) => s.studentId === "rahul");
  assert.equal(rahulRows.length, 1, "Rahul must be counted once across images");
  // The stronger image-2 observation wins.
  assert.equal(rahulRows[0].bestFaceId, "2:0");
  assert.ok(rahulRows[0].bestSimilarity! > 0.9);
  assert.equal(rahulRows[0].advisoryResult, "PRESENT");
});

test("students with no face above the review floor land in unmatchedStudentIds", async () => {
  const h = harness({
    pool: [poolRow("present-student", 0.95), poolRow("absent-student", 0.05)],
    faces: [detectedFace(1, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.deepEqual(
    summary.perStudent.map((s) => s.studentId),
    ["present-student"],
  );
  assert.deepEqual(summary.unmatchedStudentIds, ["absent-student"]);
});

test("detectedFaceId is namespaced per image so two images never collide", async () => {
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [
      detectedFace(1, REFERENCE),
      detectedFace(1, vecAtSimilarity(0.2)),
      detectedFace(2, vecAtSimilarity(0.3)),
    ],
  });
  const summary = await runRecognitionForSession(makeUser(), THREE_IMAGES, h.deps);
  assert.deepEqual(
    summary.perFace.map((f) => f.detectedFaceId),
    ["1:0", "1:1", "2:0"],
  );
});

test("faces below the detection-confidence floor are recorded but never scored", async () => {
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, REFERENCE, 0.2), detectedFace(1, REFERENCE, 0.99)],
    policyOverrides: { minDetectionConfidence: 0.5 },
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);

  assert.equal(summary.detectedFacesTotal, 2);
  assert.equal(summary.scoredFacesTotal, 1);
  const dropped = summary.perFace.find((f) => f.dropReason !== null)!;
  assert.equal(dropped.dropReason, "low_detection_confidence");
  assert.equal(dropped.candidateStudentId, null);
  assert.equal(dropped.decision, "UNMATCHED");
  // The one good face still produced the match.
  assert.equal(summary.perStudent.length, 1);
});

test("a low-confidence phantom face cannot by itself push a student into review", async () => {
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, REFERENCE, 0.1)],
    policyOverrides: { minDetectionConfidence: 0.5 },
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.perStudent.length, 0);
  assert.deepEqual(summary.unmatchedStudentIds, ["stu-a"]);
});

test("an ambiguous pair across images stays NEEDS_REVIEW end to end", async () => {
  const h = harness({
    // Two near-identical templates: whichever wins, the margin rule fires.
    pool: [poolRow("twin-a", 0.92), poolRow("twin-b", 0.9)],
    faces: [detectedFace(1, REFERENCE), detectedFace(2, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), THREE_IMAGES, h.deps);

  assert.ok(summary.perFace.every((f) => f.decision === "UNCERTAIN"));
  assert.equal(summary.perStudent.length, 1);
  assert.equal(summary.perStudent[0].wasAmbiguous, true);
  assert.equal(summary.perStudent[0].advisoryResult, "NEEDS_REVIEW");
  assert.notEqual(summary.perStudent[0].advisoryResult, "PRESENT");
});

test("runRecognitionForSession writes no attendance and returns an advisory summary only", async () => {
  const h = harness({ pool: [poolRow("stu-a", 0.95)], faces: [detectedFace(1, REFERENCE)] });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  // The engine has no repository dependency capable of writing rows; the
  // contract it returns is purely advisory.
  assert.equal(summary.sessionId, "sess-1");
  assert.equal(summary.cohortId, "co-1");
  assert.ok("perStudent" in summary && "perFace" in summary);
  assert.equal(Object.hasOwn(summary, "attendanceRecords"), false);
});

test("the run summary exposes model provenance and the production-eligibility warning flag", async () => {
  const h = harness({
    modelInfo: makeModelInfo({ productionEligible: false, commercialUse: "not-applicable" }),
    faces: [],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.modelName, "mock");
  assert.equal(summary.modelVersion, "0.1.0+pp1");
  assert.equal(summary.productionEligible, false);
});

test("the run summary leaks no embedding vectors to the caller", async () => {
  const h = harness({ pool: [poolRow("stu-a", 0.95)], faces: [detectedFace(1, REFERENCE)] });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("embedding"), false);
  // The reference vector's leading component would appear verbatim if any
  // vector were serialised.
  assert.equal(serialized.includes("0.7071"), false);
  for (const face of summary.perFace) {
    assert.equal(Object.hasOwn(face, "embedding"), false);
  }
});

test("runRecognitionForSession reports a missing session rather than guessing", async () => {
  const h = harness();
  h.deps!.getSessionById = async () => null;
  await assert.rejects(() => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps), /session_not_found/);
});

// ===========================================================================
// 8. Multiple templates per student
//
// A student may hold up to MAX_SAMPLES_PER_STUDENT (5) enrolled templates, and
// the enrollment UI encourages several. Every test here exists because the
// engine previously ranked those samples against one another, which made the
// ambiguity rule fire on well-enrolled students and demoted them to review.
// ===========================================================================

test("a student's own second template is never their runner-up", () => {
  // Two samples of the same face: 0.95 and 0.93. Ranked against each other the
  // margin is 0.02, inside the 0.05 ambiguity band.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-a", 0.95, "one"), candidate("stu-a", 0.93, "two")],
    DIM,
    policy(),
  );
  assert.equal(result.best?.studentId, "stu-a");
  assert.equal(result.runnerUp, null, "nobody else was enrolled, so there is no runner-up");
  assert.equal(result.wasAmbiguous, false);
  assert.equal(result.decision, "MATCHED");
});

test("five samples of one student still produce a confident match", () => {
  // The realistic shape of a fully enrolled student. Every sample is a near-tie
  // with every other, which is the whole point of enrolling several.
  const samples = [0.95, 0.94, 0.93, 0.92, 0.91].map((s, i) =>
    candidate("stu-a", s, `s${i}`),
  );
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [...samples, candidate("stu-b", 0.3)],
    DIM,
    policy(),
  );
  assert.equal(result.best?.studentId, "stu-a");
  assert.equal(result.runnerUp?.studentId, "stu-b");
  assert.equal(result.decision, "MATCHED", "a well-enrolled student must not be sent to review");
});

test("a genuine look-alike is still caught when both students hold several samples", () => {
  // The rule must keep working, not merely stop misfiring: two *different*
  // students inside the margin still go to review.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [
      candidate("stu-a", 0.95, "one"),
      candidate("stu-a", 0.94, "two"),
      candidate("stu-twin", 0.93, "one"),
      candidate("stu-twin", 0.92, "two"),
    ],
    DIM,
    policy(),
  );
  assert.equal(result.best?.studentId, "stu-a");
  assert.equal(result.runnerUp?.studentId, "stu-twin");
  assert.equal(result.wasAmbiguous, true);
  assert.equal(result.decision, "UNCERTAIN");
});

test("the runner-up is a different student whatever order candidates arrive in", () => {
  // Ordering matters to a single-pass scan, so exercise several permutations of
  // the same pool and assert the invariant directly.
  const pool = [
    candidate("stu-a", 0.9, "one"),
    candidate("stu-b", 0.8),
    candidate("stu-a", 0.95, "two"),
    candidate("stu-c", 0.5),
  ];
  const orders = [
    [0, 1, 2, 3],
    [2, 0, 3, 1],
    [3, 1, 0, 2],
    [1, 2, 0, 3],
    [3, 2, 1, 0],
  ];
  for (const order of orders) {
    const result = scoreFaceAgainstCandidates(REFERENCE, order.map((i) => pool[i]), DIM, policy());
    assert.equal(result.best?.studentId, "stu-a", `order ${order.join("")}`);
    assert.notEqual(
      result.runnerUp?.studentId,
      result.best?.studentId,
      `order ${order.join("")}: runner-up must not be the same student as the best match`,
    );
    assert.equal(result.runnerUp?.studentId, "stu-b", `order ${order.join("")}`);
  }
});

test("the winning template is named, not just the winning student", () => {
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("stu-a", 0.93, "old"), candidate("stu-a", 0.97, "new")],
    DIM,
    policy(),
  );
  assert.equal(result.best?.embeddingId, "emb-stu-a-new");
});

// ===========================================================================
// 9. Aggregation policy
// ===========================================================================

test("two faces in ONE capture claiming the same student is demoted to review", () => {
  // A person appears once in a still photograph. Two hits mean the recogniser
  // is confusing people, and confusion must not read as confident presence.
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.95 }),
      faceResult({ detectedFaceId: "1:1", faceIndex: 1, candidateStudentId: "stu-a", similarityScore: 0.88 }),
    ],
    policy(),
  );
  assert.equal(rows.length, 1, "still one row per student");
  assert.equal(rows[0].matchStatus, "UNCERTAIN");
  assert.equal(rows[0].advisoryResult, "NEEDS_REVIEW");
  assert.deepEqual(rows[0].downgrades, ["duplicate_within_capture"]);
});

test("the same student across TWO captures is not demoted — that is the point of a second photo", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", imageSequenceNumber: 1, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.5, decision: "UNCERTAIN" }),
      faceResult({ detectedFaceId: "2:0", imageSequenceNumber: 2, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.95 }),
    ],
    policy(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].matchStatus, "MATCHED");
  assert.deepEqual(rows[0].downgrades, []);
  assert.equal(rows[0].bestFaceId, "2:0", "the clearer photo wins");
});

test("aggregation is deterministic when two observations tie exactly", () => {
  // Same similarity, same confidence: the earliest capture wins, so re-running
  // the pipeline on the same faces cannot produce a different register.
  const faces = [
    faceResult({ detectedFaceId: "2:0", imageSequenceNumber: 2, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.9, detectionConfidence: 0.9 }),
    faceResult({ detectedFaceId: "1:0", imageSequenceNumber: 1, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.9, detectionConfidence: 0.9 }),
  ];
  const forwards = aggregateByStudent(faces, policy());
  const backwards = aggregateByStudent([...faces].reverse(), policy());
  assert.equal(forwards[0].bestFaceId, "1:0");
  assert.equal(backwards[0].bestFaceId, "1:0");
  assert.deepEqual(forwards, backwards);
});

test("a tie on similarity is broken by detection confidence before capture order", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", imageSequenceNumber: 1, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.9, detectionConfidence: 0.7 }),
      faceResult({ detectedFaceId: "2:0", imageSequenceNumber: 2, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.9, detectionConfidence: 0.99 }),
    ],
    policy(),
  );
  assert.equal(rows[0].bestFaceId, "2:0");
});

test("no combination of observations can promote a student above their best face", () => {
  // Three uncertain looks are not one certain one.
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "1:0", imageSequenceNumber: 1, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.5, decision: "UNCERTAIN" }),
      faceResult({ detectedFaceId: "2:0", imageSequenceNumber: 2, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.52, decision: "UNCERTAIN" }),
      faceResult({ detectedFaceId: "3:0", imageSequenceNumber: 3, faceIndex: 0, candidateStudentId: "stu-a", similarityScore: 0.55, decision: "UNCERTAIN" }),
    ],
    policy(),
  );
  assert.equal(rows[0].matchStatus, "UNCERTAIN");
  assert.equal(rows[0].advisoryResult, "NEEDS_REVIEW");
});

test("every observation is preserved as provenance, in capture order", () => {
  const rows = aggregateByStudent(
    [
      faceResult({ detectedFaceId: "3:1", imageSequenceNumber: 3, faceIndex: 1, candidateStudentId: "stu-a", similarityScore: 0.7, decision: "UNCERTAIN" }),
      faceResult({ detectedFaceId: "1:2", imageSequenceNumber: 1, faceIndex: 2, candidateStudentId: "stu-a", similarityScore: 0.95 }),
    ],
    policy(),
  );
  assert.equal(rows[0].observations.length, 2);
  assert.deepEqual(
    rows[0].observations.map((o) => [o.captureNumber, o.faceIndex]),
    [[1, 2], [3, 1]],
  );
  assert.equal(rows[0].observations[0].similarity, 0.95);
  assert.equal(rows[0].observations[1].matchStatus, "UNCERTAIN");
});

// ===========================================================================
// 10. Authorization, bounds and failure modes
// ===========================================================================

test("a subject session demands the subject link, not merely cohort access", async () => {
  const h = harness({
    session: makeSession({ cohortSubjectId: "cs-1" }),
    subjectPool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, REFERENCE)],
  });
  await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.deepEqual(h.calls.requireCohortSubjectAccess, ["cs-1"]);
});

test("a colleague who teaches the class but not the subject is refused", async () => {
  const h = harness({
    session: makeSession({ cohortSubjectId: "cs-1" }),
    subjectAccessError: new ForbiddenError("not_subject_faculty"),
    faces: [detectedFace(1, REFERENCE)],
  });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    ForbiddenError,
  );
  assert.equal(h.calls.detectEmbed.length, 0, "no classroom image may leave the process");
});

test("a daily session never consults the subject gate", async () => {
  const h = harness({ faces: [] });
  await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.deepEqual(h.calls.requireCohortSubjectAccess, []);
});

test("a finalized session is refused before any image is sent", async () => {
  const h = harness({ session: makeSession({ status: "FINALIZED" }) });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /session_locked:FINALIZED/,
  );
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("a cancelled session is refused before any image is sent", async () => {
  const h = harness({ session: makeSession({ status: "CANCELLED" }) });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /session_locked:CANCELLED/,
  );
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("a fourth image is refused by the service, not only by the action schema", async () => {
  const h = harness();
  const four = {
    sessionId: "sess-1",
    images: [1, 2, 3, 1].map((n) => ({
      sequenceNumber: n as 1 | 2 | 3,
      imageBase64: "x".repeat(64),
    })),
  };
  await assert.rejects(() => runRecognitionForSession(makeUser(), four, h.deps), /too_many_images/);
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("two payloads claiming the same capture number are refused", async () => {
  // Otherwise both would produce `1:0` and one photograph's faces would be
  // counted twice — including by the duplicate-within-capture rule.
  const h = harness();
  const collide = {
    sessionId: "sess-1",
    images: [
      { sequenceNumber: 2 as const, imageBase64: "x".repeat(64) },
      { sequenceNumber: 2 as const, imageBase64: "y".repeat(64) },
    ],
  };
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), collide, h.deps),
    /duplicate_image_sequence/,
  );
  assert.equal(h.calls.detectEmbed.length, 0);
});

test("an empty image list is refused rather than reported as a class of absentees", async () => {
  const h = harness();
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), { sessionId: "sess-1", images: [] }, h.deps),
    /no_images/,
  );
});

test("a face-ai service that stops responding fails within the timeout", async () => {
  const h = harness();
  h.deps!.detectTimeoutMs = 20;
  h.deps!.detectEmbed = () => new Promise(() => {});
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /face_ai_timeout/,
  );
});

test("a run carries the template behind each advisory, so a match can be traced", async () => {
  const h = harness({ pool: [poolRow("stu-a", 0.95)], faces: [detectedFace(1, REFERENCE)] });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.perStudent[0].bestEmbeddingId, "emb-stu-a");
  assert.equal(summary.perFace[0].candidateEmbeddingId, "emb-stu-a");
});

test("a run records when it happened and how long it took", async () => {
  const h = harness({ faces: [] });
  h.deps!.now = () => new Date("2026-09-20T09:30:00.000Z");
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.completedAt, "2026-09-20T09:30:00.000Z");
  assert.ok(summary.durationMs >= 0);
});

// ===========================================================================
// 11. Web ↔ face-ai contract at recognition time
// ===========================================================================

test("embeddings from a different model than the pool was filtered by are refused, not scored", async () => {
  // model-info said mock; by the time detect-embed ran, a new revision was
  // serving SFace. Same width, different space — scoring them is meaningless.
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, REFERENCE)],
    responseModel: { modelName: "opencv-yunet-sface", modelVersion: "yunet-2023mar+sface-2021dec+pp1" },
  });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /face_ai_model_changed/,
  );
});

test("a preprocessing bump alone is enough to refuse the run", async () => {
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, REFERENCE)],
    responseModel: { modelName: "mock", modelVersion: "0.1.0+pp2" },
  });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /face_ai_model_changed/,
  );
});

test("a NaN in a returned face embedding fails the run instead of reading as no match", async () => {
  const broken = [...REFERENCE];
  broken[5] = Number.NaN;
  const h = harness({ pool: [poolRow("stu-a", 0.95)], faces: [detectedFace(1, broken)] });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /face_ai_invalid_embedding:not_finite/,
  );
});

test("a wrong-width returned face embedding fails the run", async () => {
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, new Array<number>(DIM * 4).fill(1 / Math.sqrt(DIM * 4)))],
  });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /face_ai_invalid_embedding:wrong_dimension/,
  );
});

test("an unnormalised returned face embedding fails the run", async () => {
  const h = harness({
    pool: [poolRow("stu-a", 0.95)],
    faces: [detectedFace(1, REFERENCE.map((x) => x * 3))],
  });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps),
    /face_ai_invalid_embedding:not_normalised/,
  );
});

test("a student holding several templates counts once in the pool and once as unmatched", async () => {
  const sample = (id: string, similarity: number) => ({ ...poolRow("stu-a", similarity), id });
  const h = harness({
    pool: [sample("emb-a1", 0.1), sample("emb-a2", 0.12), sample("emb-a3", 0.08), poolRow("stu-b", 0.95)],
    faces: [detectedFace(1, REFERENCE)],
  });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.candidatePoolSize, 2);
  assert.deepEqual(summary.unmatchedStudentIds, ["stu-a"]);
  assert.equal(summary.perStudent[0].studentId, "stu-b");
});

// ===========================================================================
// Group photographs
//
// A class photo is many faces scored against many students at once, so the
// 2-D angle fixtures above are not enough: here every student's template is
// its own axis, and a face is built as a weighted mix of axes. The weight on a
// student's axis *is* the face's cosine similarity to that student; whatever
// weight is left over goes on an axis private to the face, so it resembles
// nobody else by accident. All synthetic — no photograph is involved.
// ===========================================================================

const NOISE_AXIS_BASE = 64;
let noiseAxis = NOISE_AXIS_BASE;

function axis(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

/** A unit face with the given similarity to each student axis. */
function faceMix(weights: Record<number, number>): number[] {
  const v = new Array<number>(DIM).fill(0);
  let used = 0;
  for (const [i, w] of Object.entries(weights)) {
    v[Number(i)] = w;
    used += w * w;
  }
  assert.ok(used <= 1 + 1e-9, "weights must fit in a unit vector");
  if (noiseAxis >= DIM) noiseAxis = NOISE_AXIS_BASE;
  v[noiseAxis++] = Math.sqrt(Math.max(0, 1 - used));
  return v;
}

function studentRow(index: number, opts: { sample?: string; modelVersion?: string } = {}) {
  const studentId = `stu-${index}`;
  return {
    id: `emb-${studentId}-${opts.sample ?? "a"}`,
    studentId,
    modelName: "mock",
    modelVersion: opts.modelVersion ?? "0.1.0+pp1",
    embeddingDim: DIM,
    embedding: axis(index),
  } satisfies CandidateEmbeddingWithVector;
}

function flaggedFace(
  sequenceNumber: 1 | 2 | 3,
  embedding: number[],
  qualityFlags: string[],
): DetectEmbedResponse["faces"][number] {
  return { ...detectedFace(sequenceNumber, embedding), qualityFlags, faceSize: 30 } as DetectEmbedResponse["faces"][number];
}


function byStudent(summary: { perStudent: Array<{ studentId: string }> }) {
  return new Map(summary.perStudent.map((s) => [s.studentId, s as (typeof summary.perStudent)[number] & Record<string, unknown>]));
}

test("group photo: every student in a 40-face photo is suggested once, and only once", async () => {
  const n = 40;
  const pool = Array.from({ length: n }, (_, i) => studentRow(i));
  const faces = Array.from({ length: n }, (_, i) => detectedFace(1, faceMix({ [i]: 0.8 })));
  const h = harness({ pool, faces });
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(summary.detectedFacesTotal, n);
  assert.equal(summary.perStudent.length, n);
  assert.ok(summary.perStudent.every((s) => s.advisoryResult === "PRESENT"));
  assert.equal(new Set(summary.perFace.map((f) => f.candidateStudentId)).size, n);
  assert.equal(summary.unknownFacesTotal, 0);
  assert.deepEqual(summary.unmatchedStudentIds, []);
});

test("group photo: a face that resembles nobody is an unknown face, never a student", async () => {
  const pool = [studentRow(0), studentRow(1)];
  const faces = [detectedFace(1, faceMix({ 0: 0.9 })), detectedFace(1, faceMix({ 1: 0.3 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  const stranger = summary.perFace[1];
  assert.equal(stranger.unknown, true);
  assert.equal(stranger.candidateStudentId, null);
  assert.equal(stranger.decision, "UNMATCHED");
  assert.equal(summary.unknownFacesTotal, 1);
  assert.deepEqual(summary.perStudent.map((s) => s.studentId), ["stu-0"]);
  assert.deepEqual(summary.unmatchedStudentIds, ["stu-1"]);
});

test("group photo: one student cannot be claimed by two faces in the same photo", async () => {
  // Both faces look most like stu-0. The clearer one keeps her; the other
  // resembles nobody else, so it is an unknown face — not a second stu-0.
  const pool = [studentRow(0), studentRow(1)];
  const faces = [detectedFace(1, faceMix({ 0: 0.92 })), detectedFace(1, faceMix({ 0: 0.7 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  assert.equal(summary.perFace.filter((f) => f.candidateStudentId === "stu-0").length, 1);
  assert.equal(summary.perFace[0].candidateStudentId, "stu-0", "the clearer face wins");
  assert.equal(summary.perFace[1].unknown, true);
  const stu0 = summary.perStudent.find((s) => s.studentId === "stu-0")!;
  // Something else in the room looks like her, so she goes to a person.
  assert.equal(stu0.advisoryResult, "NEEDS_REVIEW");
  assert.ok(stu0.downgrades.includes("duplicate_within_capture"));
  assert.equal(summary.unknownFacesTotal, 1);
});

test("group photo: a face given its second choice is never a confident match", async () => {
  // Face 2 is most like stu-0 (0.75) but stu-0 went to a clearer face; its
  // next-best, stu-1 at 0.65, clears the present bar on its own — and is
  // still only a review, because it is a second choice.
  const pool = [studentRow(0), studentRow(1)];
  const faces = [
    detectedFace(1, faceMix({ 0: 0.95 })),
    detectedFace(1, faceMix({ 0: 0.75, 1: 0.65 })),
  ];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  const second = summary.perFace[1];
  assert.equal(second.candidateStudentId, "stu-1");
  assert.deepEqual(second.demotions, ["reassigned"]);
  assert.equal(second.decision, "UNCERTAIN");
  assert.equal(second.runnerUpStudentId, "stu-0", "the lost first choice stays visible");
  const stu1 = summary.perStudent.find((s) => s.studentId === "stu-1")!;
  assert.equal(stu1.advisoryResult, "NEEDS_REVIEW");
  assert.ok(stu1.downgrades.includes("reassigned_face"));
});

test("group photo: two similar-looking students both go to review", async () => {
  const pool = [studentRow(0), studentRow(1)];
  const faces = [detectedFace(1, faceMix({ 0: 0.7, 1: 0.68 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  assert.equal(summary.perStudent.length, 1);
  assert.equal(summary.perStudent[0].advisoryResult, "NEEDS_REVIEW");
  assert.equal(summary.perStudent[0].wasAmbiguous, true);
  assert.deepEqual(summary.perFace[0].demotions, ["ambiguous"]);
});

test("group photo: a face too small to trust is capped at review however well it scores", async () => {
  const pool = [studentRow(0)];
  const faces = [flaggedFace(1, faceMix({ 0: 0.95 }), ["face_too_small"])];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  const stu0 = summary.perStudent[0];
  assert.equal(stu0.advisoryResult, "NEEDS_REVIEW");
  assert.deepEqual(stu0.downgrades, ["low_quality_face"]);
  assert.deepEqual(stu0.bestQualityFlags, ["face_too_small"]);
  assert.equal(stu0.wasAmbiguous, false, "a poor photo is not a confusion between students");
  assert.deepEqual(summary.flaggedFaces, { face_too_small: 1 });
  assert.equal(summary.recommendRetake, true);
});

test("group photo: a flagged face that scores in the review band is not demoted twice", async () => {
  const pool = [studentRow(0)];
  const faces = [flaggedFace(1, faceMix({ 0: 0.5 }), ["blurred"])];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  assert.equal(summary.perStudent[0].advisoryResult, "NEEDS_REVIEW");
  assert.deepEqual(summary.perFace[0].demotions, []);
  assert.equal(summary.recommendRetake, false, "blur is not a reason to stand closer");
});

test("group photo: faces too small to embed are counted, and a closer photo is recommended", async () => {
  const pool = [studentRow(0)];
  const rejected = [
    { sequenceNumber: 1, boundingBox: { x: 0, y: 0, width: 12, height: 12 }, detectionConfidence: 0.8, reason: "face_too_small", faceSize: 12 },
    { sequenceNumber: 1, boundingBox: { x: 40, y: 0, width: 14, height: 14 }, detectionConfidence: 0.8, reason: "face_too_small", faceSize: 14 },
  ] as DetectEmbedResponse["rejectedFaces"];
  const summary = await runRecognitionForSession(
    makeUser(),
    ONE_IMAGE,
    harness({ pool, faces: [detectedFace(1, faceMix({ 0: 0.9 }))], rejectedFaces: rejected }).deps,
  );
  assert.deepEqual(summary.rejectedFaces, { face_too_small: 2 });
  assert.equal(summary.recommendRetake, true);
  assert.equal(summary.perStudent[0].advisoryResult, "PRESENT", "the usable face is unaffected");
});

test("group photo: the same student in three photos is one student, with three observations", async () => {
  const pool = [studentRow(0), studentRow(1)];
  const faces = [
    detectedFace(1, faceMix({ 0: 0.8 })),
    detectedFace(2, faceMix({ 0: 0.85 })),
    detectedFace(3, faceMix({ 0: 0.9 })),
    detectedFace(2, faceMix({ 1: 0.8 })),
  ];
  const summary = await runRecognitionForSession(makeUser(), THREE_IMAGES, harness({ pool, faces }).deps);
  const students = byStudent(summary);
  assert.equal(students.size, 2);
  const stu0 = summary.perStudent.find((s) => s.studentId === "stu-0")!;
  assert.equal(stu0.advisoryResult, "PRESENT");
  assert.equal(stu0.observations.length, 3);
  assert.ok(Math.abs((stu0.bestSimilarity ?? 0) - 0.9) < 1e-9, "the strongest evidence is kept");
  assert.equal(stu0.bestFaceId, "3:0");
  assert.deepEqual(stu0.downgrades, []);
});

test("group photo: a student with several templates yields one result", async () => {
  const pool = [studentRow(0, { sample: "a" }), studentRow(0, { sample: "b" }), studentRow(0, { sample: "c" })];
  const faces = [detectedFace(1, faceMix({ 0: 0.8 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  assert.equal(summary.perStudent.length, 1);
  assert.equal(summary.perStudent[0].advisoryResult, "PRESENT");
  assert.equal(summary.candidatePoolSize, 1, "one student, not three");
});

test("group photo: a template from an older model build is never compared", async () => {
  // Would be a perfect match — and must not count, because a vector from a
  // different model build lives in a different space.
  const pool = [studentRow(0, { modelVersion: "0.0.9+pp1" }), studentRow(1)];
  const faces = [detectedFace(1, faceMix({ 0: 0.99 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  assert.equal(summary.skippedIncompatibleCandidates, 1);
  assert.equal(summary.perStudent.length, 0);
  assert.equal(summary.perFace[0].unknown, true);
});

test("group photo: only the session's own cohort is ever searched", async () => {
  const h = harness({ pool: [studentRow(0)], faces: [detectedFace(1, faceMix({ 0: 0.9 }))] });
  await runRecognitionForSession(makeUser(), ONE_IMAGE, h.deps);
  assert.equal(h.calls.loadCandidates.length, 1);
  assert.equal(h.calls.loadCandidates[0][0], "co-1");
  assert.equal(h.calls.loadSubjectCandidates.length, 0);
});

test("group photo: an empty class makes every face an unknown face", async () => {
  const faces = [detectedFace(1, faceMix({ 0: 0.9 })), detectedFace(1, faceMix({ 1: 0.9 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool: [], faces }).deps);
  assert.equal(summary.candidatePoolSize, 0);
  assert.equal(summary.perStudent.length, 0);
  assert.equal(summary.unknownFacesTotal, 2);
  assert.ok(summary.perFace.every((f) => f.unknown && f.candidateStudentId === null));
});

test("group photo: no faces at all reports no faces, no strangers and no retake advice", async () => {
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool: [studentRow(0)], faces: [] }).deps);
  assert.equal(summary.detectedFacesTotal, 0);
  assert.equal(summary.unknownFacesTotal, 0);
  assert.equal(summary.recommendRetake, false);
  assert.deepEqual(summary.rejectedFaces, {});
  assert.deepEqual(summary.unmatchedStudentIds, ["stu-0"]);
});

test("group photo: the same stranger in two photos is counted once", async () => {
  const stranger = faceMix({ 5: 0.2 });
  const faces = [detectedFace(1, stranger), detectedFace(2, stranger), detectedFace(2, faceMix({ 6: 0.2 }))];
  const summary = await runRecognitionForSession(makeUser(), THREE_IMAGES, harness({ pool: [studentRow(0)], faces }).deps);
  assert.equal(summary.unknownFacesTotal, 2);
});

test("group photo: the summary carries no embedding, even for unknown faces", async () => {
  const faces = [detectedFace(1, faceMix({ 0: 0.9 })), detectedFace(1, faceMix({ 1: 0.1 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool: [studentRow(0)], faces }).deps);
  const json = JSON.stringify(summary);
  assert.ok(!json.includes("embedding\""), "no embedding field");
  // No array anywhere in the summary is as wide as a face vector.
  const wide = (v: unknown): boolean =>
    Array.isArray(v) ? v.length >= DIM || v.some(wide) : v !== null && typeof v === "object" ? Object.values(v).some(wide) : false;
  assert.equal(wide(summary), false);
});

// ---------------------------------------------------------------------------
// The assignment and clustering primitives, directly
// ---------------------------------------------------------------------------

function scored(studentId: string, similarity: number, rawSimilarity = similarity) {
  return { studentId, embeddingId: `emb-${studentId}`, similarity, rawSimilarity };
}

test("assignFacesOneToOne gives each student to the face that resembles them most", () => {
  const { assignments, contested } = assignFacesOneToOne(
    [
      { faceIndex: 0, byStudent: [scored("a", 0.7), scored("b", 0.6)] },
      { faceIndex: 1, byStudent: [scored("a", 0.9), scored("c", 0.5)] },
    ],
    policy(),
  );
  assert.equal(assignments[1].assigned?.studentId, "a");
  assert.equal(assignments[1].reassigned, false);
  assert.equal(assignments[0].assigned?.studentId, "b");
  assert.equal(assignments[0].reassigned, true);
  assert.equal(assignments[0].topChoice?.studentId, "a");
  assert.deepEqual([...contested], ["a"]);
});

test("assignFacesOneToOne never assigns below the review floor", () => {
  const { assignments } = assignFacesOneToOne(
    [{ faceIndex: 0, byStudent: [scored("a", 0.44)] }],
    policy(),
  );
  assert.equal(assignments[0].assigned, null);
  assert.equal(assignments[0].topChoice, null);
});

test("assignFacesOneToOne is independent of the order faces arrive in", () => {
  const faces = [
    { faceIndex: 0, byStudent: [scored("a", 0.8), scored("b", 0.79)] },
    { faceIndex: 1, byStudent: [scored("b", 0.8), scored("a", 0.79)] },
    { faceIndex: 2, byStudent: [scored("a", 0.8)] },
  ];
  const forward = assignFacesOneToOne(faces, policy()).assignments.map((a) => a.assigned?.studentId ?? null);
  const reversed = assignFacesOneToOne([...faces].reverse(), policy())
    .assignments.reverse()
    .map((a) => a.assigned?.studentId ?? null);
  assert.deepEqual(forward, reversed);
  // A tie on similarity goes to the lower face index, deterministically.
  assert.deepEqual(forward, ["a", "b", null]);
});

test("countDistinctUnknownFaces never merges two faces from the same photo", () => {
  const v = faceMix({ 7: 0.1 });
  assert.equal(
    countDistinctUnknownFaces(
      [
        { captureNumber: 1, embedding: v },
        { captureNumber: 1, embedding: v },
      ],
      { presentMin: 0.62 },
    ),
    2,
  );
  assert.equal(countDistinctUnknownFaces([], { presentMin: 0.62 }), 0);
});

// ---------------------------------------------------------------------------
// Reading one backend's scale
// ---------------------------------------------------------------------------

/** The map services/face-ai publishes for the dlib recogniser. */
const DLIB_CALIBRATION = {
  id: "dlib-resnet-v1.azure-d03.2026-09-24",
  knots: [
    { raw: -1, calibrated: -1 },
    { raw: 0.93, calibrated: 0.45 },
    { raw: 0.955, calibrated: 0.62 },
    { raw: 1, calibrated: 1 },
  ],
  rawAmbiguityMargin: 0.01,
};

test("a raw score that clears presentMin is not a match once calibrated", () => {
  // 0.94 raw is two different people for this recogniser. Read as though it
  // were already on the product's scale, it marks a stranger present — the
  // single failure this whole mechanism exists to prevent.
  const uncalibrated = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.94)],
    DIM,
    policy(),
  );
  assert.equal(uncalibrated.decision, "MATCHED");

  const calibrated = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.94)],
    DIM,
    policy({ calibration: DLIB_CALIBRATION }),
  );
  assert.equal(calibrated.decision, "UNCERTAIN");
  assert.ok(calibrated.best!.similarity < 0.62);
  assert.equal(calibrated.best!.rawSimilarity.toFixed(4), "0.9400");
});

test("a genuinely confident raw score still matches after calibration", () => {
  // The map must not simply refuse everything: 0.97 raw is the same person.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.97)],
    DIM,
    policy({ calibration: DLIB_CALIBRATION }),
  );
  assert.equal(result.decision, "MATCHED");
});

test("a raw score below the review knot is no match at all", () => {
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.9)],
    DIM,
    policy({ calibration: DLIB_CALIBRATION }),
  );
  assert.equal(result.decision, "UNMATCHED");
});

test("both scales are reported, so a stored result stays explainable", () => {
  const { byStudent } = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.97), candidate("s2", 0.9)],
    DIM,
    policy({ calibration: DLIB_CALIBRATION }),
  );
  for (const scored of byStudent) {
    assert.notEqual(scored.similarity, scored.rawSimilarity);
    assert.ok(scored.similarity <= 1 && scored.similarity >= -1);
  }
});

test("two students within the backend's raw margin are ambiguous, not present", () => {
  // Their calibrated scores are 0.05 apart — clear of the institution's
  // margin — but 0.004 apart raw, which is the same face to this recogniser.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.985), candidate("s2", 0.981)],
    DIM,
    policy({ calibration: DLIB_CALIBRATION, ambiguityMargin: 0.01 }),
  );
  assert.ok(result.best!.similarity - result.runnerUp!.similarity > 0.01);
  assert.ok(result.best!.rawSimilarity - result.runnerUp!.rawSimilarity < 0.01);
  assert.equal(result.wasAmbiguous, true);
  assert.equal(result.decision, "UNCERTAIN");
});

test("the institution's margin still applies on top of the backend's", () => {
  // Far apart on the raw scale, close on the calibrated one.
  const result = scoreFaceAgainstCandidates(
    REFERENCE,
    [candidate("s1", 0.97), candidate("s2", 0.9695)],
    DIM,
    policy({ calibration: DLIB_CALIBRATION, ambiguityMargin: 0.05 }),
  );
  assert.equal(result.wasAmbiguous, true);
});

test("unknown visitors are clustered on the calibrated scale", () => {
  // Read raw, two strangers 0.9 apart from nobody would merge into one
  // visitor, because 0.9 clears presentMin 0.62 on the wrong scale.
  const a = vecAtSimilarity(1);
  const b = vecAtSimilarity(0.9);
  const faces = [
    { captureNumber: 1, embedding: a },
    { captureNumber: 2, embedding: b },
  ];
  assert.equal(countDistinctUnknownFaces(faces, { presentMin: 0.62 }), 1);
  assert.equal(
    countDistinctUnknownFaces(faces, { presentMin: 0.62, calibration: DLIB_CALIBRATION }),
    2,
  );
});

test("the same visitor across two photographs is still one visitor", () => {
  const a = vecAtSimilarity(1);
  const b = vecAtSimilarity(0.98);
  assert.equal(
    countDistinctUnknownFaces(
      [
        { captureNumber: 1, embedding: a },
        { captureNumber: 2, embedding: b },
      ],
      { presentMin: 0.62, calibration: DLIB_CALIBRATION },
    ),
    1,
  );
});

// ---------------------------------------------------------------------------
// One student, one face (the worked example from the specification)
// ---------------------------------------------------------------------------

test("a student contested by two faces is given to one of them and reviewed", () => {
  // Three faces in a photograph. F1 and F2 both want Rahul; F3 wants Priya:
  //   F1 -> Rahul .81, Aman .79
  //   F2 -> Rahul .80, Aman .65
  //   F3 -> Priya .90
  // Rahul cannot be in two places in one photograph. The assignment gives him
  // to the face that resembles him most, and the other face falls to its own
  // next choice rather than being dropped or given the same student again.
  const { assignments, contested } = assignFacesOneToOne(
    [
      { faceIndex: 0, byStudent: [scored("rahul", 0.81), scored("aman", 0.79)] },
      { faceIndex: 1, byStudent: [scored("rahul", 0.8), scored("aman", 0.65)] },
      { faceIndex: 2, byStudent: [scored("priya", 0.9)] },
    ],
    policy(),
  );

  assert.deepEqual(
    assignments.map((a) => a.assigned?.studentId ?? null),
    ["rahul", "aman", "priya"],
  );
  // No student appears twice.
  const assigned = assignments.map((a) => a.assigned?.studentId).filter(Boolean);
  assert.equal(new Set(assigned).size, assigned.length);
  // F2 did not get its first choice, and that is recorded rather than hidden.
  assert.equal(assignments[1].reassigned, true);
  assert.equal(assignments[1].topChoice?.studentId, "rahul");
  // Rahul was wanted by two faces, so his result is a teacher's to confirm.
  assert.deepEqual([...contested], ["rahul"]);
});

// ---------------------------------------------------------------------------
// Identical twins and other lookalikes
// ---------------------------------------------------------------------------
//
// dlib cannot reliably tell identical twins apart: on public-domain photographs
// 17-29% of cross-twin comparisons reached the present threshold (docs, "Twins").
// Two students whose own templates would confidently match each other are
// lookalikes, and a match to either is never PRESENT on the recogniser's word.

/** Twin B: a template at cosine `c` to twin A's (axis 0), off along axis 1. */
function twinRow(c: number) {
  const v = new Array<number>(DIM).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return {
    id: "emb-twin-b",
    studentId: "twin-b",
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    embeddingDim: DIM,
    embedding: v,
  } satisfies CandidateEmbeddingWithVector;
}

function template(studentId: string, embedding: number[], sample = "a"): CandidateTemplate {
  return {
    embeddingId: `emb-${studentId}-${sample}`,
    studentId,
    embedding,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
  };
}

test("findLookalikeStudents pairs students whose templates confidently match", () => {
  const pairs = findLookalikeStudents(
    [
      template("a", axis(0)),
      template("b", twinRow(0.7).embedding),
      template("c", axis(2)),
      // A student's own samples never make them their own lookalike.
      template("c", faceMix({ 2: 0.99 }), "b"),
    ],
    DIM,
    policy(),
  );
  assert.deepEqual([...(pairs.get("a") ?? [])], ["b"]);
  assert.deepEqual([...(pairs.get("b") ?? [])], ["a"]);
  assert.equal(pairs.has("c"), false);
});

test("findLookalikeStudents reads templates on the backend's calibrated scale", () => {
  // 0.94 raw is two different people for dlib — a lookalike, not a twin.
  // 0.96 raw would be a confident match: those two are paired.
  const calibration = {
    id: "dlib-test",
    knots: [
      { raw: -1, calibrated: -1 },
      { raw: 0.93, calibrated: 0.45 },
      { raw: 0.955, calibrated: 0.62 },
      { raw: 1, calibrated: 1 },
    ],
    rawAmbiguityMargin: 0.01,
  };
  const at = (c: number) => twinRow(c).embedding;
  const loose = findLookalikeStudents([template("a", axis(0)), template("b", at(0.94))], DIM, policy({ calibration }));
  const tight = findLookalikeStudents([template("a", axis(0)), template("b", at(0.96))], DIM, policy({ calibration }));
  assert.equal(loose.size, 0);
  assert.equal(tight.size, 2);
});

test("twins: a confident-looking match to one twin still goes to review", async () => {
  // Before: 0.95 against twin A, 0.665 against twin B — a margin wide enough
  // to mark A present. Between identical twins that margin is not evidence.
  const pool = [studentRow(0), twinRow(0.7), studentRow(2)];
  pool[0] = { ...pool[0], studentId: "twin-a", id: "emb-twin-a" };
  const faces = [detectedFace(1, faceMix({ 0: 0.95 })), detectedFace(1, faceMix({ 2: 0.95 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);

  const students = byStudent(summary);
  assert.equal(students.get("twin-a")?.advisoryResult, "NEEDS_REVIEW");
  assert.ok((students.get("twin-a")?.downgrades as string[]).includes("ambiguous_face"));
  // An unrelated classmate in the same photograph is unaffected.
  assert.equal(students.get("stu-2")?.advisoryResult, "PRESENT");
});

test("twins: both in one photograph each get one face, and both go to review", async () => {
  const b = twinRow(0.7);
  const pool = [{ ...studentRow(0), studentId: "twin-a", id: "emb-twin-a" }, b];
  // Twin B's face: close to B's template (0.95), less so to A's.
  const bFace = b.embedding.map((x) => x * 0.95);
  bFace[5] = Math.sqrt(1 - 0.95 * 0.95);
  const faces = [detectedFace(1, faceMix({ 0: 0.95 })), detectedFace(1, bFace)];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);

  const claimed = summary.perFace.map((f) => f.candidateStudentId);
  assert.deepEqual(claimed, ["twin-a", "twin-b"], "one face each: one-to-one still holds");
  for (const s of summary.perStudent) assert.equal(s.advisoryResult, "NEEDS_REVIEW");
});

test("twins: a twin in another class is no reason to doubt this one", async () => {
  // Lookalikes are found within the pool being searched. Twin B is not in
  // this class, so nothing in this photograph can be confused with them.
  const pool = [{ ...studentRow(0), studentId: "twin-a", id: "emb-twin-a" }, studentRow(2)];
  const faces = [detectedFace(1, faceMix({ 0: 0.95 }))];
  const summary = await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  assert.equal(byStudent(summary).get("twin-a")?.advisoryResult, "PRESENT");
});

test("the run log counts lookalikes without naming anybody", async () => {
  const pool = [{ ...studentRow(0), studentId: "twin-a", id: "emb-twin-a" }, twinRow(0.7)];
  const faces = [detectedFace(1, faceMix({ 0: 0.95 }))];
  const lines: string[] = [];
  const original = console.info;
  console.info = (line: string) => void lines.push(line);
  try {
    await runRecognitionForSession(makeUser(), ONE_IMAGE, harness({ pool, faces }).deps);
  } finally {
    console.info = original;
  }
  const run = JSON.parse(lines.find((l) => l.includes("recognition.run"))!);
  assert.equal(run.lookalikeStudents, 2);
  assert.doesNotMatch(lines.join("\n"), /twin-a|twin-b/);
});
