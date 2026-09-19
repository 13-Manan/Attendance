import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SAMPLES_PER_STUDENT,
  deactivateFaceEmbeddingRequest,
  enrollFaceForStudentRequest,
  enrollOwnFaceRequest,
  getOwnFaceEnrollment,
  getStudentFaceEnrollment,
  replaceFaceEnrollmentRequest,
  type FaceEnrollmentDeps,
} from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { Student } from "../students/types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import type { InsertFaceEmbeddingInput, NearestTemplateRow } from "./repository.ts";
import type { EnrollResponse, FaceQualityReason, ModelInfoResponse } from "@attendance/shared-types";

/**
 * Enrollment, end to end, without a database or a face service.
 *
 * Every dependency is injected, so each test states one rule and nothing else
 * has to be true for it to hold. The rules in question are the ones that would
 * be expensive to discover in production: a face stored under the wrong
 * student, a vector escaping into a response, a student at one institution
 * reaching another's records.
 *
 * The order of the sections mirrors the order of the checks in the service,
 * because that order is itself a decision — an image that was never going to
 * be stored should not be turned into a biometric template on the way to being
 * refused.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUser(
  overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string },
): SessionUser {
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

const MODEL = { modelName: "mock", modelVersion: "0.1.0+pp1" };

/**
 * A genuinely L2-normalised vector.
 *
 * Every component is 1/sqrt(512), so the norm is exactly 1 to within float
 * error. This matters: the service now refuses a vector that is not unit
 * length, and a fixture that happened to be un-normalised would make every
 * happy-path test fail for a reason unrelated to what it was asserting.
 */
const UNIT_512: number[] = Array.from({ length: 512 }, () => 1 / Math.sqrt(512));

function acceptedResponse(overrides: Partial<Extract<EnrollResponse, { accepted: true }>> = {}) {
  return {
    accepted: true as const,
    assessment: { reason: "ok" as const, qualityScore: 0.9, faceCount: 1 },
    embedding: UNIT_512,
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    weightsVersion: "0.1.0",
    preprocessingVersion: "1",
    embeddingDim: 512,
    aligned: true,
    ...overrides,
  };
}

function rejectedResponse(reason: FaceQualityReason): EnrollResponse {
  return {
    accepted: false,
    assessment: { reason, qualityScore: 0.1, faceCount: reason === "no_face" ? 0 : 2 },
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  };
}

function student(overrides: Partial<Student> = {}): Student {
  return {
    id: "student-1",
    institutionId: "inst-A",
    userId: "user-student",
    studentCode: "S-001",
    firstName: "Priya",
    lastName: "Sharma",
    ...overrides,
  } as Student;
}

function institution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: "inst-A",
    name: "Northfield",
    type: "COLLEGE",
    settings: {},
    ...overrides,
  } as Institution;
}

const MODEL_INFO: ModelInfoResponse = {
  modelName: MODEL.modelName,
  modelVersion: MODEL.modelVersion,
  weightsVersion: "0.1.0",
  preprocessingVersion: "1",
  embeddingDim: 512,
  embeddingNormalized: true,
  runtime: "numpy-hash-stub",
  commercialUse: "not-applicable",
  productionEligible: false,
  contractVersion: "v1",
};

interface Harness {
  deps: FaceEnrollmentDeps;
  inserted: InsertFaceEmbeddingInput[];
  replaced: InsertFaceEmbeddingInput[];
  audits: RecordAuditLogInput[];
  retired: Array<{ id: string; institutionId: string; reason: string }>;
  /** Every institution id any read was scoped to. */
  scopes: string[];
  /** The probe vectors the duplicate scan was given. */
  scans: Array<{ institutionId: string; model: { modelName: string; modelVersion: string } }>;
}

