import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countUnknownFacesWithoutVectors,
  runRecognitionForSession,
  scoreGalleryCandidates,
} from "./service.ts";
import { describeRecognitionAvailability, recognitionAvailability } from "./wording.ts";
import type { RecognitionPolicy } from "./types.ts";
import { GALLERY_RECOGNITION_THRESHOLDS } from "../face-gallery/policy.ts";
import type { GalleryCandidate } from "../face-gallery/repository.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { AttendanceSession } from "../sessions/types.ts";
import type {
  IdentificationStatus,
  IdentifiedFace,
  IdentifyCandidate,
  IdentifyRequest,
  IdentifyResponse,
  ModelInfoResponse,
} from "@attendance/shared-types";

// Gallery-backed recognition (Azure AI Face). Every provider response here is
// a hand-written fixture: no test in this file reaches Azure.

const GALLERY_POLICY: RecognitionPolicy = {
  ...GALLERY_RECOGNITION_THRESHOLDS,
  minDetectionConfidence: 0.5,
};

function owners(...pairs: Array<[string, string]>) {
  return new Map(pairs.map(([personId, studentId]) => [personId, { studentId, embeddingId: `fe-${studentId}` }]));
}

function c(personId: string, confidence: number): IdentifyCandidate {
  return { personId, confidence };
}

// ---------------------------------------------------------------------------
// Pure scoring
// ---------------------------------------------------------------------------

test("a clear gallery match above presentMin is MATCHED", () => {
  const r = scoreGalleryCandidates([c("p1", 0.9)], owners(["p1", "stu-1"]), GALLERY_POLICY);
  assert.equal(r.decision, "MATCHED");
  assert.equal(r.best?.studentId, "stu-1");
  assert.equal(r.best?.embeddingId, "fe-stu-1");
  assert.equal(r.wasAmbiguous, false);
});

test("two students within the ambiguity margin go to review, never Present", () => {
  const r = scoreGalleryCandidates(
    [c("p1", 0.86), c("p2", 0.8)],
    owners(["p1", "stu-1"], ["p2", "stu-2"]),
    GALLERY_POLICY,
  );
  assert.equal(r.decision, "UNCERTAIN");
  assert.equal(r.wasAmbiguous, true);
  assert.equal(r.runnerUp?.studentId, "stu-2");
});

test("a confidence between reviewMin and presentMin needs review", () => {
  const r = scoreGalleryCandidates([c("p1", 0.6)], owners(["p1", "stu-1"]), GALLERY_POLICY);
  assert.equal(r.decision, "UNCERTAIN");
});

test("below reviewMin is no match", () => {
  const r = scoreGalleryCandidates([c("p1", 0.45)], owners(["p1", "stu-1"]), GALLERY_POLICY);
  assert.equal(r.decision, "UNMATCHED");
});

test("a person who resolves to nobody on this register is never attributed", () => {
  const r = scoreGalleryCandidates([c("stale", 0.95)], owners(["p1", "stu-1"]), GALLERY_POLICY);
  assert.equal(r.best, null);
  assert.equal(r.decision, "UNMATCHED");
});

test("an off-register look-alike close to the best student forces review", () => {
  // The face resembles somebody who is not on this register (left the class,
  // or a retired sample) almost as much as it resembles stu-1.
  const r = scoreGalleryCandidates(
    [c("outsider", 0.9), c("p1", 0.85)],
    owners(["p1", "stu-1"]),
    GALLERY_POLICY,
  );
  assert.equal(r.best?.studentId, "stu-1");
  assert.equal(r.decision, "UNCERTAIN");
  assert.equal(r.wasAmbiguous, true);
});

test("two persons for one student count once, at the stronger confidence", () => {
  const r = scoreGalleryCandidates(
    [c("p1", 0.8), c("p1b", 0.9)],
    owners(["p1", "stu-1"], ["p1b", "stu-1"]),
    GALLERY_POLICY,
  );
  assert.equal(r.byStudent.length, 1);
  assert.equal(r.best?.similarity, 0.9);
  assert.equal(r.runnerUp, null);
  assert.equal(r.decision, "MATCHED");
});

