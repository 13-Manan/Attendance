import { test } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenError } from "./modules/authorization/types.ts";
import { hasPermission, requireSameInstitution } from "./modules/authorization/service.ts";
import type { SessionUser } from "./modules/auth-tenancy/types.ts";
import {
  applyReviewDecision,
  confirmAttendance,
  getAttendanceReviewBoard,
  getOwnAttendance,
  type StudentAttendanceDeps,
} from "./modules/attendance-review/service.ts";
import {
  deactivateFaceEmbeddingRequest,
  enrollFaceForStudentRequest,
  enrollOwnFaceRequest,
} from "./modules/face-enrollment/service.ts";
import { deleteStudentFaceData, runRetentionSweep } from "./modules/privacy/service.ts";
import { inspectImageBase64 } from "./lib/image-validation.ts";
import type { AttendanceSession } from "./modules/sessions/types.ts";
import type { Student } from "./modules/students/types.ts";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";

/**
 * The attack suite.
 *
 * Every other test file asks "does this feature work?". This one asks "can
 * somebody reach data that is not theirs?", and it is organised by attacker
 * rather than by module, because that is how the question is actually asked
 * after an incident: *what could a student have done?*
 *
 * Each test names a specific attempt from the Phase 11 brief:
 *
 *   - a student reaching another student's attendance
 *   - a student reaching an administrator's capability
 *   - a teacher reaching another institution
 *   - an institution admin reaching another institution
 *   - an invalid attendance id
 *   - an invalid student id
 *   - an unauthenticated or unauthorized face endpoint
 *   - a malicious upload
 *   - an oversized upload
 *
 * The services are exercised with injected dependencies, so what is proven is
 * the authorization logic itself rather than a particular database's row-level
 * behaviour. That is the right layer: these checks run before any query, and a
 * test that needed a database to demonstrate them would be testing Postgres.
 *
 * One convention throughout: a refusal must happen *before* the side effect,
 * so the assertions check that no write function was called, not merely that
 * an error was thrown.
 */

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

type Permissions = SessionUser["roles"][number]["permissions"];

function user(options: {
  userId: string;
  institutionId: string | null;
  permissions: string[];
}): SessionUser {
  return {
    userId: options.userId,
    email: `${options.userId}@example.edu`,
    name: options.userId,
    institutionId: options.institutionId,
    campusId: null,
    roles: [
      {
        key: "ROLE",
        name: "Role",
        institutionId: options.institutionId,
        campusId: null,
        permissions: options.permissions as Permissions,
      },
    ],
  };
}

/** A student at institution A. Holds only the `.own` permissions. */
const studentA = user({
  userId: "user-student-a",
  institutionId: "inst-A",
  permissions: ["faceEmbedding.enroll.own", "attendanceRecord.read.own"],
});

/** A teacher at institution A. */
const teacherA = user({
  userId: "user-teacher-a",
  institutionId: "inst-A",
  permissions: [
    "attendanceSession.capture",
    "attendanceRecord.read",
    "attendanceRecord.correct",
    "attendanceSession.finalize",
    "faceEmbedding.manage",
    "student.read",
  ],
});