function harness(options: {
  students?: Student[];
  institution?: Institution;
  enrollResponse?: EnrollResponse | (() => EnrollResponse);
  storedModels?: Array<{ modelName: string; modelVersion: string }>;
  neighbours?: NearestTemplateRow[];
  owner?: { studentId: string; institutionId: string } | null;
  scanThrows?: boolean;
  enrollThrows?: boolean;
} = {}): Harness {
  const students = options.students ?? [student()];
  const h: Harness = {
    deps: {},
    inserted: [],
    replaced: [],
    audits: [],
    retired: [],
    scopes: [],
    scans: [],
  };

  h.deps = {
    getStudentById: async (id) => students.find((s) => s.id === id) ?? null,
    getStudentByUserId: async (userId) => students.find((s) => s.userId === userId) ?? null,
    getInstitution: async (id) => {
      h.scopes.push(id);
      const inst = options.institution ?? institution();
      return inst.id === id ? inst : null;
    },
    faceEnroll: async () => {
      if (options.enrollThrows) throw new Error("face-ai unreachable");
      const response = options.enrollResponse ?? acceptedResponse();
      return typeof response === "function" ? response() : response;
    },
    faceModelInfo: async () => MODEL_INFO,
    listActiveTemplateModelsForStudent: async () => options.storedModels ?? [],
    findNearestTemplates: async (institutionId, _probe, model) => {
      if (options.scanThrows) throw new Error("pgvector unavailable");
      h.scopes.push(institutionId);
      h.scans.push({ institutionId, model });
      return options.neighbours ?? [];
    },
    insertFaceEmbedding: async (input) => {
      h.inserted.push(input);
      return { id: `emb-${h.inserted.length}` };
    },
    replaceTemplates: async (input) => {
      h.replaced.push(input);
      return { id: `emb-replaced-${h.replaced.length}`, retired: 3 };
    },
    retireTemplate: async (id, institutionId, input) => {
      h.retired.push({ id, institutionId, reason: input.reason });
      return 1;
    },
    getTemplateOwner: async () =>
      options.owner === undefined ? { studentId: "student-1", institutionId: "inst-A" } : options.owner,
    listSampleHistoryForStudent: async () => [],
    recordAuditLog: async (input) => {
      h.audits.push(input);
    },
  };

  return h;
}

const CAMERA = { imageBase64: "AAAA", captureSource: "CAMERA" as const };
const staffAdmin = () => makeUser({ permissions: ["faceEmbedding.manage"] });
const studentUser = () =>
  makeUser({
    userId: "user-student",
    roleKey: "STUDENT",
    permissions: ["faceEmbedding.enroll.own"],
  });

/** JSON-serialises an audit payload so a vector cannot hide inside an object. */
function auditText(h: Harness): string {
  return JSON.stringify(h.audits);
}

// ---------------------------------------------------------------------------
// Authorization and tenancy — the checks that run before anything else
// ---------------------------------------------------------------------------

test("a caller without faceEmbedding.manage cannot enrol another student", async () => {
  const h = harness();
  const teacher = makeUser({ roleKey: "FACULTY", permissions: ["cohort.read"] });

  await assert.rejects(
    () => enrollFaceForStudentRequest(teacher, { studentId: "student-1", ...CAMERA }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.inserted.length, 0);
  assert.equal(h.scopes.length, 0, "the permission is checked before anything is read");
});

test("staff at one institution cannot enrol a student at another", async () => {
  const h = harness({ students: [student({ institutionId: "inst-B" })] });
  const admin = makeUser({ institutionId: "inst-A", permissions: ["faceEmbedding.manage"] });

  await assert.rejects(
    () => enrollFaceForStudentRequest(admin, { studentId: "student-1", ...CAMERA }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.inserted.length, 0);
});

test("the tenant check happens before the image reaches the model", async () => {
  // Not only "is it refused" but "how much happened first". A cross-tenant
  // request must not turn somebody's photograph into a biometric template on
  // its way to being rejected.
  let enrollCalls = 0;
  const h = harness({ students: [student({ institutionId: "inst-B" })] });
  h.deps.faceEnroll = async () => {
    enrollCalls += 1;
    return acceptedResponse();
  };

  await assert.rejects(
    () => enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps),
    ForbiddenError,
  );
  assert.equal(enrollCalls, 0);
});

test("an admin with faceEmbedding.manage but not enroll.own cannot use the self path", async () => {
  // The two permissions are not a hierarchy. Staff enrolment names its
  // subject; self-enrolment cannot, so an actor holding only the staff
  // permission must not be able to reach it.
  const h = harness();
  await assert.rejects(() => enrollOwnFaceRequest(staffAdmin(), CAMERA, h.deps), ForbiddenError);
});

test("self-enrollment uses the caller's own profile and accepts no student id", async () => {
  const other = student({ id: "student-2", userId: "user-other", studentCode: "S-002" });
  const h = harness({ students: [student(), other] });

  const result = await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);

  assert.equal(result.ok, true);
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].studentId, "student-1", "the caller's own linked profile");
  assert.equal(h.inserted[0].channel, "SELF");
});

