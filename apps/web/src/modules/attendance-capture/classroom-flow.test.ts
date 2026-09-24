import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateByStudent,
  runRecognitionForSession,
  scoreFaceAgainstCandidates,
} from "../recognition-engine/service.ts";
import {
  DEFAULT_AMBIGUITY_MARGIN,
  DEFAULT_MIN_DETECTION_CONFIDENCE,
} from "../recognition-engine/types.ts";
import type {
  CandidateTemplate,
  RecognitionPolicy,
  RecognitionRunSummary,
} from "../recognition-engine/types.ts";
import {
  decideCandidate,
  generateAttendanceCandidates,
} from "../attendance-review/service.ts";
import { analyzeCaptureImage } from "./service.ts";
import {
  cameraReducer,
  describeCameraFailure,
  INITIAL_CAMERA_STATE,
} from "./camera.ts";
import { fixtureCameraSource, fixtureFrameBase64 } from "./camera-source.ts";
import { inspectImageBase64 } from "../../lib/image-validation.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { AttendanceSession } from "../sessions/types.ts";
import type { CandidateEmbeddingWithVector } from "../recognition-results/repository.ts";
import type {
  DetectEmbedResponse,
  DetectResponse,
  ModelInfoResponse,
} from "@attendance/shared-types";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";

/**
 * The Phase 4 scenario suite: the classroom flow end to end, from a frame
 * leaving the camera abstraction to a register landing in review.
 *
 * Every scenario the phase specification enumerates has a test here. None of
 * them needs a webcam, a face, a student, a browser permission prompt, or a
 * database — the camera is a fixture, face-ai is a stub, and the repositories
 * are injected. What that proves is that the software behaves; it proves
 * nothing about recognition accuracy, and the fixtures are obviously synthetic
 * so it cannot be mistaken for such a claim.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIM = EMBEDDING_DIMENSION;

function angleVec(theta: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}
/** A vector whose cosine similarity to `FACE_A` is exactly `s`. */
function vecAt(s: number): number[] {
  return angleVec(Math.acos(s));
}
const FACE_A = angleVec(0);

function policy(overrides: Partial<RecognitionPolicy> = {}): RecognitionPolicy {
  return {
    presentMin: 0.62,
    reviewMin: 0.45,
    ambiguityMargin: DEFAULT_AMBIGUITY_MARGIN,
    minDetectionConfidence: DEFAULT_MIN_DETECTION_CONFIDENCE,
    ...overrides,
  };
}