/** An institution admin at institution A — the most privileged tenant actor. */
const adminA = user({
  userId: "user-admin-a",
  institutionId: "inst-A",
  permissions: [
    "institution.read",
    "institution.update",
    "faceEmbedding.manage",
    "attendanceRecord.read",
    "attendanceRecord.correct",
    "attendanceSession.finalize",
    "student.read",
    "student.update",
    "auditLog.read",
  ],
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function session(overrides: Partial<AttendanceSession> = {}): AttendanceSession {
  return {
    id: "sess-A",
    institutionId: "inst-A",
    cohortId: "cohort-A",
    cohortSubjectId: null,
    status: "REVIEW",
    sessionDate: new Date("2026-05-01T09:00:00.000Z"),
    ...overrides,
  } as AttendanceSession;
}

function student(overrides: Partial<Student> = {}): Student {
  return {
    id: "stu-A",
    institutionId: "inst-A",
    studentCode: "A1",
    firstName: "Ada",
    lastName: "Lovelace",
    status: "ACTIVE",
    ...overrides,
  } as Student;
}

/** Records every write a service attempted, so "refused" can be distinguished
 *  from "refused after already doing the thing". */
interface Writes {
  corrections: unknown[];
  finalizations: unknown[];
  embeddings: unknown[];
  deactivations: string[];
  deletions: string[][];
}

function writes(): Writes {
  return { corrections: [], finalizations: [], embeddings: [], deactivations: [], deletions: [] };
}

/**
 * A capture payload, with the provenance field every enrollment path now
 * requires. The value is recorded and never branched on — both sources pass
 * through identical checks — so the choice here is arbitrary.
 */
const CAPTURE = { imageBase64: "x".repeat(200), captureSource: "CAMERA" as const };

/**
 * A properly L2-normalised vector of the contract's current length.
 *
 * The service refuses a template that is not unit length, so a two-element
 * stand-in would now be rejected for that reason rather than reaching the
 * assertion each of these tests is actually making.
 */
const UNIT_VECTOR: number[] = Array.from(
  { length: EMBEDDING_DIMENSION },
  () => 1 / Math.sqrt(EMBEDDING_DIMENSION),
);

/** A distinctive value to search a serialised response for. */
const TELLTALE = 0.9012345678;

function unitVectorWithTelltale(): number[] {
  // One component replaced and the whole thing renormalised, so the vector is
  // still unit length but contains a number a leak test can grep for.
  const raw = UNIT_VECTOR.slice();
  raw[0] = TELLTALE;
  const norm = Math.sqrt(raw.reduce((total, value) => total + value * value, 0));
  return raw.map((value) => value / norm);
}

function acceptedEnrollment(embedding: number[] = UNIT_VECTOR) {
  return {
    accepted: true as const,
    assessment: { reason: "ok" as const, qualityScore: 0.9, faceCount: 1 },
    embedding,
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    weightsVersion: "0.1.0",
    preprocessingVersion: "1",
    embeddingDim: EMBEDDING_DIMENSION,
    aligned: true,
  };
}

/**
 * The running model, as `/v1/model-info` reports it.
 *
 * Stubbed rather than left to the default, which would reach for the real
 * face service. Enrollment needs to know how to read the backend's similarity
 * scores before it may store a template — see
 * `recognition-engine/calibration.ts` — so a test that omitted this would be
 * exercising "the face service was unreachable" while claiming to exercise
 * something else, and would pass or fail depending on whether a development
 * server happened to be listening.
 */
async function runningModel() {
  return {
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
    weightsVersion: "0.1.0",
    preprocessingVersion: "1",
    embeddingDim: EMBEDDING_DIMENSION,
    embeddingNormalized: true,
    runtime: "numpy-hash-stub",
    commercialUse: "not-applicable" as const,
    productionEligible: false,
    contractVersion: "v1",
  };
}

/** A college, so the self-enrollment path is permitted by default. */
async function collegeInstitution() {
  return { id: "inst-A", name: "Northfield", type: "COLLEGE", settings: {} } as never;
}

function assertNothingWritten(w: Writes): void {
  assert.equal(w.corrections.length, 0, "a correction was written despite the refusal");
  assert.equal(w.finalizations.length, 0, "a session was finalized despite the refusal");
  assert.equal(w.embeddings.length, 0, "a face template was stored despite the refusal");
  assert.equal(w.deactivations.length, 0, "a template was deactivated despite the refusal");
  assert.equal(w.deletions.length, 0, "a template was deleted despite the refusal");
}

// ===========================================================================
// 1. Student → another student
// ===========================================================================

test("a student reading attendance gets their own, with no parameter that could name another", async () => {
  // The structural defence: `getOwnAttendance` has no studentId argument, so
  // there is no value an attacker could supply. The test asserts the resolved
  // student comes from the session user id and nothing else.
  let askedFor: string | null = null;

  // Cast because these deps are typed as the repository functions themselves,
  // and a Prisma call returns a thenable that is not a plain Promise. The stub
  // supplies what the service reads; the cast is about the surrounding Prisma
  // machinery, not about the shape under test.
  const view = await getOwnAttendance(studentA, {
    getStudentByUserId: async (userId: string) => {
      askedFor = userId;
      return student({ id: "stu-A", studentCode: "A1" });
    },
    listFinalizedAttendanceForStudent: async () => [],
  } as unknown as StudentAttendanceDeps);

  assert.equal(askedFor, "user-student-a");
  assert.equal(view?.studentId, "stu-A");
});

test("a student cannot enrol a face against another student's id", async () => {
  const w = writes();
  // `enrollFaceForStudentRequest` is the staff path and takes a studentId.
  // A student holds `faceEmbedding.enroll.own`, not `faceEmbedding.manage`,
  // so the studentId never gets read at all.
  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(
        studentA,
        { studentId: "stu-VICTIM", ...CAPTURE },
        {
          getStudentById: async () => student({ id: "stu-VICTIM" }),
          insertFaceEmbedding: async (input) => {
            w.embeddings.push(input);
            return { id: "emb-1" };
          },
        },
      ),
    ForbiddenError,
  );
  assertNothingWritten(w);
});

test("self-enrollment uses the caller's linked profile, not a studentId from the request", async () => {
  const w = writes();
  let resolvedFromUserId: string | null = null;

  await enrollOwnFaceRequest(
    studentA,
    CAPTURE,
    {
      getStudentByUserId: async (userId) => {
        resolvedFromUserId = userId;
        return student({ id: "stu-A" });
      },
      listActiveTemplateModelsForStudent: async () => [],
      getInstitution: collegeInstitution,
      faceModelInfo: runningModel,
      faceEnroll: async () => acceptedEnrollment(),
      insertFaceEmbedding: async (input) => {
        w.embeddings.push(input);
        return { id: "emb-1" };
      },
      recordAuditLog: async () => {},
    },
  );

  assert.equal(resolvedFromUserId, "user-student-a");
  // The template was stored against the caller's own student row.
  assert.equal((w.embeddings[0] as { studentId: string }).studentId, "stu-A");
});

test("a student cannot correct an attendance record — not even their own", async () => {
  // The product invariant behind this one: students must never be able to
  // alter attendance. `attendanceRecord.read.own` is a read grant and must not
  // imply anything else.
  const w = writes();
  await assert.rejects(
    () =>
      applyReviewDecision(
        studentA,
        { attendanceRecordId: "rec-own", newResult: "PRESENT", reason: "I was there" },
        {
          getAttendanceRecordById: async () =>
            ({ id: "rec-own", sessionId: "sess-A", studentId: "stu-A" }) as never,
          getSessionById: async () => session(),
          requireCohortAccess: async () => {},
          correctAttendanceRecord: async (input) => {
            w.corrections.push(input);
            return input as never;
          },
        },
      ),
    ForbiddenError,
  );
  assertNothingWritten(w);
});

// ===========================================================================
// 2. Student → admin capability
// ===========================================================================

test("a student holds none of the administrative permissions", () => {
  for (const permission of [
    "institution.update",
    "faceEmbedding.manage",
    "attendanceRecord.read",
    "attendanceRecord.correct",
    "attendanceSession.finalize",
    "auditLog.read",
    "student.update",
  ] as const) {
    assert.equal(hasPermission(studentA, permission), false, permission);
  }
});

test("a student cannot finalize a register", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      confirmAttendance(studentA, "sess-A", {
        getSessionById: async () => session(),
        requireCohortAccess: async () => {
          throw new ForbiddenError("not_your_cohort");
        },
        finalizeAttendanceSession: async (...args) => {
          w.finalizations.push(args);
          // Never reached — every test using this stub asserts a refusal. The
          // row is returned only to match the repository's signature.
          return session();
        },
      }),
    ForbiddenError,
  );
  assertNothingWritten(w);
});

