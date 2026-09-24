import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCaptureImage,
  cancelCaptureSession,
  listCapturableCohortsForActor,
  startOrResumeCaptureSession,
  summarizeCaptureSession,
} from "./service.ts";
import { MAX_CAPTURES_PER_SESSION } from "./types.ts";
import type { AnalyzeCaptureImageInput } from "./service.ts";
import type { CaptureImageAnalysis } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { AttendanceSession } from "../sessions/types.ts";
import type { DetectResponse } from "@attendance/shared-types";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "FACULTY",
        name: "Faculty",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function makeCohort(id: string, institutionId = "inst-A"): Cohort {
  return {
    id,
    institutionId,
    academicUnitId: "unit-1",
    academicSessionId: "sess-1",
    name: `Cohort ${id}`,
    termLabel: null,
    createdAt: new Date(),
  };
}

function makeInstitution(id = "inst-A", type: "SCHOOL" | "COLLEGE" = "SCHOOL"): Institution {
  return {
    id,
    name: "Test Institution",
    type,
    timezone: "UTC",
    settings: {},
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
    status: "OPEN",
    metadata: {},
    ...overrides,
  } as AttendanceSession;
}

/**
 * A `/v1/detect` response. Note what is absent: an embedding. The per-capture
 * gate runs the detector only, so there is no vector for the fixture to carry
 * and no vector for the result to leak.
 */