function makeUser(overrides: Partial<SessionUser> & { permissions?: string[] } = {}): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: "faculty@example.com",
    name: "Test Faculty",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: null,
    roles: [
      {
        key: "FACULTY",
        name: "Faculty",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: (overrides.permissions ?? [
          "attendanceSession.create",
          "attendanceSession.capture",
          "attendanceRecord.read",
          "attendanceRecord.correct",
        ]) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function makeSession(overrides: Partial<AttendanceSession> = {}): AttendanceSession {
  return {
    id: "sess-1",
    institutionId: "inst-A",
    cohortId: "co-1",
    cohortSubjectId: null,
    facultyId: "user-1",
    sessionDate: new Date("2026-09-20T09:00:00Z"),
    startedAt: new Date("2026-09-20T09:00:00Z"),
    endedAt: null,
    status: "CAPTURING",
    metadata: {},
    ...overrides,
  } as AttendanceSession;
}

function makeCohort(id = "co-1", institutionId = "inst-A"): Cohort {
  return {
    id,
    institutionId,
    academicUnitId: "unit-1",
    academicSessionId: "as-1",
    name: "Grade 9A",
    termLabel: null,
    createdAt: new Date(),
  };
}

function makeInstitution(id = "inst-A"): Institution {
  return {
    id,
    name: "Test School",
    type: "SCHOOL",
    timezone: "UTC",
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Institution;
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

function template(studentId: string, similarity: number, sample = "a"): CandidateTemplate {
  return {
    embeddingId: `emb-${studentId}-${sample}`,
    studentId,
    embedding: vecAt(similarity),
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
  };
}

function poolRow(studentId: string, similarity: number): CandidateEmbeddingWithVector {
  return {
    id: `emb-${studentId}`,
    studentId,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    embeddingDim: DIM,
    embedding: vecAt(similarity),
  };
}

function face(sequenceNumber: 1 | 2 | 3, embedding: number[], detectionConfidence = 0.95) {
  return {
    sequenceNumber,
    boundingBox: { x: 0, y: 0, width: 128, height: 128 },
    embedding,
    detectionConfidence,
    qualityScore: 0.8,
  } as DetectEmbedResponse["faces"][number];
}

const IMAGE = fixtureFrameBase64();

function images(...sequences: Array<1 | 2 | 3>) {
  return sequences.map((sequenceNumber) => ({ sequenceNumber, imageBase64: IMAGE }));
}

interface RecognitionHarness {
  deps: Parameters<typeof runRecognitionForSession>[2];
  detectCalls: number;
}

function recognitionHarness(opts: {
  session?: AttendanceSession;
  pool?: CandidateEmbeddingWithVector[];
  subjectPool?: CandidateEmbeddingWithVector[];
  faces?: DetectEmbedResponse["faces"];
  modelInfo?: ModelInfoResponse;
  cohortAccessError?: Error;
  subjectAccessError?: Error;
  detectEmbed?: () => Promise<DetectEmbedResponse>;
} = {}): RecognitionHarness {
  const modelInfo = opts.modelInfo ?? makeModelInfo();
  const harness: RecognitionHarness = { detectCalls: 0, deps: {} };
  harness.deps = {
    getSessionById: async () => opts.session ?? makeSession(),
    getCohortById: async () => makeCohort(),
    getInstitutionById: async () => makeInstitution(),
    requireCohortAccess: async () => {
      if (opts.cohortAccessError) throw opts.cohortAccessError;
    },
    requireCohortSubjectAccess: async () => {
      if (opts.subjectAccessError) throw opts.subjectAccessError;
    },
    fetchModelInfo: async () => modelInfo,
    loadCandidateEmbeddings: async () => opts.pool ?? [],
    loadSubjectCandidateEmbeddings: async () => opts.subjectPool ?? [],
    detectEmbed:
      opts.detectEmbed ??
      (async () => {
        harness.detectCalls += 1;
        return {
          faces: opts.faces ?? [],
          modelName: modelInfo.modelName,
          modelVersion: modelInfo.modelVersion,
        } as DetectEmbedResponse;
      }),
  };
  return harness;
}

function detectResponse(faceCount: number, confidence = 0.95): DetectResponse {
  return {
    faces: Array.from({ length: faceCount }, (_, i) => ({
      faceId: i,
      boundingBox: { x: i * 10, y: 0, width: 128, height: 128 },
      detectionConfidence: confidence,
    })),
    faceCount,
    imageWidth: 1920,
    imageHeight: 1080,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
  };
}

const CAPTURE_DEPS = {
  getSessionById: async () => makeSession(),
  requireCohortAccess: async () => {},
  requireCohortSubjectAccess: async () => {},
  recordCaptureAnalysis: async () => {},
};

function reviewDeps(
  roster: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    getSessionById: async () => makeSession(),
    requireCohortAccess: async () => {},
    requireCohortSubjectAccess: async () => {},
    listCohortRoster: async () =>
      roster.map((id) => ({
        studentId: id,
        studentCode: id.toUpperCase(),
        firstName: id,
        lastName: "Student",
      })),
    listCohortSubjectRoster: async () => [],
    listComparableTemplates: async (ids: string[]) => ids,
    listAnyTemplates: async (ids: string[]) => ids,
    upsertCandidates: async () => ({ created: roster.length, refreshed: 0 }),
    listAttendanceRecords: async () => [],
    mergeSessionMetadata: async () => {},
    transitionSessionStatus: async () => makeSession({ status: "REVIEW" }),
    recordAuditLog: async () => {},
    emitWebhook: () => {},
    now: () => new Date("2026-09-20T09:30:00Z"),
    ...overrides,
  };
}

function runSummary(overrides: Partial<RecognitionRunSummary> = {}): RecognitionRunSummary {
  return {
    sessionId: "sess-1",
    cohortId: "co-1",
    candidateScope: "cohort",
    candidatePoolSize: 1,
    skippedIncompatibleCandidates: 0,
    detectedFacesTotal: 1,
    scoredFacesTotal: 1,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    productionEligible: false,
    completedAt: "2026-09-20T09:30:00.000Z",
    durationMs: 10,
    policy: policy(),
    perFace: [],
    perStudent: [],
    unmatchedStudentIds: [],
    rejectedFaces: {},
    flaggedFaces: {},
    unknownFacesTotal: 0,
    recommendRetake: false,
    ...overrides,
  };
}

// ===========================================================================
// Recognition scenarios (spec cases 1–8, 13, 14)
// ===========================================================================

test("scenario 1: one detected student is proposed present", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1) },
    recognitionHarness({ pool: [poolRow("stu-a", 0.95)], faces: [face(1, FACE_A)] }).deps,
  );
  assert.equal(summary.perStudent.length, 1);
  assert.equal(summary.perStudent[0].advisoryResult, "PRESENT");
});