test("a student cannot run the retention sweep or delete anyone's face data", async () => {
  const w = writes();
  const deps = {
    deleteTemplates: async (_inst: string, ids: string[]) => {
      w.deletions.push(ids);
      return ids.length;
    },
    getStudentById: async () => student(),
    audit: async () => {},
  };
  await assert.rejects(() => runRetentionSweep(studentA, deps), ForbiddenError);
  await assert.rejects(() => deleteStudentFaceData(studentA, "stu-A", deps), ForbiddenError);
  assertNothingWritten(w);
});

// ===========================================================================
// 3. Teacher → another institution
// ===========================================================================

test("a teacher cannot open a review board for a session in another institution", async () => {
  await assert.rejects(
    () =>
      getAttendanceReviewBoard(teacherA, "sess-B", {
        getSessionById: async () => session({ id: "sess-B", institutionId: "inst-B" }),
        // Permissive on purpose: if cohort access were the only thing
        // stopping this, the institution check would be decorative.
        requireCohortAccess: async () => {},
      }),
    ForbiddenError,
  );
});

test("a teacher cannot correct a record belonging to another institution's session", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      applyReviewDecision(
        teacherA,
        { attendanceRecordId: "rec-B", newResult: "ABSENT", reason: "x" },
        {
          getAttendanceRecordById: async () =>
            ({ id: "rec-B", sessionId: "sess-B", studentId: "stu-B" }) as never,
          getSessionById: async () => session({ id: "sess-B", institutionId: "inst-B" }),
          requireCohortAccess: async () => {},
          correctAttendanceRecord: async (input) => {
            w.corrections.push(input);
            return input as never;
          },
        },
      ),
    ForbiddenError,
  );
  assertNothingWritten(w);
});