test("a student id smuggled into the self-enrollment input is ignored", async () => {
  // TypeScript already refuses the field; this asserts what happens if it
  // arrives anyway — from an untyped caller, or a future action that widens
  // its schema. The subject comes from the session's user id and from nothing
  // else, so the extra property has no path to take.
  const other = student({ id: "student-2", userId: "user-other", studentCode: "S-002" });
  const h = harness({ students: [student(), other] });

  await enrollOwnFaceRequest(
    studentUser(),
    { ...CAMERA, studentId: "student-2" } as never,
    h.deps,
  );

  assert.equal(h.inserted[0].studentId, "student-1");
});

test("a student whose account is not linked to a profile is refused, not guessed at", async () => {
  const h = harness({ students: [] });
  await assert.rejects(
    () => enrollOwnFaceRequest(studentUser(), CAMERA, h.deps),
    /no_linked_student_profile/,
  );
});

test("every read behind an enrollment is scoped to the student's own institution", async () => {
  const h = harness();
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.deepEqual([...new Set(h.scopes)], ["inst-A"]);
});

// ---------------------------------------------------------------------------
// Self-enrollment policy
// ---------------------------------------------------------------------------

test("a school that has not enabled self-enrollment refuses it, and says why", async () => {
  const h = harness({ institution: institution({ type: "SCHOOL" }) });
  const result = await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "self_enrollment_disabled");
  assert.equal(result.ok === false && result.retryable, false, "another photo cannot help");
  assert.match(result.message, /staff/i);
  assert.equal(h.inserted.length, 0);
});

test("the policy is checked before the photograph is sent anywhere", async () => {
  let enrollCalls = 0;
  const h = harness({ institution: institution({ type: "SCHOOL" }) });
  h.deps.faceEnroll = async () => {
    enrollCalls += 1;
    return acceptedResponse();
  };

  await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);
  assert.equal(enrollCalls, 0, "a refused channel must not produce a biometric template");
});

test("a school can turn self-enrollment on, and then it works", async () => {
  const h = harness({
    institution: institution({
      type: "SCHOOL",
      settings: { faceEnrollmentPolicy: { selfEnrollmentEnabled: true } },
    }),
  });
  const result = await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);
  assert.equal(result.ok, true);
});

test("the policy does not restrict staff enrollment", async () => {
  // Staff must always be able to enrol. The setting is about the student
  // portal, and a reading that disabled the school workflow at a school would
  // disable the feature entirely for its intended user.
  const h = harness({ institution: institution({ type: "SCHOOL" }) });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

test("a student at the sample cap cannot add another", async () => {
  const h = harness({ storedModels: new Array(MAX_SAMPLES_PER_STUDENT).fill(MODEL) });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "sample_limit");
  assert.equal(result.ok === false && result.retryable, false);
  assert.equal(result.status.remainingSlots, 0);
  assert.equal(h.inserted.length, 0);
});

test("the cap is checked before the model runs", async () => {
  let enrollCalls = 0;
  const h = harness({ storedModels: new Array(MAX_SAMPLES_PER_STUDENT).fill(MODEL) });
  h.deps.faceEnroll = async () => {
    enrollCalls += 1;
    return acceptedResponse();
  };

  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(enrollCalls, 0);
});

test("a student one below the cap can still add a sample", async () => {
  const h = harness({ storedModels: new Array(MAX_SAMPLES_PER_STUDENT - 1).fill(MODEL) });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
  assert.equal(result.status.remainingSlots, 0, "and is now at the cap");
});

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

test("no face is rejected without storing anything", async () => {
  const h = harness({ enrollResponse: rejectedResponse("no_face") });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_face");
  assert.equal(result.ok === false && result.retryable, true, "a better photo can fix it");
  assert.match(result.message, /no face was detected/i);
  assert.equal(h.inserted.length, 0);
});

test("more than one face in frame is rejected without storing anything", async () => {
  // The rejection that protects a register: a second person behind the student
  // is how the wrong face ends up under a name.
  const h = harness({ enrollResponse: rejectedResponse("multiple_faces") });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "multiple_faces");
  assert.equal(h.inserted.length, 0);
});