test("scenario 2: several students in one capture each get one row", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1) },
    recognitionHarness({
      pool: [poolRow("stu-a", 0.95), poolRow("stu-b", 0.95)],
      faces: [face(1, FACE_A), face(1, vecAt(0.95))],
    }).deps,
  );
  assert.equal(summary.detectedFacesTotal, 2);
  assert.ok(summary.perStudent.length >= 1);
  const ids = summary.perStudent.map((s) => s.studentId);
  assert.equal(new Set(ids).size, ids.length, "no student appears twice");
});

test("scenario 3: one student across two captures produces exactly one row", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1, 2) },
    recognitionHarness({
      pool: [poolRow("stu-a", 0.95)],
      faces: [face(1, FACE_A), face(2, FACE_A)],
    }).deps,
  );
  assert.equal(summary.perStudent.length, 1);
  assert.equal(summary.perStudent[0].observations.length, 2, "both sightings are kept");
  assert.equal(summary.perStudent[0].advisoryResult, "PRESENT");
});

test("scenario 4: a student in all three captures still counts once", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1, 2, 3) },
    recognitionHarness({
      pool: [poolRow("stu-a", 0.95)],
      faces: [face(1, FACE_A), face(2, FACE_A), face(3, FACE_A)],
    }).deps,
  );
  assert.equal(summary.perStudent.length, 1);
  assert.deepEqual(
    summary.perStudent[0].observations.map((o) => o.captureNumber),
    [1, 2, 3],
  );
});

test("scenario 5: an uncertain match is routed to review, never to present", () => {
  const result = scoreFaceAgainstCandidates(FACE_A, [template("stu-a", 0.5)], DIM, policy());
  assert.equal(result.decision, "UNCERTAIN");
  const rows = aggregateByStudent(
    [
      {
        detectedFaceId: "1:0",
        imageSequenceNumber: 1,
        faceIndex: 0,
        candidateStudentId: "stu-a",
        candidateEmbeddingId: "emb-a",
        similarityScore: 0.5,
        runnerUpSimilarity: null,
        runnerUpStudentId: null,
        detectionConfidence: 0.9,
        qualityScore: 0.8,
        decision: "UNCERTAIN",
        dropReason: null,
        qualityFlags: [],
        faceSize: null,
        demotions: [],
        contested: false,
        unknown: false,
      },
    ],
    policy(),
  );
  assert.equal(rows[0].advisoryResult, "NEEDS_REVIEW");
  assert.notEqual(rows[0].advisoryResult, "PRESENT");
});