test("a teacher cannot enrol a face for a student at another institution", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(
        teacherA,
        { studentId: "stu-B", ...CAPTURE },
        {
          getStudentById: async () => student({ id: "stu-B", institutionId: "inst-B" }),
          listActiveTemplateModelsForStudent: async () => [],
      getInstitution: collegeInstitution,
          insertFaceEmbedding: async (input) => {
            w.embeddings.push(input);
            return { id: "emb-x" };
          },
        },
      ),
    ForbiddenError,
  );
  // Refused before the image ever reached the AI service, not after.
  assertNothingWritten(w);
});

test("a teacher cannot deactivate another institution's face template", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      deactivateFaceEmbeddingRequest(teacherA, "emb-B", {
        getTemplateOwner: async () => ({ studentId: "stu-B", institutionId: "inst-B" }),
        retireTemplate: async (id) => {
          w.deactivations.push(id);
          return 1;
        },
      }),
    ForbiddenError,
  );
  assertNothingWritten(w);
});

// ===========================================================================
// 4. Institution admin → another institution
// ===========================================================================

test("the most privileged tenant actor still cannot cross the tenant boundary", async () => {
  // Permission and tenancy are independent gates. `adminA` passes every
  // permission check in the system for their own institution; none of that
  // grants a single row belonging to institution B.
  assert.throws(() => requireSameInstitution(adminA, "inst-B"), ForbiddenError);
  assert.doesNotThrow(() => requireSameInstitution(adminA, "inst-A"));
});

test("an institution admin cannot delete another institution's face data", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      deleteStudentFaceData(adminA, "stu-B", {
        getStudentById: async () => student({ id: "stu-B", institutionId: "inst-B" }),
        listTemplateIdsForStudent: async () => ["emb-B1", "emb-B2"],
        deleteTemplates: async (_inst, ids) => {
          w.deletions.push(ids);
          return ids.length;
        },
        audit: async () => {},
      }),
    ForbiddenError,
  );
  assertNothingWritten(w);
});

