import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SAMPLES_PER_STUDENT,
  deactivateFaceEmbeddingRequest,
  enrollFaceForStudentRequest,
  enrollOwnFaceRequest,
} from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Student } from "../students/types.ts";
import type { InsertFaceEmbeddingInput } from "./repository.ts";
import type { EnrollResponse, FaceQualityAssessment } from "@attendance/shared-types";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const ONES_512: number[] = Array.from({ length: 512 }, () => 0.001);

function acceptedResponse(): EnrollResponse {
  return {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: ONES_512,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    weightsVersion: "0.1.0",
    preprocessingVersion: "1",
    embeddingDim: 512,
    aligned: true,
  };
}

function rejectedResponse(reason: FaceQualityAssessment["reason"]): EnrollResponse {
  return {
    accepted: false,
    assessment: { reason, qualityScore: 0.1, faceCount: reason === "no_face" ? 0 : 1 },
    modelName: "mock",
    modelVersion: "0.1.0",
  };
}

test("staff enrollment: happy path stores an embedding and NEVER returns the vector", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let insertedInstitution: string | undefined;

  const result = await enrollFaceForStudentRequest(
    admin,
    { studentId: "stu-1", imageBase64: "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123" },
    {
      getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
      faceEnroll: async () => acceptedResponse(),
      countActiveEmbeddingsForStudent: async () => 0,
      insertFaceEmbedding: async (input) => {
        insertedInstitution = input.institutionId;
        return { id: "emb-1" };
      },
      recordAuditLog: async () => {},
    },
  );

  assert.equal(insertedInstitution, "inst-A");
  assert.equal(result.ok, true);
  // The client-facing shape has no field named "embedding"; a change in
  // this test signals a leak of raw biometric data.
  assert.equal("embedding" in result, false);
  if (result.ok) {
    assert.equal(result.embeddingId, "emb-1");
    assert.ok(typeof result.qualityScore === "number");
  }
});