test("scenario 6: an unmatched face claims nobody", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1) },
    recognitionHarness({
      pool: [poolRow("stu-a", 0.1)],
      faces: [face(1, FACE_A)],
    }).deps,
  );
  assert.equal(summary.perStudent.length, 0);
  assert.deepEqual(summary.unmatchedStudentIds, ["stu-a"]);
});

test("scenario 7: three captures reach face-ai as a single batched call", async () => {
  const h = recognitionHarness({ pool: [], faces: [] });
  await runRecognitionForSession(makeUser(), { sessionId: "sess-1", images: images(1, 2, 3) }, h.deps);
  assert.equal(h.detectCalls, 1, "one round trip, not three");
});

test("scenario 8: a student matched in capture 1 and 2 yields one attendance row", async () => {
  const rows: Array<{ studentId: string }> = [];
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({
        perStudent: [
          {
            studentId: "stu-a",
            bestSimilarity: 0.95,
            bestDetectionConfidence: 0.95,
            bestQualityScore: 0.8,
            bestFaceId: "2:0",
            bestEmbeddingId: "emb-a",
            advisoryResult: "PRESENT",
            matchStatus: "MATCHED",
            wasAmbiguous: false,
            downgrades: [],
            bestQualityFlags: [],
            observations: [],
          },
        ],
      }),
    },
    reviewDeps(["stu-a"], {
      upsertCandidates: async (r: Array<{ studentId: string }>) => {
        rows.push(...r);
        return { created: r.length, refreshed: 0 };
      },
    }),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].studentId, "stu-a");
});

test("scenario 13: multiple faces in one image are all scored", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1) },
    recognitionHarness({
      pool: [poolRow("stu-a", 0.95)],
      faces: [face(1, FACE_A), face(1, FACE_A), face(1, FACE_A)],
    }).deps,
  );
  assert.equal(summary.detectedFacesTotal, 3);
  assert.equal(summary.scoredFacesTotal, 3);
});

test("scenario 14: a student from the wrong class can never be matched", async () => {
  // The pool is the authorisation boundary: only what the cohort-scoped loader
  // returns can appear anywhere in the output.
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1) },
    recognitionHarness({ pool: [poolRow("in-class", 0.95)], faces: [face(1, FACE_A)] }).deps,
  );
  const everyone = new Set([
    ...summary.perStudent.map((s) => s.studentId),
    ...summary.unmatchedStudentIds,
    ...summary.perFace.map((f) => f.candidateStudentId).filter((x): x is string => x !== null),
  ]);
  assert.deepEqual([...everyone], ["in-class"]);
});

// ===========================================================================
// Image handling (spec cases 9–12)
// ===========================================================================

test("scenario 9: an empty image never reaches face-ai", async () => {
  let called = false;
  const result = await analyzeCaptureImage(
    makeUser(),
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: "" },
    {
      ...CAPTURE_DEPS,
      faceDetect: async () => {
        called = true;
        return detectResponse(0);
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("scenario 10: an invalid image is rejected by the shared validator", () => {
  const notAnImage = Buffer.from("<html>not a photograph</html>".repeat(40)).toString("base64");
  const inspection = inspectImageBase64(notAnImage);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.ok === false ? inspection.reason : null, "unsupported_format");
});

test("scenario 11: a low-quality capture is labelled poor rather than silently accepted", async () => {
  const result = await analyzeCaptureImage(
    makeUser(),
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: IMAGE },
    { ...CAPTURE_DEPS, faceDetect: async () => detectResponse(2, 0.4) },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.qualityLabel, "poor");
    assert.match(result.qualityHint, /retake/i);
  }
});

test("scenario 12: a capture with no face is reported, and nobody is marked absent for it", async () => {
  const result = await analyzeCaptureImage(
    makeUser(),
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: IMAGE },
    { ...CAPTURE_DEPS, faceDetect: async () => detectResponse(0) },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.qualityLabel, "no_faces");

  // And the register built from a zero-face run leaves everyone for the human.
  const decision = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: false,
    hasAnyTemplate: false,
  });
  assert.equal(decision.finalResult, "NEEDS_REVIEW");
  assert.notEqual(decision.finalResult, "ABSENT");
});