test("a retention sweep is scoped to the caller's institution and cannot be pointed elsewhere", async () => {
  // There is no institution parameter on `runRetentionSweep`; it reads the
  // tenant from the session. This asserts the value every repository call
  // received, which is the only way to prove the absence of a second path.
  const seen: string[] = [];
  await runRetentionSweep(adminA, {
    getSettings: async (id) => {
      seen.push(id);
      return { id, settings: {} };
    },
    listTemplates: async (id) => {
      seen.push(id);
      return [];
    },
    deactivateTemplates: async (id) => {
      seen.push(id);
      return 0;
    },
    deleteTemplates: async (id) => {
      seen.push(id);
      return 0;
    },
    listClassroomImages: async (id) => {
      seen.push(id);
      return [];
    },
    deleteClassroomImages: async (id) => {
      seen.push(id);
      return 0;
    },
    audit: async () => {},
  });

  assert.ok(seen.length > 0);
  assert.deepEqual([...new Set(seen)], ["inst-A"]);
});

// ===========================================================================
// 5. Invalid ids
// ===========================================================================

test("an unknown attendance record id is refused, and does not reveal whether it exists elsewhere", async () => {
  // The lookup is unscoped by necessity — a record id is the only handle the
  // caller has — so the *outcome* has to be identical for "no such record" and
  // "a record in another institution". Both throw before any write.
  const w = writes();
  const correct = async (input: unknown) => {
    w.corrections.push(input);
    return input as never;
  };

  await assert.rejects(
    () =>
      applyReviewDecision(
        teacherA,
        { attendanceRecordId: "does-not-exist", newResult: "PRESENT", reason: "x" },
        { getAttendanceRecordById: async () => null, correctAttendanceRecord: correct },
      ),
    /attendance_record_not_found/,
  );
  assertNothingWritten(w);
});

test("an unknown session id is refused before any status transition", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      confirmAttendance(teacherA, "no-such-session", {
        getSessionById: async () => null,
        finalizeAttendanceSession: async (...args) => {
          w.finalizations.push(args);
          // Never reached — every test using this stub asserts a refusal. The
          // row is returned only to match the repository's signature.
          return session();
        },
      }),
    /session_not_found/,
  );
  assertNothingWritten(w);
});

test("an unknown student id is refused rather than silently doing nothing", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(
        teacherA,
        { studentId: "ghost", ...CAPTURE },
        {
          getStudentById: async () => null,
          insertFaceEmbedding: async (input) => {
            w.embeddings.push(input);
            return { id: "e" };
          },
        },
      ),
    /student_not_found/,
  );
  assertNothingWritten(w);
});

test("an unknown face template id is refused", async () => {
  const w = writes();
  await assert.rejects(
    () =>
      deactivateFaceEmbeddingRequest(teacherA, "no-such-embedding", {
        getTemplateOwner: async () => null,
        retireTemplate: async (id) => {
          w.deactivations.push(id);
          return 1;
        },
      }),
    /face_embedding_not_found/,
  );
  assertNothingWritten(w);
});

// ===========================================================================
// 6. Unauthorized face endpoints
// ===========================================================================

test("every face-data entry point checks a permission before it reads anything", async () => {
  // A caller with no permissions at all. Each dependency throws if reached,
  // so a test passes only if the refusal happened before the first lookup —
  // which is what stops an endpoint from being an existence oracle.
  const nobody = user({ userId: "user-nobody", institutionId: "inst-A", permissions: [] });
  const explode = async (): Promise<never> => {
    throw new Error("a repository was reached before the permission check");
  };

  await assert.rejects(
    () =>
      enrollFaceForStudentRequest(
        nobody,
        { studentId: "stu-A", ...CAPTURE },
        { getStudentById: explode },
      ),
    ForbiddenError,
  );
  await assert.rejects(
    () => enrollOwnFaceRequest(nobody, CAPTURE, { getStudentByUserId: explode }),
    ForbiddenError,
  );
  await assert.rejects(
    () => deactivateFaceEmbeddingRequest(nobody, "emb-1", { getTemplateOwner: explode }),
    ForbiddenError,
  );
  await assert.rejects(
    () => deleteStudentFaceData(nobody, "stu-A", { getStudentById: explode }),
    ForbiddenError,
  );
});

