/**
 * Integration tests across the apps/web <-> services/face-ai boundary.
 *
 * Everything else in this repo tests one side of that boundary with the other
 * side stubbed, which is exactly the arrangement in which a contract drifts:
 * both halves keep passing while the wire shape they actually exchange stops
 * matching. These tests speak HTTP to a real running FastAPI process.
 *
 * They are OPT-IN. `npm test` must stay hermetic and runnable with no Python
 * interpreter, no model and no network, so every test here skips unless
 * FACE_AI_INTEGRATION=1. Run them with:
 *
 *     scripts/integration-test.sh         # boots the service, runs, tears down
 *
 * The default backend for that script is the `mock` provider, which is a hash
 * stub: it proves the plumbing, the contract and the orchestration are
 * correct. It proves NOTHING about recognition accuracy — that is what
 * services/face-ai/bench/ is for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_DIMENSION, FACE_AI_CONTRACT_VERSION } from "@attendance/shared-types";
import type { DetectEmbedResponse, ModelInfoResponse } from "@attendance/shared-types";
import { runRecognitionForSession } from "../modules/recognition-engine/service.ts";
import type { SessionUser } from "../modules/auth-tenancy/types.ts";
import type { Cohort } from "../modules/cohorts/types.ts";
import type { Institution } from "../modules/institutions/types.ts";
import type { CandidateEmbeddingWithVector } from "../modules/recognition-results/repository.ts";
import type { AttendanceSession } from "../modules/sessions/types.ts";

const ENABLED = process.env.FACE_AI_INTEGRATION === "1";
const SKIP = ENABLED
  ? false
  : "set FACE_AI_INTEGRATION=1 (see scripts/integration-test.sh) to run against a live face-ai";

const SERVICE_URL = process.env.FACE_AI_SERVICE_URL ?? "http://127.0.0.1:8099";

// `@/lib/env` validates the whole environment at module load, and it is
// imported transitively by the client under test. Supplying placeholders for
// the variables this suite does not exercise keeps that validation honest
// (it still fails loudly on a missing FACE_AI_SERVICE_URL) without requiring
// a database or a real secret to test an HTTP contract.
if (ENABLED) {
  process.env.FACE_AI_SERVICE_URL ??= SERVICE_URL;
  process.env.DATABASE_URL ??= "postgresql://integration:integration@127.0.0.1:5432/unused";
  process.env.AUTH_SECRET ??= "integration-test-auth-secret";
  process.env.API_KEY_PEPPER ??= "integration-test-api-key-pepper";
}

/** Imported lazily so the module graph — and therefore env validation — is
 * never touched in a skipped run. */
async function client() {
  return import("./face-ai-client.ts");
}

// ---------------------------------------------------------------------------
// Image fixtures
//
// The mock backend keys off the base64 string itself rather than decoding
// pixels, so distinct strings stand in for distinct people. A backend that
// really decodes images will reject these, which is the correct failure: this
// suite is run against `mock` by design and the script says so.
// ---------------------------------------------------------------------------

const FACE_A = "aW50ZWdyYXRpb24tc3R1ZGVudC1B";
const FACE_B = "aW50ZWdyYXRpb24tc3R1ZGVudC1C";
const FACE_C = "aW50ZWdyYXRpb24tc3R1ZGVudC1D";

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

test("health endpoint answers with the dimension the TypeScript contract assumes", { skip: SKIP }, async () => {
  const { getFaceAiHealth } = await client();
  const health = await getFaceAiHealth();

  assert.equal(health.status, "ok");
  assert.equal(
    health.embeddingDim,
    EMBEDDING_DIMENSION,
    "a dimension mismatch silently scores every student at 0 similarity",
  );
  assert.ok(health.modelName.length > 0);
  assert.ok(health.modelVersion.length > 0);
});

test("model-info satisfies every provenance invariant the engine relies on", { skip: SKIP }, async () => {
  const { faceModelInfo } = await client();
  const info: ModelInfoResponse = await faceModelInfo();

  assert.equal(
    info.contractVersion,
    FACE_AI_CONTRACT_VERSION,
    "contract version drift means the two halves were deployed independently",
  );
  assert.equal(info.embeddingDim, EMBEDDING_DIMENSION);
  assert.equal(
    info.embeddingNormalized,
    true,
    "the contract requires unit-length embeddings so cosine similarity is the dot product",
  );

  // Composite provenance: <weightsVersion>+pp<preprocessingVersion>. Stored
  // on every FaceEmbedding row, so a change in either half must invalidate
  // old templates rather than silently comparing incomparable vectors.
  assert.equal(info.modelVersion, `${info.weightsVersion}+pp${info.preprocessingVersion}`);

  // productionEligible is a licence gate, not a capability flag.
  assert.equal(info.productionEligible, info.commercialUse === "permitted");
});