function makeDetectResponse(faceCount: number, confidence = 0.95): DetectResponse {
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

/** Swallows the metadata write so analyze tests need no database, and
 * answers the model-info read so they need no face-ai either. */
const NO_RECORD = {
  recordCaptureAnalysis: async () => {},
  fetchModelInfo: async () => ({ productionEligible: false }),
};

/** One per-capture verdict, as the server records it. */
function analysis(overrides: Partial<CaptureImageAnalysis> = {}): CaptureImageAnalysis {
  return {
    sequenceNumber: 1,
    faceCount: 12,
    averageDetectionConfidence: 0.9,
    averageQualityScore: null,
    imageWidth: 1920,
    imageHeight: 1080,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    productionEligible: false,
    qualityLabel: "good",
    qualityHint: "12 faces",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cohort listing
// ---------------------------------------------------------------------------

test("listCapturableCohortsForActor: faculty sees only linked cohorts", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.create"] });
  const cohorts = await listCapturableCohortsForActor(faculty, {
    listCohortsForFaculty: async (uid) => {
      assert.equal(uid, "user-1");
      return [makeCohort("co-1"), makeCohort("co-2")];
    },
    listCohortsByInstitution: async () => {
      throw new Error("must not be called for non-admins");
    },
    getInstitutionById: async () => makeInstitution("inst-A", "SCHOOL"),
  });
  assert.equal(cohorts.length, 2);
  assert.equal(cohorts[0].attendanceMode, "DAILY");
});

test("listCapturableCohortsForActor: admin with cohort.manage sees the whole institution", async () => {
  const admin = makeUser({ permissions: ["attendanceSession.create", "cohort.manage"] });
  let facultyCalled = false;
  const cohorts = await listCapturableCohortsForActor(admin, {
    listCohortsForFaculty: async () => {
      facultyCalled = true;
      return [];
    },
    listCohortsByInstitution: async (iid) => {
      assert.equal(iid, "inst-A");
      return [makeCohort("co-1"), makeCohort("co-2"), makeCohort("co-3")];
    },
    getInstitutionById: async () => makeInstitution("inst-A", "COLLEGE"),
  });
  assert.equal(facultyCalled, false, "admin path must not query the faculty index");
  assert.equal(cohorts.length, 3);
  // COLLEGE default → SUBJECT_WISE, which the client uses to decide whether
  // to route through a subject picker.
  assert.equal(cohorts[0].attendanceMode, "SUBJECT_WISE");
});

test("listCapturableCohortsForActor: rows from other institutions are filtered out", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.create"] });
  const cohorts = await listCapturableCohortsForActor(faculty, {
    listCohortsForFaculty: async () => [
      makeCohort("mine", "inst-A"),
      makeCohort("someone-elses", "inst-B"),
    ],
    getInstitutionById: async () => makeInstitution("inst-A"),
  });
  assert.deepEqual(
    cohorts.map((c) => c.id),
    ["mine"],
  );
});

test("listCapturableCohortsForActor: unauthorized without attendanceSession.create", async () => {
  const random = makeUser({ permissions: ["student.read"] });
  await assert.rejects(() => listCapturableCohortsForActor(random), ForbiddenError);
});

// ---------------------------------------------------------------------------
// Start / resume
// ---------------------------------------------------------------------------

test("startOrResumeCaptureSession: DAILY creates a session and moves it to CAPTURING", async () => {
  const admin = makeUser({
    permissions: ["attendanceSession.create", "attendanceSession.capture", "cohort.manage"],
  });
  let transitionCalled = false;
  const now = new Date("2026-09-15T09:00:00Z");

  const result = await startOrResumeCaptureSession(
    admin,
    { cohortId: "co-1" },
    {
      getCohortById: async () => makeCohort("co-1"),
      getInstitutionById: async () => makeInstitution("inst-A", "SCHOOL"),
      findExistingDailySession: async () => null,
      createAttendanceSession: async (_actor, input) => {
        assert.equal(input.cohortSubjectId, null);
        return makeSession({ id: "new-sess", status: "OPEN", cohortId: input.cohortId });
      },
      transitionSessionStatus: async (id, from, to) => {
        transitionCalled = true;
        assert.equal(from, "OPEN");
        assert.equal(to, "CAPTURING");
        return makeSession({ id, status: "CAPTURING" });
      },
      countEnrolledStudents: async () => 32,
      recordAuditLog: async () => {},
      now: () => now,
    },
  );

  assert.equal(transitionCalled, true);
  assert.equal(result.resumed, false);
  assert.equal(result.session.status, "CAPTURING");
  assert.equal(result.attendanceMode, "DAILY");
  assert.equal(result.enrolledStudentCount, 32);
});

test("startOrResumeCaptureSession: DAILY resumes an existing session for today", async () => {
  const faculty = makeUser({
    permissions: ["attendanceSession.create", "attendanceSession.capture"],
  });
  let createCalled = false;

  const result = await startOrResumeCaptureSession(
    faculty,
    { cohortId: "co-1" },
    {
      getCohortById: async () => makeCohort("co-1"),
      getInstitutionById: async () => makeInstitution("inst-A", "SCHOOL"),
      findExistingDailySession: async () => makeSession({ id: "existing", status: "OPEN" }),
      createAttendanceSession: async () => {
        createCalled = true;
        return makeSession();
      },
      transitionSessionStatus: async (id, from, to) => {
        assert.equal(from, "OPEN");
        assert.equal(to, "CAPTURING");
        return makeSession({ id, status: "CAPTURING" });
      },
      requireCohortAccess: async () => {},
      countEnrolledStudents: async () => 10,
      recordAuditLog: async () => {},
    },
  );

  assert.equal(createCalled, false, "must not create a duplicate DAILY session");
  assert.equal(result.resumed, true);
  assert.equal(result.session.status, "CAPTURING");
});

test("startOrResumeCaptureSession: SUBJECT_WISE requires cohortSubjectId", async () => {
  const faculty = makeUser({
    permissions: ["attendanceSession.create", "attendanceSession.capture", "cohort.manage"],
  });
  await assert.rejects(
    () =>
      startOrResumeCaptureSession(
        faculty,
        { cohortId: "co-1" },
        {
          getCohortById: async () => makeCohort("co-1"),
          getInstitutionById: async () => makeInstitution("inst-A", "COLLEGE"),
        },
      ),
    /subject_wise_mode_requires_subject/,
  );
});

test("startOrResumeCaptureSession: refuses to reopen a FINALIZED session", async () => {
  const admin = makeUser({
    permissions: ["attendanceSession.create", "attendanceSession.capture", "cohort.manage"],
  });
  await assert.rejects(
    () =>
      startOrResumeCaptureSession(
        admin,
        { cohortId: "co-1" },
        {
          getCohortById: async () => makeCohort("co-1"),
          getInstitutionById: async () => makeInstitution("inst-A", "SCHOOL"),
          findExistingDailySession: async () => makeSession({ status: "FINALIZED" }),
          countEnrolledStudents: async () => 0,
        },
      ),
    /session_locked/,
  );
});

test("startOrResumeCaptureSession: cross-institution cohort is denied", async () => {
  const faculty = makeUser({
    institutionId: "inst-A",
    permissions: ["attendanceSession.create", "attendanceSession.capture", "cohort.manage"],
  });
  await assert.rejects(
    () =>
      startOrResumeCaptureSession(
        faculty,
        { cohortId: "co-x" },
        {
          getCohortById: async () => makeCohort("co-x", "inst-B"),
          getInstitutionById: async () => makeInstitution("inst-A"),
        },
      ),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// analyzeCaptureImage
// ---------------------------------------------------------------------------

test("analyzeCaptureImage: happy path returns face count and never leaks embeddings", async () => {
  const faculty = makeUser({
    permissions: ["attendanceSession.capture", "cohort.manage"],
  });
  const result = await analyzeCaptureImage(
    faculty,
    {
      sessionId: "sess-1",
      sequenceNumber: 1,
      imageBase64: "a".repeat(200)
    },
    {
      getSessionById: async () => makeSession({ status: "CAPTURING" }),
      faceDetect: async () => makeDetectResponse(3, 0.9),
      ...NO_RECORD,
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.faceCount, 3);
    assert.equal(result.qualityLabel, "good");
    // No field on the result type is capable of carrying an embedding —
    // structural guarantee.
    assert.equal("embedding" in result, false);
    assert.equal("embeddings" in result, false);
  }
});

test("analyzeCaptureImage: production eligibility comes from the service's model report", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const run = (fetchModelInfo: () => Promise<{
    productionEligible: boolean;
    modelName?: string;
    modelVersion?: string;
  }>) =>
    analyzeCaptureImage(
      faculty,
      { sessionId: "sess-1", sequenceNumber: 1, imageBase64: "a".repeat(200) },
      {
        getSessionById: async () => makeSession({ status: "CAPTURING" }),
        faceDetect: async () => makeDetectResponse(3, 0.9),
        recordCaptureAnalysis: async () => {},
        fetchModelInfo,
      },
    );
  const eligible = (r: Awaited<ReturnType<typeof run>>) => r.ok && r.productionEligible;

  // The same build that ran detection, reported eligible: believed.
  assert.equal(
    eligible(await run(async () => ({ productionEligible: true, modelName: "mock", modelVersion: "0.1.0+pp1" }))),
    true,
  );
  // Eligible, but for a different build than the one that just detected —
  // the service changed model between the two calls. Not believed.
  assert.equal(
    eligible(await run(async () => ({ productionEligible: true, modelName: "other", modelVersion: "1" }))),
    false,
  );
  // The report could not be read: the safe answer, not a crash.
  assert.equal(
    eligible(await run(async () => {
      throw new Error("face-ai model-info failed: 503");
    })),
    false,
  );
});

test("analyzeCaptureImage: zero-face capture is reported as no_faces with a retake hint", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const result = await analyzeCaptureImage(
    faculty,
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: "a".repeat(200) },
    {
      getSessionById: async () => makeSession({ status: "CAPTURING" }),
      faceDetect: async () => makeDetectResponse(0),
      ...NO_RECORD,
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.faceCount, 0);
    assert.equal(result.qualityLabel, "no_faces");
    assert.match(result.qualityHint, /retake/i);
  }
});

test("the capture input carries no client-supplied counter", () => {
  // The three-capture cap used to be enforced against an `acceptedSoFar`
  // integer the browser sent, which made a product rule depend on a number the
  // client chose. The sequence number is the enforcement now: a session holds
  // captures 1, 2 and 3, so there is no fourth to send, and re-sending one is
  // a retake rather than an addition. Asserted here because deleting a field
  // is the kind of fix a later refactor quietly puts back.
  assert.equal(MAX_CAPTURES_PER_SESSION, 3);
  const input: AnalyzeCaptureImageInput = {
    sessionId: "sess-1",
    sequenceNumber: 3,
    imageBase64: "a".repeat(200),
  };
  assert.equal(Object.hasOwn(input, "acceptedSoFar"), false);
});

test("a retake of capture 2 replaces it rather than adding a fourth", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const recorded: CaptureImageAnalysis[] = [];
  const deps = {
    getSessionById: async () => makeSession({ status: "CAPTURING" }),
    faceDetect: async () => makeDetectResponse(5, 0.9),
    recordCaptureAnalysis: async (_id: string, a: CaptureImageAnalysis) => {
      const next = recorded.filter((r) => r.sequenceNumber !== a.sequenceNumber);
      recorded.length = 0;
      recorded.push(...next, a);
    },
  };
  for (const sequenceNumber of [1, 2, 2, 3] as const) {
    await analyzeCaptureImage(
      faculty,
      { sessionId: "sess-1", sequenceNumber, imageBase64: "a".repeat(200) },
      deps,
    );
  }
  assert.deepEqual(recorded.map((r) => r.sequenceNumber).sort(), [1, 2, 3]);
});