test("every quality reason is reported as itself and is retryable", async () => {
  const reasons: FaceQualityReason[] = [
    "face_too_small",
    "blurred",
    "too_dark",
    "occluded",
    "bad_angle",
    "low_quality",
  ];
  for (const reason of reasons) {
    const h = harness({ enrollResponse: rejectedResponse(reason) });
    const result = await enrollFaceForStudentRequest(
      staffAdmin(),
      { studentId: "student-1", ...CAMERA },
      h.deps,
    );
    assert.equal(result.ok === false && result.reason, reason, reason);
    assert.equal(result.ok === false && result.retryable, true, reason);
    assert.equal(h.inserted.length, 0, reason);
  }
});

test("a quality rejection is not written to the audit log", async () => {
  // A blurred photograph is not an event. Logging every retake would bury the
  // two refusals that do matter.
  const h = harness({ enrollResponse: rejectedResponse("blurred") });
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(h.audits.length, 0);
});

test("a face service that is down is reported as temporary, and stores nothing", async () => {
  const h = harness({ enrollThrows: true });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "service_error");
  assert.equal(result.ok === false && result.retryable, true);
  assert.equal(h.inserted.length, 0);
});

// ---------------------------------------------------------------------------
// The embedding contract
// ---------------------------------------------------------------------------

test("a vector that is not unit length is refused, and nothing is stored", async () => {
  // The silent corruption: cosine similarity is computed as a dot product, so
  // an un-normalised template does not score slightly wrong — it scores on a
  // different scale, and every threshold in the product misreads it for as
  // long as the row exists.
  const h = harness({
    enrollResponse: acceptedResponse({ embedding: UNIT_512.map((v) => v * 3) }),
  });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "invalid_embedding");
  assert.equal(result.ok === false && result.retryable, false, "the photograph is not the problem");
  assert.equal(h.inserted.length, 0);
});

test("a vector of the wrong dimension is refused before it reaches the column", async () => {
  const h = harness({ enrollResponse: acceptedResponse({ embedding: [1, 0, 0] }) });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok === false && result.reason, "invalid_embedding");
  assert.equal(h.inserted.length, 0);
});

test("a broken embedding contract is audited, because it is a deployment fault", async () => {
  const h = harness({ enrollResponse: acceptedResponse({ embedding: UNIT_512.map((v) => v * 3) }) });
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "face_enrollment.refused");
  const payload = h.audits[0].afterJson as Record<string, unknown>;
  assert.equal(payload.refusal, "invalid_embedding");
  assert.equal(payload.problem, "not_normalised");
});

// ---------------------------------------------------------------------------
// Duplicate and ambiguous identity
// ---------------------------------------------------------------------------

test("a face already enrolled against another student is refused", async () => {
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", similarity: 0.93 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.equal(result.ok === false && result.retryable, false);
  assert.equal(h.inserted.length, 0, "nothing is stored");
});

test("a staff refusal names the student it collided with, because only they can resolve it", async () => {
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", similarity: 0.93 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.match(result.message, /Rohan Gupta/);
  assert.match(result.message, /S-002/);
});

test("a student is never told whose face theirs collided with", async () => {
  // The privacy split. Naming a classmate would hand a student a biometric
  // inference about somebody else in exchange for nothing they could act on.
  const h = harness({
    institution: institution({ type: "COLLEGE" }),
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", similarity: 0.93 }],
  });

  const result = await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);

  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.doesNotMatch(result.message, /Rohan/);
  assert.doesNotMatch(result.message, /S-002/);
  assert.doesNotMatch(result.message, /student-2/);
  assert.match(result.message, /office/i, "and is told who can help");
});

test("a near-collision is refused as ambiguous rather than stored", async () => {
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", similarity: 0.5 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok === false && result.reason, "ambiguous_identity");
  assert.equal(h.inserted.length, 0);
});

test("a collision is audited with both student ids and no vector", async () => {
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", similarity: 0.93 }],
  });

  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "face_enrollment.refused");
  const payload = h.audits[0].afterJson as Record<string, unknown>;
  assert.equal(payload.collidedWithStudentId, "student-2");
  assert.equal(payload.similarity, 0.93);
  assert.equal(auditText(h).includes(String(UNIT_512[0])), false, "no vector in the log");
});