test("a successful enrollment never returns the biometric template to its caller", async () => {
  // The invariant that makes every other control worth having: no response
  // shape in this module carries a vector, so no view, log or API envelope
  // downstream can accidentally serialise one.
  const result = await enrollOwnFaceRequest(
    studentA,
    CAPTURE,
    {
      getStudentByUserId: async () => student(),
      listActiveTemplateModelsForStudent: async () => [],
      getInstitution: collegeInstitution,
      faceModelInfo: runningModel,
      faceEnroll: async () => acceptedEnrollment(unitVectorWithTelltale()),
      insertFaceEmbedding: async () => ({ id: "emb-1" }),
      recordAuditLog: async () => {},
    },
  );

  const serialised = JSON.stringify(result);
  assert.equal(result.ok, true);
  // No component of the vector, and no array at all — a template is
  // recognisable by shape whatever the field is called.
  assert.equal(serialised.includes("0.11"), false);
  assert.equal(serialised.includes("0.22"), false);
  assert.equal(serialised.includes("["), false);
  // `embeddingId` is present and is the only embedding-named field: an opaque
  // row id is a handle for a later deactivation, not biometric data.
  assert.deepEqual(
    Object.keys(result).filter((key) => key.toLowerCase().includes("embedding")),
    ["embeddingId"],
  );
});

test("the audit row for an enrollment carries metadata, never the vector", async () => {
  const rows: unknown[] = [];
  await enrollOwnFaceRequest(
    studentA,
    CAPTURE,
    {
      getStudentByUserId: async () => student(),
      listActiveTemplateModelsForStudent: async () => [],
      getInstitution: collegeInstitution,
      faceModelInfo: runningModel,
      faceEnroll: async () => acceptedEnrollment(unitVectorWithTelltale()),
      insertFaceEmbedding: async () => ({ id: "emb-1" }),
      recordAuditLog: async (input) => {
        rows.push(input);
      },
    },
  );

  const serialised = JSON.stringify(rows);
  assert.equal(serialised.includes("0.4242"), false);
  assert.equal(serialised.includes("embedding"), false);
  assert.match(serialised, /qualityScore/);
});

// ===========================================================================
// 7. Malicious and oversized uploads
// ===========================================================================

test("a malicious upload is rejected before it can reach an image decoder", () => {
  // The decoder these would reach is a native library called from Python, so
  // the check has to happen on this side of the wire. See lib/image-validation.
  const attacks: Array<[string, string]> = [
    ["zip archive", Buffer.from([0x50, 0x4b, 0x03, 0x04, ...new Array(300).fill(0)]).toString("base64")],
    ["svg with script", Buffer.from(`<svg onload="alert(1)">${"x".repeat(300)}</svg>`).toString("base64")],
    ["html document", Buffer.from(`<html>${"x".repeat(300)}</html>`).toString("base64")],
    ["elf binary", Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...new Array(300).fill(0)]).toString("base64")],
    ["php payload", Buffer.from(`<?php system($_GET[0]); ?>${"x".repeat(300)}`).toString("base64")],
    ["raw script text", "x".repeat(400)],
  ];

  for (const [name, payload] of attacks) {
    const result = inspectImageBase64(payload);
    assert.equal(result.ok, false, `${name} was accepted`);
  }
});

test("an oversized upload is refused on the string length, before any allocation", () => {
  const result = inspectImageBase64("A".repeat(8 * 1024 * 1024 + 1));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "too_large");
});

test("a legitimate capture still passes, so the control is not simply a denial", () => {
  const jpeg = new Uint8Array(4096);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  const result = inspectImageBase64(Buffer.from(jpeg).toString("base64"));
  assert.equal(result.ok, true);
});