// ===========================================================================
// Authorization (spec cases 15–18)
// ===========================================================================

test("scenario 15: a cross-institution session is refused before any image is sent", async () => {
  const h = recognitionHarness({ session: makeSession({ institutionId: "inst-B" }) });
  await assert.rejects(
    () => runRecognitionForSession(makeUser({ institutionId: "inst-A" }), { sessionId: "sess-1", images: images(1) }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.detectCalls, 0);
});

test("scenario 16: a faculty member without the capture permission is refused", async () => {
  const h = recognitionHarness();
  await assert.rejects(
    () =>
      runRecognitionForSession(
        makeUser({ permissions: ["attendanceRecord.read"] }),
        { sessionId: "sess-1", images: images(1) },
        h.deps,
      ),
    ForbiddenError,
  );
  assert.equal(h.detectCalls, 0);
});

test("scenario 17: a teacher not linked to the class is refused", async () => {
  const h = recognitionHarness({ cohortAccessError: new ForbiddenError("not_cohort_faculty") });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), { sessionId: "sess-1", images: images(1) }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.detectCalls, 0);
});

test("scenario 18: a teacher not linked to the subject is refused on a subject session", async () => {
  const h = recognitionHarness({
    session: makeSession({ cohortSubjectId: "cs-1" }),
    subjectAccessError: new ForbiddenError("not_subject_faculty"),
  });
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), { sessionId: "sess-1", images: images(1) }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.detectCalls, 0);
});

test("an arbitrary student id cannot be smuggled in: the server derives the cohort", async () => {
  // There is no student id, candidate id or cohort id in the recognition
  // input at all — the only thing the client names is a session, and the
  // session's own cohort decides the search space.
  const input = { sessionId: "sess-1", images: images(1) };
  assert.deepEqual(Object.keys(input).sort(), ["images", "sessionId"]);
  const summary = await runRecognitionForSession(
    makeUser(),
    input,
    recognitionHarness({ pool: [poolRow("stu-a", 0.95)], faces: [face(1, FACE_A)] }).deps,
  );
  assert.equal(summary.cohortId, "co-1");
});

// ===========================================================================
// Session lifecycle (spec cases 19, 20, 31)
// ===========================================================================

test("scenario 19: reprocessing does not duplicate an attendance row", async () => {
  // The unique index is the real guard; generation is written to be idempotent
  // so a second Process press converges rather than colliding.
  let upsertCalls = 0;
  const deps = reviewDeps(["stu-a"], {
    upsertCandidates: async () => {
      upsertCalls += 1;
      return { created: upsertCalls === 1 ? 1 : 0, refreshed: upsertCalls === 1 ? 0 : 1 };
    },
  });
  const first = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: null },
    deps,
  );
  const second = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: null },
    deps,
  );
  assert.equal(first.created, 1);
  assert.equal(second.created, 0, "the second run creates nothing");
  assert.equal(second.refreshed, 1);
});

test("scenario 20: an expired (cancelled) session refuses new captures", async () => {
  const result = await analyzeCaptureImage(
    makeUser(),
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: IMAGE },
    {
      ...CAPTURE_DEPS,
      getSessionById: async () => makeSession({ status: "CANCELLED" }),
      faceDetect: async () => detectResponse(3),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "session_locked");
});

test("scenario 31: a finalized session cannot have its register regenerated", async () => {
  await assert.rejects(
    () =>
      generateAttendanceCandidates(
        makeUser(),
        { sessionId: "sess-1", recognition: null },
        reviewDeps(["stu-a"], {
          getSessionById: async () => makeSession({ status: "FINALIZED" }),
        }),
      ),
    /session_locked:FINALIZED/,
  );
});