test("detect-embed returns per-image faces with unit-length vectors", { skip: SKIP }, async () => {
  const { detectEmbed, faceModelInfo } = await client();
  const info = await faceModelInfo();

  const response: DetectEmbedResponse = await detectEmbed({
    sessionId: "integration-session",
    images: [
      { sequenceNumber: 1, imageBase64: FACE_A },
      { sequenceNumber: 2, imageBase64: FACE_B },
    ],
  });

  assert.equal(response.modelName, info.modelName);
  assert.equal(response.modelVersion, info.modelVersion);
  assert.ok(response.faces.length >= 2, "one face per image was expected");

  assert.deepEqual(
    [...new Set(response.faces.map((f) => f.sequenceNumber))].sort(),
    [1, 2],
    "faces must carry the sequenceNumber of the image they came from, or the engine cannot namespace face ids",
  );

  for (const face of response.faces) {
    assert.equal(face.embedding.length, EMBEDDING_DIMENSION);
    const norm = Math.sqrt(face.embedding.reduce((acc, v) => acc + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `embedding was not unit length (norm ${norm})`);
    assert.ok(face.detectionConfidence >= 0 && face.detectionConfidence <= 1);
  }
});

test("the same image yields the same embedding across separate requests", { skip: SKIP }, async () => {
  // Enrolment and capture are separate HTTP calls, often days apart. If the
  // service were not deterministic for identical input, no stored template
  // would ever be comparable to a live capture.
  const { faceEmbed } = await client();
  const first = await faceEmbed({ imageBase64: FACE_A });
  const second = await faceEmbed({ imageBase64: FACE_A });

  assert.deepEqual(first.embedding, second.embedding);
  assert.equal(first.modelVersion, second.modelVersion);
});

test("a rejected request surfaces as an error rather than an empty result", { skip: SKIP }, async () => {
  // A malformed request must never degrade into "no faces detected", because
  // that reads downstream as "nobody was in the room".
  const { detectEmbed } = await client();
  await assert.rejects(
    detectEmbed({
      sessionId: "integration-session",
      // 9 is outside the 1-3 the contract allows.
      images: [{ sequenceNumber: 9 as 1, imageBase64: FACE_A }],
    }),
    /detect-embed failed/,
  );
});

// ---------------------------------------------------------------------------
// End-to-end orchestration against the live service
// ---------------------------------------------------------------------------

function makeUser(): SessionUser {
  return {
    userId: "user-1",
    email: "faculty@example.com",
    name: "Integration Faculty",
    institutionId: "inst-A",
    campusId: null,
    roles: [
      {
        key: "FACULTY",
        name: "Faculty",
        institutionId: "inst-A",
        campusId: null,
        permissions: [
          "cohort.read",
          "attendanceSession.create",
          "attendanceSession.capture",
        ] as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function makeSession(): AttendanceSession {
  return {
    id: "sess-int-1",
    institutionId: "inst-A",
    cohortId: "co-1",
    cohortSubjectId: null,
    facultyId: "user-1",
    sessionDate: new Date(),
    startedAt: new Date(),
    endedAt: null,
    status: "CAPTURING",
    metadata: {},
  } as AttendanceSession;
}

function makeCohort(): Cohort {
  return {
    id: "co-1",
    institutionId: "inst-A",
    academicUnitId: "unit-1",
    academicSessionId: "as-1",
    name: "Cohort co-1",
    termLabel: null,
    createdAt: new Date(),
  };
}

function makeInstitution(): Institution {
  return {
    id: "inst-A",
    name: "Integration Institution",
    type: "SCHOOL",
    timezone: "UTC",
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Institution;
}

/** Enrol a student by asking the live service for a template, exactly as the
 * Phase 3 enrolment flow does, and shape it like the pgvector repository row
 * the engine consumes. */
async function enrol(studentId: string, imageBase64: string): Promise<CandidateEmbeddingWithVector> {
  const { faceEmbed } = await client();
  const res = await faceEmbed({ imageBase64 });
  return {
    id: `emb-${studentId}`,
    studentId,
    modelName: res.modelName,
    modelVersion: res.modelVersion,
    embeddingDim: res.embedding.length,
    embedding: res.embedding,
  };
}

/** Deps that leave the two network-crossing seams (model-info and
 * detect-embed) wired to the real client, and stub only the database. */
async function liveDeps(pool: CandidateEmbeddingWithVector[]) {
  const { faceModelInfo, detectEmbed } = await client();
  return {
    getSessionById: async () => makeSession(),
    getCohortById: async () => makeCohort(),
    getInstitutionById: async () => makeInstitution(),
    requireCohortAccess: async () => {},
    fetchModelInfo: faceModelInfo,
    loadCandidateEmbeddings: async () => pool,
    detectEmbed,
  };
}

test("a live run recognises an enrolled student and leaves the rest unmatched", { skip: SKIP }, async () => {
  const pool = [
    await enrol("stu-present", FACE_A),
    await enrol("stu-absent", FACE_B),
  ];

  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-int-1", images: [{ sequenceNumber: 1, imageBase64: FACE_A }] },
    await liveDeps(pool),
  );

  assert.equal(summary.candidatePoolSize, 2);
  assert.equal(summary.skippedIncompatibleCandidates, 0);
  assert.ok(summary.detectedFacesTotal >= 1);

  const present = summary.perStudent.find((s) => s.studentId === "stu-present");
  assert.ok(present, "the enrolled student whose face was captured should have a row");
  assert.equal(present.advisoryResult, "PRESENT");
  assert.equal(present.matchStatus, "MATCHED");

  assert.deepEqual(summary.unmatchedStudentIds, ["stu-absent"]);

  // Provenance must round-trip from the service into the stored summary.
  const { faceModelInfo } = await client();
  const info = await faceModelInfo();
  assert.equal(summary.modelName, info.modelName);
  assert.equal(summary.modelVersion, info.modelVersion);
  assert.equal(summary.productionEligible, info.productionEligible);
});

test("a student seen in two photos is counted once", { skip: SKIP }, async () => {
  const pool = [await enrol("stu-rahul", FACE_A), await enrol("stu-other", FACE_C)];

  const summary = await runRecognitionForSession(
    makeUser(),
    {
      sessionId: "sess-int-1",
      images: [
        { sequenceNumber: 1, imageBase64: FACE_A },
        { sequenceNumber: 2, imageBase64: FACE_A },
      ],
    },
    await liveDeps(pool),
  );

  assert.ok(summary.detectedFacesTotal >= 2, "both images should have produced a face");
  const rows = summary.perStudent.filter((s) => s.studentId === "stu-rahul");
  assert.equal(rows.length, 1, "the same student in two images must not produce two records");
  assert.equal(new Set(summary.perStudent.map((s) => s.studentId)).size, summary.perStudent.length);
});

test("the search stays scoped to the class the session belongs to", { skip: SKIP }, async () => {
  // FACE_B belongs to a student in a different class and is therefore never
  // loaded into the pool. Even though their face is in the photo, they must
  // not appear anywhere in the output.
  const pool = [await enrol("stu-in-class", FACE_A)];

  const summary = await runRecognitionForSession(
    makeUser(),
    {
      sessionId: "sess-int-1",
      images: [
        { sequenceNumber: 1, imageBase64: FACE_A },
        { sequenceNumber: 2, imageBase64: FACE_B },
      ],
    },
    await liveDeps(pool),
  );

  const mentioned = new Set([
    ...summary.perStudent.map((s) => s.studentId),
    ...summary.perFace.map((f) => f.candidateStudentId).filter((id): id is string => id !== null),
    ...summary.unmatchedStudentIds,
  ]);
  assert.deepEqual([...mentioned], ["stu-in-class"]);
});

test("a live summary carries no biometric material", { skip: SKIP }, async () => {
  const pool = [await enrol("stu-present", FACE_A)];
  const summary = await runRecognitionForSession(
    makeUser(),
    { sessionId: "sess-int-1", images: [{ sequenceNumber: 1, imageBase64: FACE_A }] },
    await liveDeps(pool),
  );

  // The service returns full-width vectors; the engine's output shape must
  // not forward them to a browser.
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("embedding"), "recognition output must not carry embeddings");
  assert.ok(!serialized.includes(FACE_A), "recognition output must not echo the captured image");
});