test("analyzeCaptureImage: cross-institution session is denied without hitting face-ai", async () => {
  const faculty = makeUser({
    institutionId: "inst-A",
    permissions: ["attendanceSession.capture", "cohort.manage"],
  });
  let detectCalled = false;
  const result = await analyzeCaptureImage(
    faculty,
    { sessionId: "sess-x", sequenceNumber: 1, imageBase64: "a".repeat(200) },
    {
      getSessionById: async () => makeSession({ institutionId: "inst-B", status: "CAPTURING" }),
      faceDetect: async () => {
        detectCalled = true;
        return makeDetectResponse(2);
      },
    },
  );
  assert.equal(detectCalled, false);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "session_forbidden");
});

test("analyzeCaptureImage: face-ai timeout is surfaced as retryable service_timeout", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const result = await analyzeCaptureImage(
    faculty,
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: "a".repeat(200) },
    {
      getSessionById: async () => makeSession({ status: "CAPTURING" }),
      faceDetect: () => new Promise(() => {}), // never resolves
      detectTimeoutMs: 10,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "service_timeout");
    assert.equal(result.retryable, true);
  }
});

test("analyzeCaptureImage: face-ai crash surfaces as retryable service_unavailable", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const result = await analyzeCaptureImage(
    faculty,
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: "a".repeat(200) },
    {
      getSessionById: async () => makeSession({ status: "CAPTURING" }),
      faceDetect: async () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "service_unavailable");
    assert.equal(result.retryable, true);
  }
});