test("re-submitting the same photograph is reported, not stored twice", async () => {
  const h = harness({
    neighbours: [{ embeddingId: "emb-own", studentId: "student-1", similarity: 0.999 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "already_enrolled");
  assert.equal(h.inserted.length, 0);
  assert.equal(h.audits.length, 0, "nothing happened that needs a permanent record");
});

test("a second, genuinely different photograph of the same student is stored", async () => {
  const h = harness({
    storedModels: [MODEL],
    neighbours: [{ embeddingId: "emb-own", studentId: "student-1", similarity: 0.85 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, true, "the check must not refuse what it exists to allow");
  assert.equal(h.inserted.length, 1);
});

test("the duplicate scan is scoped to the institution and to the running model", async () => {
  const h = harness();
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.scans.length, 1);
  assert.equal(h.scans[0].institutionId, "inst-A");
  assert.deepEqual(h.scans[0].model, MODEL, "templates from another model are not comparable");
});

test("a duplicate scan that fails does not block the enrollment", async () => {
  // A database error is not evidence of a duplicate. Refusing every enrollment
  // because a query threw would be an outage dressed up as a safety feature.
  const h = harness({ scanThrows: true });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
  assert.equal(h.inserted.length, 1);
});

// ---------------------------------------------------------------------------
// The happy path, and what it stores
// ---------------------------------------------------------------------------

test("a successful enrollment stores a template and never returns the vector", async () => {
  const h = harness();
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.embeddingId, "emb-1");
  assert.equal(result.ok === true && result.qualityScore, 0.9);
  // The invariant, asserted on the serialised result rather than on a field
  // list: a vector cannot hide in a nested object.
  assert.equal(JSON.stringify(result).includes(String(UNIT_512[0])), false);
  assert.equal("embedding" in result, false);
});

test("the provenance a future model swap needs is stored with the template", async () => {
  const h = harness();
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  const row = h.inserted[0];
  assert.equal(row.modelName, "mock");
  assert.equal(row.modelVersion, "0.1.0+pp1");
  assert.equal(row.weightsVersion, "0.1.0", "which weights produced this vector");
  assert.equal(row.preprocessingVersion, "1", "and which preprocessing");
  assert.equal(row.embeddingDim, 512);
  assert.equal(row.aligned, true);
  assert.equal(row.qualityScore, 0.9);
});

test("the raw image is never persisted", async () => {
  const h = harness();
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(h.inserted[0].sourceImageUrl, null);
});

test("how the image arrived, and who enrolled it, are recorded", async () => {
  const h = harness();
  await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", imageBase64: "AAAA", captureSource: "UPLOAD" },
    h.deps,
  );

  assert.equal(h.inserted[0].captureSource, "UPLOAD");
  assert.equal(h.inserted[0].channel, "STAFF");
  assert.equal(h.inserted[0].enrolledByUserId, "user-1");
});

test("an upload passes exactly the same checks as a camera capture", async () => {
  // The upload is a fallback, not a lesser path. If it skipped the quality
  // gate it would be the way round it.
  const h = harness({ enrollResponse: rejectedResponse("multiple_faces") });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", imageBase64: "AAAA", captureSource: "UPLOAD" },
    h.deps,
  );
  assert.equal(result.ok === false && result.reason, "multiple_faces");
  assert.equal(h.inserted.length, 0);
});

test("the audit row carries the model and the score, and never the template", async () => {
  const h = harness();
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "face_enrollment.created");
  assert.equal(h.audits[0].institutionId, "inst-A");
  assert.equal(h.audits[0].actorUserId, "user-1");

  const payload = h.audits[0].afterJson as Record<string, unknown>;
  assert.equal(payload.studentId, "student-1");
  assert.equal(payload.modelName, "mock");
  assert.equal(payload.weightsVersion, "0.1.0");
  assert.equal(payload.captureSource, "CAMERA");
  assert.equal(auditText(h).includes(String(UNIT_512[0])), false);
});

test("the result reports the slot count after the write, not before it", async () => {
  const h = harness({ storedModels: [MODEL] });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.status.usableSamples, 2);
  assert.equal(result.status.remainingSlots, MAX_SAMPLES_PER_STUDENT - 2);
});