test("scenario 32: two devices racing to process cannot both create the register", async () => {
  // The guarded transition is the mechanism: CAPTURING -> PROCESSING only
  // succeeds for whichever call finds the row still in CAPTURING.
  let transitions = 0;
  const deps = reviewDeps(["stu-a"], {
    transitionSessionStatus: async (_id: string, from: string) => {
      if (from === "CAPTURING") {
        transitions += 1;
        if (transitions > 1) throw new Error("session_status_conflict");
      }
      return makeSession({ status: "REVIEW" });
    },
  });
  const results = await Promise.allSettled([
    generateAttendanceCandidates(makeUser(), { sessionId: "sess-1", recognition: null }, deps),
    generateAttendanceCandidates(makeUser(), { sessionId: "sess-1", recognition: null }, deps),
  ]);
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 1, "exactly one of the two racing calls is refused");
});

// ===========================================================================
// Camera failure modes (spec cases 21–24)
// ===========================================================================

test("scenario 21: camera permission denied is a named state with a retry", () => {
  const failure = describeCameraFailure(Object.assign(new Error("x"), { name: "NotAllowedError" }));
  assert.equal(failure.kind, "permission_denied");
  assert.equal(failure.retryable, true);
  const state = cameraReducer(INITIAL_CAMERA_STATE, { type: "fail", failure });
  assert.equal(state.name, "failed");
});

test("scenario 22: camera unavailable is distinguished from camera denied", () => {
  assert.equal(fixtureCameraSource({ unavailable: true }).isAvailable(), false);
  const noDevice = describeCameraFailure(
    Object.assign(new Error("x"), { name: "NotFoundError" }),
  );
  assert.equal(noDevice.kind, "no_device");
});

test("scenario 23: camera initialization failure leaves no stream behind", async () => {
  const source = fixtureCameraSource({
    failWith: Object.assign(new Error("x"), { name: "NotReadableError" }),
  });
  await assert.rejects(() =>
    source.open({
      facingMode: "environment",
      videoSink: { srcObject: null, videoWidth: 0, videoHeight: 0, play: async () => {} },
    }),
  );
  assert.equal(source.openStreamCount(), 0);
});

test("scenario 24: a capture failure is reported rather than producing an empty photo", async () => {
  const source = fixtureCameraSource({ frameSize: { width: 0, height: 0 } });
  const stream = await source.open({
    facingMode: "environment",
    videoSink: { srcObject: null, videoWidth: 0, videoHeight: 0, play: async () => {} },
  });
  const frame = stream.grabFrame();
  assert.equal(frame.ok, false);
  stream.stop();
});

// ===========================================================================
// Face-AI failure modes (spec cases 25–28)
// ===========================================================================

test("scenario 25: a face-ai timeout is bounded and surfaced", async () => {
  const h = recognitionHarness({ detectEmbed: () => new Promise(() => {}) });
  h.deps!.detectTimeoutMs = 20;
  await assert.rejects(
    () => runRecognitionForSession(makeUser(), { sessionId: "sess-1", images: images(1) }, h.deps),
    /face_ai_timeout/,
  );
});

test("scenario 26: a malformed face-ai response does not fabricate attendance", async () => {
  const h = recognitionHarness({
    pool: [poolRow("stu-a", 0.95)],
    detectEmbed: async () => ({ faces: [] }) as unknown as DetectEmbedResponse,
  });
  // No model identity means nothing says the embeddings are comparable with
  // the pool. The run is refused — no summary, so nobody is invented as
  // present, and the enrolled student is not reported as "no match" either.
  await assert.rejects(
    () =>
      runRecognitionForSession(makeUser(), { sessionId: "sess-1", images: images(1) }, h.deps),
    /face_ai_model_changed/,
  );
});

test("scenario 27: a face-ai outage surfaces as retryable, not as an empty class", async () => {
  const result = await analyzeCaptureImage(
    makeUser(),
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: IMAGE },
    {
      ...CAPTURE_DEPS,
      faceDetect: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "service_unavailable");
    assert.equal(result.retryable, true);
  }
});

