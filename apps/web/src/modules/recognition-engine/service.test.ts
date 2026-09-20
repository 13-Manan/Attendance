import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateByStudent,
  buildRecognitionPolicyForInstitution,
  classifyBySimilarity,
  cosineSimilarity,
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
import type { DetectEmbedRequest, DetectEmbedResponse, ModelInfoResponse } from "@attendance/shared-types";

// ---------------------------------------------------------------------------
// Vector fixtures
//
// Every test embedding lives in the plane spanned by the first two axes of a
// 512-d space: v(theta) = [cos t, sin t, 0, 0, ...]. Cosine similarity
// between v(a) and v(b) is then exactly cos(a - b), so a test can ask for a
// pair of vectors at a *precise* similarity instead of hand-tuning floats.
// ---------------------------------------------------------------------------

const DIM = 512;

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
function poolRow(studentId: string, similarity: number, dim = DIM): CandidateEmbeddingWithVector {
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
  modelInfo?: ModelInfoResponse;
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
          modelName: modelInfo.modelName,
          modelVersion: modelInfo.modelVersion,
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
    embedding: new Array<number>(128).fill(0.5),
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
    pool: [poolRow("stu-legacy", 0.9, 128), poolRow("stu-a", 0.9)],
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