test("swapping the model backend does not change enrollment behaviour", async () => {
  // The whole point of the provider contract: apps/web depends on a vector of
  // a fixed length and a shared vocabulary, never on which model produced it.
  const h = harness({
    enrollResponse: acceptedResponse({
      modelName: "arcface-r100",
      modelVersion: "1.2.3+pp4",
      weightsVersion: "1.2.3",
      preprocessingVersion: "4",
    }),
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(h.inserted[0].modelName, "arcface-r100");
  assert.equal(h.inserted[0].weightsVersion, "1.2.3");
  assert.deepEqual(h.scans[0].model, { modelName: "arcface-r100", modelVersion: "1.2.3+pp4" });
});

// ---------------------------------------------------------------------------
// Replacement
// ---------------------------------------------------------------------------

test("replacing retires the existing set and stores one new template", async () => {
  const h = harness({ storedModels: [MODEL, MODEL, MODEL] });
  const result = await replaceFaceEnrollmentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.replaced, 3);
  assert.equal(h.replaced.length, 1, "one atomic operation, not a delete then an insert");
  assert.equal(h.inserted.length, 0);
  assert.match(result.message, /3 earlier samples retired/);
});

test("a replacement is allowed when the student is at the cap", async () => {
  // Otherwise the cap would be inescapable: a student with five poor samples
  // could never be re-enrolled.
  const h = harness({ storedModels: new Array(MAX_SAMPLES_PER_STUDENT).fill(MODEL) });
  const result = await replaceFaceEnrollmentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
  assert.equal(result.status.usableSamples, 1, "the new one is the only one left");
  assert.equal(result.status.remainingSlots, MAX_SAMPLES_PER_STUDENT - 1);
});

test("replacing with the same photograph is allowed, because that is the ordinary case", async () => {
  // Re-taking a poor photograph of the same person produces a near-identical
  // vector. Refusing it as a duplicate would make replacement useless.
  const h = harness({
    storedModels: [MODEL],
    neighbours: [{ embeddingId: "emb-own", studentId: "student-1", similarity: 0.999 }],
  });
  const result = await replaceFaceEnrollmentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
});

test("a replacement is still refused when the face belongs to another student", async () => {
  // The relaxation above applies only to the student's own templates. The
  // safety check is not a step replacement can skip.
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", similarity: 0.95 }],
  });
  const result = await replaceFaceEnrollmentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.equal(h.replaced.length, 0);
});

test("a replacement is audited as one act, with the number retired", async () => {
  const h = harness({ storedModels: [MODEL, MODEL, MODEL] });
  await replaceFaceEnrollmentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "face_enrollment.replaced");
  assert.equal((h.audits[0].afterJson as Record<string, unknown>).retiredTemplates, 3);
});

test("replacement requires faceEmbedding.manage and respects the tenant boundary", async () => {
  const h = harness({ students: [student({ institutionId: "inst-B" })] });
  await assert.rejects(
    () => replaceFaceEnrollmentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps),
    ForbiddenError,
  );

  const teacher = makeUser({ roleKey: "FACULTY", permissions: ["cohort.read"] });
  await assert.rejects(
    () => replaceFaceEnrollmentRequest(teacher, { studentId: "student-1", ...CAMERA }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.replaced.length, 0);
});

// ---------------------------------------------------------------------------
// Retiring a template
// ---------------------------------------------------------------------------

test("retiring is checked against the row's own institution, read from the database", async () => {
  const h = harness({ owner: { studentId: "student-9", institutionId: "inst-B" } });
  await assert.rejects(
    () => deactivateFaceEmbeddingRequest(staffAdmin(), "emb-x", h.deps),
    ForbiddenError,
  );
  assert.equal(h.retired.length, 0);
});

test("retiring records who did it and why, and audits it", async () => {
  const h = harness();
  await deactivateFaceEmbeddingRequest(staffAdmin(), "emb-x", h.deps);

  assert.deepEqual(h.retired, [{ id: "emb-x", institutionId: "inst-A", reason: "WITHDRAWN" }]);
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "face_enrollment.deactivated");
});