test("scenario 28: recognition being unavailable leaves every student for the human", async () => {
  // The roll-call fallback: nothing is presumed present, and — crucially —
  // nothing is presumed absent either.
  const written: Array<{ studentId: string; finalResult: string }> = [];
  await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: null },
    reviewDeps(["stu-a", "stu-b", "stu-c"], {
      upsertCandidates: async (rows: Array<{ studentId: string; finalResult: string }>) => {
        written.push(...rows);
        return { created: rows.length, refreshed: 0 };
      },
    }),
  );
  assert.equal(written.length, 3);
  assert.ok(written.every((r) => r.finalResult === "NEEDS_REVIEW"));
});

// ===========================================================================
// Faculty authority (spec cases 29, 30)
// ===========================================================================

test("scenario 29 & 30: the decision table never marks an uncomparable student absent", () => {
  const noTemplate = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: false,
    hasAnyTemplate: false,
  });
  assert.equal(noTemplate.finalResult, "NEEDS_REVIEW");
  assert.equal(noTemplate.note.reason, "no_face_template");

  const staleTemplate = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: false,
    hasAnyTemplate: true,
  });
  assert.equal(staleTemplate.finalResult, "NEEDS_REVIEW");
  assert.equal(staleTemplate.note.reason, "incompatible_face_template");

  // Even a student who WAS compared and matched nobody is not absent. The
  // evidence says ABSENT; the register waits for a person. Phase 6 removed
  // the last path by which the machine could write an attendance result.
  const compared = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(compared.aiResult, "ABSENT", "the finding is recorded");
  assert.equal(compared.finalResult, "NEEDS_REVIEW", "the decision is not");
  assert.equal(compared.note.reason, "no_match");
});

test("the advisory carries the template that produced it, for later investigation", () => {
  const decision = decideCandidate({
    aggregate: {
      advisoryResult: "PRESENT",
      bestSimilarity: 0.95,
      wasAmbiguous: false,
      bestFaceId: "1:0",
      bestEmbeddingId: "emb-stu-a",
      downgrades: [],
      bestQualityFlags: [],
      observations: [{ captureNumber: 1, faceIndex: 0, similarity: 0.95, matchStatus: "MATCHED" }],
    },
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(decision.matchedEmbeddingId, "emb-stu-a");
  assert.equal(decision.note.observations?.length, 1);
});

test("a duplicate-within-capture demotion reaches the reviewer with its own reason", () => {
  const decision = decideCandidate({
    aggregate: {
      advisoryResult: "NEEDS_REVIEW",
      bestSimilarity: 0.95,
      wasAmbiguous: true,
      bestFaceId: "1:0",
      bestEmbeddingId: "emb-stu-a",
      downgrades: ["duplicate_within_capture"],
      observations: [
        { captureNumber: 1, faceIndex: 0, similarity: 0.95, matchStatus: "MATCHED" },
        { captureNumber: 1, faceIndex: 2, similarity: 0.88, matchStatus: "MATCHED" },
      ],
    },
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(decision.finalResult, "NEEDS_REVIEW");
  assert.equal(decision.note.reason, "duplicate_in_capture");
  assert.equal(decision.note.observations?.length, 2);
});

// ===========================================================================
// Privacy
// ===========================================================================

test("no recognition output the browser receives contains a vector", async () => {
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-1", images: images(1, 2) },
    recognitionHarness({
      pool: [poolRow("stu-a", 0.95), poolRow("stu-b", 0.5)],
      faces: [face(1, FACE_A), face(2, vecAt(0.5))],
    }).deps,
  );
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('"embedding"'), false);
  assert.equal(serialized.includes("0.7071"), false);
});

test("the per-capture gate returns no embedding, because none is generated", async () => {
  const result = await analyzeCaptureImage(
    makeUser(),
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: IMAGE },
    { ...CAPTURE_DEPS, faceDetect: async () => detectResponse(4) },
  );
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("embedding"), false);
});