test("non-finite confidences are ignored", () => {
  const r = scoreGalleryCandidates([c("p1", Number.NaN)], owners(["p1", "stu-1"]), GALLERY_POLICY);
  assert.equal(r.best, null);
});

test("unknown faces without vectors count the largest single photo", () => {
  assert.equal(countUnknownFacesWithoutVectors([]), 0);
  assert.equal(countUnknownFacesWithoutVectors([1, 1, 2]), 2);
  assert.equal(countUnknownFacesWithoutVectors([1, 2, 3]), 1);
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const MODEL: ModelInfoResponse = {
  modelName: "azure-face",
  modelVersion: "detection_03+recognition_04",
  weightsVersion: "recognition_04",
  preprocessingVersion: "azure",
  embeddingDim: 0,
  embeddingNormalized: false,
  runtime: "azure",
  commercialUse: "permitted",
  productionEligible: true,
  contractVersion: "v1",
  templateKind: "gallery",
  identification: "enabled",
};

const USER: SessionUser = {
  userId: "user-1",
  email: "faculty@example.com",
  name: "Faculty",
  institutionId: "inst-A",
  campusId: null,
  roles: [
    {
      key: "FACULTY",
      name: "Faculty",
      institutionId: "inst-A",
      campusId: null,
      permissions: ["cohort.read", "attendanceSession.capture"] as SessionUser["roles"][number]["permissions"],
    },
  ],
};

function face(sequenceNumber: 1 | 2 | 3, candidates: IdentifyCandidate[], extra: Partial<IdentifiedFace> = {}): IdentifiedFace {
  return {
    sequenceNumber,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    detectionConfidence: 0.95,
    qualityScore: 0.9,
    qualityFlags: [],
    faceSize: 100,
    landmarks: null,
    candidates,
    ...extra,
  };
}

function gallery(opts: {
  pool?: GalleryCandidate[];
  subjectPool?: GalleryCandidate[];
  faces?: IdentifiedFace[];
  identification?: IdentificationStatus;
  session?: Partial<AttendanceSession>;
  responseModel?: string;
  identify?: (req: IdentifyRequest) => Promise<IdentifyResponse>;
}) {
  const calls = { identify: [] as IdentifyRequest[], loads: [] as unknown[][], detectEmbed: 0 };
  const deps: Parameters<typeof runRecognitionForSession>[2] = {
    getSessionById: async () =>
      ({
        id: "sess-1",
        institutionId: "inst-A",
        cohortId: "co1",
        cohortSubjectId: null,
        status: "CAPTURING",
        metadata: {},
        ...opts.session,
      }) as AttendanceSession,
    getCohortById: async () => ({ id: "co1", institutionId: "inst-A" }) as Cohort,
    getInstitutionById: async () => ({ id: "inst-A", settings: {} }) as Institution,
    requireCohortAccess: async () => {},
    requireCohortSubjectAccess: async () => {},
    fetchModelInfo: async () => MODEL,
    detectEmbed: async () => {
      calls.detectEmbed++;
      throw new Error("the vector path must not run for a gallery model");
    },
    loadCandidateEmbeddings: async () => {
      throw new Error("vector templates must not be loaded for a gallery model");
    },
    loadGalleryCandidates: async (galleryId, scope, model) => {
      calls.loads.push([galleryId, scope, model]);
      return scope.cohortSubjectId ? (opts.subjectPool ?? []) : (opts.pool ?? []);
    },
    identifyFaces:
      opts.identify ??
      (async (req) => {
        calls.identify.push(req);
        return {
          faces: opts.faces ?? [],
          rejectedFaces: [],
          images: [],
          identification: opts.identification ?? "enabled",
          galleryReady: true,
          identifyBatches: 1,
          modelName: opts.responseModel ?? MODEL.modelName,
          modelVersion: MODEL.modelVersion,
          timings: null,
        };
      }),
  };
  return { calls, deps };
}

const IMG = (n: 1 | 2 | 3) => ({ sequenceNumber: n, imageBase64: "x".repeat(64) });
const INPUT = { sessionId: "sess-1", images: [IMG(1)] };

function pool(...ids: string[]): GalleryCandidate[] {
  return ids.map((id) => ({ personId: `p-${id}`, studentId: id, faceEmbeddingId: `fe-${id}` }));
}

test("a gallery run identifies against this class's gallery only, with bounded candidates", async () => {
  const { calls, deps } = gallery({ pool: pool("s1"), faces: [face(1, [c("p-s1", 0.9)])] });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.identify[0].galleryId, "att-co1");
  assert.ok((calls.identify[0].maxCandidates ?? 0) <= 10);
  assert.equal(calls.detectEmbed, 0);
  assert.deepEqual(calls.loads[0], ["att-co1", { cohortId: "co1" }, { modelName: MODEL.modelName, modelVersion: MODEL.modelVersion }]);
  assert.equal(summary.templateKind, "gallery");
  assert.equal(summary.identification, "enabled");
  assert.deepEqual(summary.policy, { ...summary.policy, ...GALLERY_RECOGNITION_THRESHOLDS });
  assert.equal(summary.perStudent[0].studentId, "s1");
  assert.equal(summary.perStudent[0].advisoryResult, "PRESENT");
  assert.equal(summary.perStudent[0].bestEmbeddingId, "fe-s1");
});

test("one face is never two students and one student is never two faces", async () => {
  // Both faces' best candidate is s1; the stronger face keeps s1, the other
  // gets its second choice — and a second choice is never confident.
  const { deps } = gallery({
    pool: pool("s1", "s2"),
    faces: [face(1, [c("p-s1", 0.95), c("p-s2", 0.8)]), face(1, [c("p-s1", 0.85), c("p-s2", 0.8)])],
  });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  const byStudent = new Map(summary.perStudent.map((s) => [s.studentId, s]));
  assert.equal(byStudent.size, 2);
  assert.notEqual(byStudent.get("s2")?.advisoryResult, "PRESENT");
  const assigned = summary.perFace.filter((f) => f.candidateStudentId === "s1");
  assert.equal(assigned.length, 1);
});

test("unknown faces are counted, attributed to nobody, and not-detected students listed", async () => {
  const { deps } = gallery({
    pool: pool("s1", "s2"),
    faces: [face(1, [c("p-s1", 0.9)]), face(1, []), face(1, [c("stranger", 0.99)])],
  });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  assert.equal(summary.unknownFacesTotal, 2);
  assert.deepEqual(summary.unmatchedStudentIds, ["s2"]);
  assert.deepEqual(summary.comparableStudentIds, ["s1", "s2"]);
  assert.ok(summary.perFace.every((f) => f.candidateStudentId !== "stranger"));
});

test("a 40-face classroom is handled in one run, one advisory per student", async () => {
  const ids = Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const { deps } = gallery({
    pool: pool(...ids),
    faces: ids.map((id) => face(1, [c(`p-${id}`, 0.9)])),
  });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  assert.equal(summary.detectedFacesTotal, 40);
  assert.equal(summary.perStudent.length, 40);
  assert.equal(summary.perStudent.filter((s) => s.advisoryResult === "PRESENT").length, 40);
  assert.deepEqual(summary.unmatchedStudentIds, []);
});

test("one student in two photos is one advisory, and unknowns are not double counted", async () => {
  const { deps } = gallery({
    pool: pool("s1"),
    faces: [face(1, [c("p-s1", 0.9)]), face(2, [c("p-s1", 0.88)]), face(1, []), face(2, [])],
  });
  const summary = await runRecognitionForSession(USER, { sessionId: "sess-1", images: [IMG(1), IMG(2)] }, deps);
  assert.equal(summary.perStudent.length, 1);
  assert.equal(summary.perStudent[0].observations.length, 2);
  assert.equal(summary.unknownFacesTotal, 1);
});

test("a low-quality face may point at a student but never suggests them present", async () => {
  const { deps } = gallery({
    pool: pool("s1"),
    faces: [face(1, [c("p-s1", 0.95)], { qualityFlags: ["blurred"] })],
  });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  assert.equal(summary.perStudent[0].advisoryResult, "NEEDS_REVIEW");
});

test("identification not approved: faces are counted, nobody is compared or ruled out", async () => {
  const { deps } = gallery({
    pool: pool("s1", "s2"),
    identification: "not_approved",
    faces: [face(1, []), face(1, [])],
  });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  assert.equal(summary.identification, "not_approved");
  assert.equal(summary.detectedFacesTotal, 2);
  assert.equal(summary.scoredFacesTotal, 0);
  assert.equal(summary.perStudent.length, 0);
  assert.deepEqual(summary.unmatchedStudentIds, []);
  assert.equal(summary.unknownFacesTotal, 0);
  assert.ok(summary.perFace.every((f) => f.dropReason === "identification_unavailable"));
});

test("even if a not-approved response carried candidates, none are used", async () => {
  const { deps } = gallery({
    pool: pool("s1"),
    identification: "unavailable",
    faces: [face(1, [c("p-s1", 0.99)])],
  });
  const summary = await runRecognitionForSession(USER, INPUT, deps);
  assert.equal(summary.perStudent.length, 0);
});

test("a subject session searches the subject's students and falls back to the class", async () => {
  const subject = gallery({
    session: { cohortSubjectId: "cs-1" },
    subjectPool: pool("s1"),
    pool: pool("s1", "s2"),
    faces: [face(1, [c("p-s2", 0.95)])],
  });
  const s1 = await runRecognitionForSession(USER, INPUT, subject.deps);
  assert.equal(s1.candidateScope, "cohortSubject");
  // s2 is in the class but not the subject: never named.
  assert.equal(s1.perStudent.length, 0);

  const fallback = gallery({ session: { cohortSubjectId: "cs-1" }, pool: pool("s1"), faces: [] });
  const s2 = await runRecognitionForSession(USER, INPUT, fallback.deps);
  assert.equal(s2.candidateScope, "cohort");
  assert.equal(fallback.calls.loads.length, 2);
});

test("a model swap between model-info and identify is refused", async () => {
  const { deps } = gallery({ pool: pool("s1"), responseModel: "mock" });
  await assert.rejects(runRecognitionForSession(USER, INPUT, deps), /face_ai_model_changed/);
});

test("a provider failure (bad credential) surfaces as an error, never as an empty register", async () => {
  const { deps } = gallery({
    pool: pool("s1"),
    identify: async () => {
      throw new Error("face_ai_request_failed:/v1/identify:502:azure_auth_failed");
    },
  });
  await assert.rejects(runRecognitionForSession(USER, INPUT, deps), /azure_auth_failed/);
});

test("a stalled provider times out", async () => {
  const { deps } = gallery({ pool: pool("s1"), identify: () => new Promise(() => {}) });
  await assert.rejects(
    runRecognitionForSession(USER, INPUT, { ...deps, detectTimeoutMs: 20 }),
    /face_ai_timeout/,
  );
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test("a provider that may not identify yet is described honestly", () => {
  const state = { modelName: "azure-face", modelVersion: "x", productionEligible: true, identification: "not_approved" as const };
  assert.equal(recognitionAvailability(state), "identification_pending");
  const m = describeRecognitionAvailability(state, { showDiagnostics: false });
  assert.equal(m.headline, "Face identification is awaiting Azure approval");
  assert.match(m.detail, /nobody is matched/);
  assert.match(m.detail, /Nobody is marked present or absent automatically/);
  assert.equal(m.diagnostics, null);
  const outage = describeRecognitionAvailability({ ...state, identification: "unavailable" }, { showDiagnostics: false });
  assert.equal(outage.availability, "identification_pending");
  assert.doesNotMatch(outage.headline, /approval/);
  assert.equal(recognitionAvailability({ ...state, identification: "enabled" }), "ready");
  assert.equal(recognitionAvailability({ ...state, identification: undefined }), "ready");
});