test("retiring a template that is already retired is quiet, not an error", async () => {
  // Two administrators can press the same button. The second press should not
  // produce a failure or a second audit row.
  const h = harness();
  h.deps.retireTemplate = async () => 0;

  await deactivateFaceEmbeddingRequest(staffAdmin(), "emb-x", h.deps);
  assert.equal(h.audits.length, 0);
});

test("a template that does not exist is refused without revealing whether it exists elsewhere", async () => {
  const h = harness({ owner: null });
  await assert.rejects(
    () => deactivateFaceEmbeddingRequest(staffAdmin(), "emb-missing", h.deps),
    /face_embedding_not_found/,
  );
});

test("a student cannot retire their own template", async () => {
  // A privacy control that doubles as an attendance loophole: a student able
  // to remove their template can make themselves unrecognisable before a class.
  const h = harness();
  await assert.rejects(
    () => deactivateFaceEmbeddingRequest(studentUser(), "emb-x", h.deps),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("reading a student's enrollment requires the permission and the tenant match", async () => {
  const h = harness({ students: [student({ institutionId: "inst-B" })] });
  await assert.rejects(
    () => getStudentFaceEnrollment(staffAdmin(), "student-1", h.deps),
    ForbiddenError,
  );

  const teacher = makeUser({ roleKey: "FACULTY", permissions: ["cohort.read"] });
  await assert.rejects(() => getStudentFaceEnrollment(teacher, "student-1", h.deps), ForbiddenError);
});

test("an unreachable face service leaves the history readable with the model unknown", async () => {
  const h = harness({ storedModels: [MODEL] });
  h.deps.faceModelInfo = async () => {
    throw new Error("down");
  };
  h.deps.listSampleHistoryForStudent = async () => [
    {
      id: "emb-1",
      createdAt: new Date("2026-09-01"),
      modelName: "mock",
      modelVersion: "0.1.0+pp1",
      weightsVersion: "0.1.0",
      preprocessingVersion: "1",
      embeddingDim: 512,
      aligned: true,
      qualityScore: 0.9,
      captureSource: "CAMERA",
      channel: "STAFF",
      enrolledByName: "Anita Deshpande",
      isActive: true,
      retiredAt: null,
      retiredByName: null,
      retirementReason: null,
    },
  ];

  const view = await getStudentFaceEnrollment(staffAdmin(), "student-1", h.deps);

  assert.equal(view.runningModel, null);
  assert.equal(view.samples.length, 1);
  assert.equal(view.status.modelUnknown, true);
  assert.equal(view.status.status, "ENROLLED", "never 'everyone must re-enrol' because a probe failed");
});

test("the history view carries no field that could hold a vector", async () => {
  const h = harness();
  h.deps.listSampleHistoryForStudent = async () => [
    {
      id: "emb-1",
      createdAt: new Date("2026-09-01"),
      modelName: "mock",
      modelVersion: "0.1.0+pp1",
      weightsVersion: "0.1.0",
      preprocessingVersion: "1",
      embeddingDim: 512,
      aligned: true,
      qualityScore: 0.9,
      captureSource: "UPLOAD",
      channel: "SELF",
      enrolledByName: null,
      isActive: false,
      retiredAt: new Date("2026-09-10"),
      retiredByName: "Anita Deshpande",
      retirementReason: "REPLACED",
    },
  ];

  const view = await getStudentFaceEnrollment(staffAdmin(), "student-1", h.deps);
  const serialised = JSON.stringify(view);
  assert.equal(serialised.includes("embedding\":["), false);
  assert.equal("embedding" in view.samples[0], false);
});

test("a student reads their own status without learning anyone else's", async () => {
  const h = harness({ storedModels: [MODEL, MODEL] });
  const view = await getOwnFaceEnrollment(studentUser(), h.deps);

  assert.equal(view.status.usableSamples, 2);
  assert.equal(view.selfEnrollmentEnabled, true);
  assert.equal("samples" in view, false, "no per-template provenance on the student portal");
});

test("the portal reports the policy so it can explain a closed door", async () => {
  const h = harness({ institution: institution({ type: "SCHOOL" }) });
  const view = await getOwnFaceEnrollment(studentUser(), h.deps);
  assert.equal(view.selfEnrollmentEnabled, false);
});

test("reading your own status requires the self-enrollment permission", async () => {
  const h = harness();
  await assert.rejects(() => getOwnFaceEnrollment(staffAdmin(), h.deps), ForbiddenError);
});