test("bad image quality is rejected — no embedding is stored", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let inserted = false;

  const result = await enrollFaceForStudentRequest(
    admin,
    { studentId: "stu-1", imageBase64: "b".repeat(200) },
    {
      getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
      faceEnroll: async () => rejectedResponse("blurred"),
      countActiveEmbeddingsForStudent: async () => 0,
      insertFaceEmbedding: async () => {
        inserted = true;
        return { id: "emb-x" };
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "blurred");
  assert.equal(inserted, false);
});

test("no face is rejected without storing anything", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let inserted = false;

  const result = await enrollFaceForStudentRequest(
    admin,
    { studentId: "stu-1", imageBase64: "b".repeat(200) },
    {
      getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
      faceEnroll: async () => rejectedResponse("no_face"),
      countActiveEmbeddingsForStudent: async () => 0,
      insertFaceEmbedding: async () => {
        inserted = true;
        return { id: "emb-x" };
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_face");
  assert.equal(inserted, false);
});

test("multiple faces is rejected without storing anything", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let inserted = false;

  const result = await enrollFaceForStudentRequest(
    admin,
    { studentId: "stu-1", imageBase64: "b".repeat(200) },
    {
      getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
      faceEnroll: async () => rejectedResponse("multiple_faces"),
      countActiveEmbeddingsForStudent: async () => 0,
      insertFaceEmbedding: async () => {
        inserted = true;
        return { id: "emb-x" };
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "multiple_faces");
  assert.equal(inserted, false);
});

test("duplicate/cap: a student at the sample cap cannot enroll another", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let enrollCalled = false;

  const result = await enrollFaceForStudentRequest(
    admin,
    { studentId: "stu-1", imageBase64: "b".repeat(200) },
    {
      getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
      // Count is at the cap — should short-circuit BEFORE calling the AI.
      countActiveEmbeddingsForStudent: async () => MAX_SAMPLES_PER_STUDENT,
      faceEnroll: async () => {
        enrollCalled = true;
        return acceptedResponse();
      },
      insertFaceEmbedding: async () => ({ id: "emb-x" }),
    },
  );

  assert.equal(enrollCalled, false, "must not call face-ai once cap is reached");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "duplicate");
});

test("unauthorized: a caller without faceEmbedding.manage cannot enroll another student", async () => {
  const student = makeUser({ roleKey: "STUDENT", permissions: ["faceEmbedding.enroll.own", "student.read.own"] });
  let enrollCalled = false;

  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(
        student,
        { studentId: "stu-1", imageBase64: "b".repeat(200) },
        {
          getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
          faceEnroll: async () => {
            enrollCalled = true;
            return acceptedResponse();
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(enrollCalled, false);
});

test("cross-institution: staff from inst-A cannot enroll a student in inst-B", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let enrollCalled = false;
  let inserted = false;

  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(
        admin,
        { studentId: "stu-x", imageBase64: "b".repeat(200) },
        {
          getStudentById: async () => ({ id: "stu-x", institutionId: "inst-B" } as Student),
          faceEnroll: async () => {
            enrollCalled = true;
            return acceptedResponse();
          },
          insertFaceEmbedding: async () => {
            inserted = true;
            return { id: "emb-x" };
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(enrollCalled, false, "face-ai must never be called across institutions");
  assert.equal(inserted, false);
});

// Self-enrollment: the caller's own linked Student profile is the ONLY
// target — so an actor cannot enroll another user's face by passing
// someone else's id (the input has no id at all).
test("student self-enrollment enrolls the caller's linked Student profile", async () => {
  const student = makeUser({
    userId: "user-42",
    institutionId: "inst-A",
    roleKey: "STUDENT",
    permissions: ["faceEmbedding.enroll.own", "student.read.own"],
  });
  let insertedForStudent: string | undefined;

  const result = await enrollOwnFaceRequest(
    student,
    { imageBase64: "b".repeat(200) },
    {
      getStudentByUserId: async (uid) => {
        assert.equal(uid, "user-42");
        return { id: "stu-42", institutionId: "inst-A" } as Student;
      },
      countActiveEmbeddingsForStudent: async () => 0,
      faceEnroll: async () => acceptedResponse(),
      insertFaceEmbedding: async (input) => {
        insertedForStudent = input.studentId;
        return { id: "emb-1" };
      },
      recordAuditLog: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(insertedForStudent, "stu-42");
});

test("self-enrollment requires faceEmbedding.enroll.own — a plain admin without it is denied", async () => {
  const admin = makeUser({
    institutionId: "inst-A",
    permissions: ["faceEmbedding.manage"], // has manage, but NOT enroll.own
  });
  await assert.rejects(
    () => enrollOwnFaceRequest(admin, { imageBase64: "b".repeat(200) }),
    ForbiddenError,
  );
});

test("deactivate: staff from inst-A cannot deactivate an embedding on a student in inst-B", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let deactivated = false;

  await assert.rejects(
    () =>
      deactivateFaceEmbeddingRequest(admin, "emb-x", {
        getEmbeddingStudentId: async () => "stu-x",
        getStudentById: async () => ({ id: "stu-x", institutionId: "inst-B" } as Student),
        deactivateFaceEmbedding: async () => {
          deactivated = true;
        },
      }),
    ForbiddenError,
  );
  assert.equal(deactivated, false);
});

// ---------------------------------------------------------------------------
// Model-provider agnosticism (Phase 3.1)
//
// The business logic above must behave identically no matter which model
// produced the response. These tests substitute a response from a totally
// different backend — different name, different weights, different
// preprocessing version — and assert that nothing changes except the
// provenance we record.
// ---------------------------------------------------------------------------

/** A response shaped as if it came from a completely different backend. */
function acceptedResponseFromOtherProvider(): EnrollResponse {
  return {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.83, faceCount: 1 },
    embedding: ONES_512,
    modelName: "some-other-model",
    modelVersion: "4.2.1+pp3",
    weightsVersion: "4.2.1",
    preprocessingVersion: "3",
    embeddingDim: 512,
    aligned: true,
  };
}

test("swapping the model backend does not change enrollment behaviour", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  const student = { id: "stu-1", institutionId: "inst-A" } as Student;

  async function enrollWith(response: EnrollResponse) {
    let inserted: InsertFaceEmbeddingInput | undefined;
    const result = await enrollFaceForStudentRequest(
      admin,
      { studentId: "stu-1", imageBase64: "a".repeat(200) },
      {
        getStudentById: async () => student,
        countActiveEmbeddingsForStudent: async () => 0,
        faceEnroll: async () => response,
        insertFaceEmbedding: async (input) => {
          inserted = input;
          return { id: "emb-1" };
        },
        recordAuditLog: async () => {},
      },
    );
    return { result, inserted };
  }

  const mock = await enrollWith(acceptedResponse());
  const other = await enrollWith(acceptedResponseFromOtherProvider());

  // Same outcome, same client-facing shape.
  assert.equal(mock.result.ok, true);
  assert.equal(other.result.ok, true);
  assert.deepEqual(Object.keys(mock.result).sort(), Object.keys(other.result).sort());
  // Still no vector in the response, whichever backend produced it.
  assert.equal("embedding" in other.result, false);
});

test("the model that produced an embedding is recorded with it", async () => {
  // "Which model produced this result?" has to be answerable later, and a
  // stored vector is only comparable to others from the same model build.
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });
  let inserted: InsertFaceEmbeddingInput | undefined;
  let audited: Record<string, unknown> | undefined;

  await enrollFaceForStudentRequest(
    admin,
    { studentId: "stu-1", imageBase64: "a".repeat(200) },
    {
      getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" }) as Student,
      countActiveEmbeddingsForStudent: async () => 0,
      faceEnroll: async () => acceptedResponseFromOtherProvider(),
      insertFaceEmbedding: async (input) => {
        inserted = input;
        return { id: "emb-1" };
      },
      recordAuditLog: async (input) => {
        audited = input.afterJson as Record<string, unknown>;
      },
    },
  );

  assert.equal(inserted?.modelName, "some-other-model");
  // The stored version is the composite <weights>+pp<preprocessing>, so a
  // preprocessing change invalidates old vectors just as a weights change
  // does — both live in the one column the schema has.
  assert.equal(inserted?.modelVersion, "4.2.1+pp3");
  assert.equal(inserted?.embeddingDim, 512);

  assert.equal(audited?.modelName, "some-other-model");
  assert.equal(audited?.modelVersion, "4.2.1+pp3");
  // The audit trail is exportable and widely readable — it must carry
  // metadata only, never biometric material.
  assert.equal("embedding" in (audited ?? {}), false);
});