test("analyzeCaptureImage: a session not in CAPTURING refuses new frames", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const result = await analyzeCaptureImage(
    faculty,
    { sessionId: "sess-1", sequenceNumber: 1, imageBase64: "a".repeat(200) },
    {
      getSessionById: async () => makeSession({ status: "FINALIZED" }),
      faceDetect: async () => makeDetectResponse(1),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "session_locked");
});

// ---------------------------------------------------------------------------
// summarize + cancel
// ---------------------------------------------------------------------------

test("summarizeCaptureSession reads the server's own verdicts, not the browser's", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const summary = await summarizeCaptureSession(
    faculty,
    { sessionId: "sess-1" },
    {
      getSessionById: async () => makeSession({ status: "CAPTURING" }),
      countEnrolledStudents: async () => 24,
      loadCaptureAnalyses: async () => [
        analysis({ sequenceNumber: 1, faceCount: 12, qualityLabel: "good" }),
        analysis({ sequenceNumber: 2, faceCount: 3, qualityLabel: "acceptable" }),
      ],
    },
  );
  assert.equal(summary.captureCount, 2);
  assert.equal(summary.totalFacesDetected, 15);
  assert.equal(summary.enrolledStudentCount, 24);
  assert.equal(summary.productionEligible, false);
  assert.equal(summary.hasUsableCaptures, true);
  assert.equal(summary.analyses.length, 2);
});

test("a session with no captures claims no production-eligible backend", async () => {
  // `every` over an empty list is true, which would have reported a
  // licence-cleared model for a session that never ran one.
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const summary = await summarizeCaptureSession(
    faculty,
    { sessionId: "sess-1" },
    {
      getSessionById: async () => makeSession({ status: "CAPTURING" }),
      countEnrolledStudents: async () => 24,
      loadCaptureAnalyses: async () => [],
    },
  );
  assert.equal(summary.captureCount, 0);
  assert.equal(summary.productionEligible, false);
  assert.equal(summary.hasUsableCaptures, false);
});

test("cancelCaptureSession: moves a CAPTURING session to CANCELLED with audit", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  let audited = false;
  const updated = await cancelCaptureSession(faculty, "sess-1", {
    getSessionById: async () => makeSession({ status: "CAPTURING" }),
    transitionSessionStatus: async (id, from, to) => {
      assert.equal(from, "CAPTURING");
      assert.equal(to, "CANCELLED");
      return makeSession({ id, status: "CANCELLED" });
    },
    recordAuditLog: async () => {
      audited = true;
    },
  });
  assert.equal(updated.status, "CANCELLED");
  assert.equal(audited, true);
});

test("cancelCaptureSession: already-cancelled session is a no-op, not an error", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.capture", "cohort.manage"] });
  const result = await cancelCaptureSession(faculty, "sess-1", {
    getSessionById: async () => makeSession({ status: "CANCELLED" }),
    transitionSessionStatus: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result.status, "CANCELLED");
});
