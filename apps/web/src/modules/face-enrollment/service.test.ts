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
import type {
  EnrollResponse,
  FaceQualityReason,
  GalleryEnrollRequest,
  GalleryEnrollResponse,
  GalleryRemoveRequest,
  ModelInfoResponse,
} from "@attendance/shared-types";
import type { InsertGallerySampleInput } from "../face-gallery/repository.ts";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";

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
 * A genuinely L2-normalised vector of the contract's current length.
 *
 * Every component is 1/sqrt(n), so the norm is exactly 1 to within float error.
 * This matters: the service refuses a vector that is not unit length, and a
 * fixture that happened to be un-normalised would make every happy-path test
 * fail for a reason unrelated to what it was asserting.
 *
 * Derived from `EMBEDDING_DIMENSION` rather than written out, so the day the
 * contract's width changes this fixture follows it instead of turning every
 * enrollment test into a wrong-dimension failure.
 */
const UNIT_VECTOR: number[] = Array.from(
  { length: EMBEDDING_DIMENSION },
  () => 1 / Math.sqrt(EMBEDDING_DIMENSION),
);

function acceptedResponse(overrides: Partial<Extract<EnrollResponse, { accepted: true }>> = {}) {
  return {
    accepted: true as const,
    assessment: { reason: "ok" as const, qualityScore: 0.9, faceCount: 1 },
    embedding: UNIT_VECTOR,
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    weightsVersion: "0.1.0",
    preprocessingVersion: "1",
    embeddingDim: EMBEDDING_DIMENSION,
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
  embeddingDim: EMBEDDING_DIMENSION,
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
  /** Every own-sample consistency query, with what it was scoped to. */
  ownScans: Array<{ institutionId: string; studentId: string }>;
}

function harness(options: {
  students?: Student[];
  institution?: Institution;
  enrollResponse?: EnrollResponse | (() => EnrollResponse);
  storedModels?: Array<{ modelName: string; modelVersion: string }>;
  neighbours?: NearestTemplateRow[];
  owner?: { studentId: string; institutionId: string } | null;
  ownSimilarities?: NearestTemplateRow[];
  scanThrows?: boolean;
  ownScanThrows?: boolean;
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
    ownScans: [],
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
    findOwnTemplateSimilarities: async (institutionId, studentId) => {
      if (options.ownScanThrows) throw new Error("pgvector unavailable");
      h.scopes.push(institutionId);
      h.ownScans.push({ institutionId, studentId });
      return options.ownSimilarities ?? [];
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
    releaseGalleryFaces: async () => ({ removed: 0, pending: 0 }),
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
    enrollResponse: acceptedResponse({ embedding: UNIT_VECTOR.map((v) => v * 3) }),
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
  const h = harness({ enrollResponse: acceptedResponse({ embedding: UNIT_VECTOR.map((v) => v * 3) }) });
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
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
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
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
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
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
  });

  const result = await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);

  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.doesNotMatch(result.message, /Rohan/);
  assert.doesNotMatch(result.message, /S-002/);
  assert.doesNotMatch(result.message, /student-2/);
  assert.match(result.message, /office/i, "and is told who can help");
});

test("a lookalike is enrolled and noted, not refused", async () => {
  // Changed deliberately (services/face-ai/docs/CALIBRATION.md, "Enrollment
  // at institution scale"). This used to be refused as `ambiguous_identity`,
  // which across a whole institution refuses most students once it holds a
  // few hundred — and leaves each of them with no template at all, so never
  // recognised. The two are told apart at attendance, or sent to review.
  const h = harness({
    students: [
      student(),
      student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" }),
    ],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.5 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(h.inserted.length, 1, "the sample is stored");
  // Staff are told whom it resembles and what attendance will do about it.
  assert.match(result.message, /Rohan Gupta \(S-002\)/);
  assert.match(result.message, /review/);
  // The resemblance is recorded, as ids and a score.
  const created = h.audits.find((a) => a.action === "face_enrollment.created");
  const payload = created?.afterJson as Record<string, unknown>;
  assert.equal(payload.lookalikeOfStudentId, "student-2");
  assert.equal(payload.lookalikeSimilarity, 0.5);
  assert.equal(auditText(h).includes(String(UNIT_VECTOR[0])), false, "no vector in the log");
});

test("a student enrolling themselves is never told whom they resemble", async () => {
  const h = harness({
    institution: institution({ type: "COLLEGE" }),
    students: [
      student(),
      student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" }),
    ],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.5 }],
  });

  const result = await enrollOwnFaceRequest(studentUser(), CAMERA, h.deps);

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.message, /Rohan|S-002|student-2|resembles/);
});

test("a lookalike does not hide a re-submitted photograph", async () => {
  // The lookalike is set aside and the scan carries on: the same bytes twice
  // is still caught, rather than spending a sample slot on it.
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002" })],
    storedModels: [MODEL],
    neighbours: [
      { embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.5 },
      { embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.995 },
    ],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "already_enrolled");
  assert.equal(h.inserted.length, 0);
});

test("a lookalike does not skip the check against the student's own samples", async () => {
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002" })],
    storedModels: [MODEL],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.5 }],
    ownSimilarities: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.2 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "does_not_match_student");
  assert.equal(h.inserted.length, 0);
});

// ---------------------------------------------------------------------------
// Identical twins: a duplicate that is two people
// ---------------------------------------------------------------------------

const TWINS = [
  student(),
  student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" }),
];

test("a duplicate refusal tells staff whom a 'different people' confirmation would name", async () => {
  const h = harness({
    students: TWINS,
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.deepEqual(result.ok === false && result.collidedWith, {
    studentId: "student-2",
    label: "Rohan Gupta (S-002)",
  });
  assert.match(result.message, /twins/);
});

test("staff can confirm identical twins are different people, and the confirmation is audited", async () => {
  const h = harness({
    students: TWINS,
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA, confirmDistinctFromStudentId: "student-2" },
    h.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(h.inserted.length, 1);
  const confirmed = h.audits.find((a) => a.action === "face_enrollment.distinct_person_confirmed");
  assert.ok(confirmed, "the override has its own audit row");
  const payload = confirmed.afterJson as Record<string, unknown>;
  assert.equal(payload.studentId, "student-1");
  assert.equal(payload.distinctFromStudentId, "student-2");
  assert.equal(payload.similarity, 0.93);
  assert.equal(confirmed.actorUserId, staffAdmin().userId);
  assert.equal(auditText(h).includes(String(UNIT_VECTOR[0])), false, "no vector in the log");
});

test("a confirmation naming a different student waives nothing", async () => {
  const h = harness({
    students: TWINS,
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA, confirmDistinctFromStudentId: "student-9" },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.equal(h.inserted.length, 0);
});

test("a confirmation names one student: a second strong collision is still refused", async () => {
  // Triplets, or a twin and a genuine duplicate record: confirming one
  // collision must not wave through the other.
  const h = harness({
    students: [
      ...TWINS,
      student({ id: "student-3", userId: "u3", studentCode: "S-003", firstName: "Arjun", lastName: "Gupta" }),
    ],
    neighbours: [
      { embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 },
      { embeddingId: "emb-y", studentId: "student-3", rawSimilarity: 0.9 },
    ],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA, confirmDistinctFromStudentId: "student-2" },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.equal(result.ok === false && result.collidedWith?.studentId, "student-3");
  assert.equal(h.inserted.length, 0);
});

test("a student cannot confirm they are not a twin of somebody else", async () => {
  // Self-enrollment has no field for it; a client that sends one anyway is
  // not heard, and learns nothing about whom it collided with.
  const h = harness({
    institution: institution({ type: "COLLEGE" }),
    students: TWINS,
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
  });

  const smuggled = { ...CAMERA, confirmDistinctFromStudentId: "student-2" } as typeof CAMERA;
  const result = await enrollOwnFaceRequest(studentUser(), smuggled, h.deps);

  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.equal(result.ok === false && result.collidedWith, undefined);
  assert.equal(h.inserted.length, 0);
});

test("a collision is audited with both student ids and no vector", async () => {
  const h = harness({
    students: [student(), student({ id: "student-2", userId: "u2", studentCode: "S-002" })],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.93 }],
  });

  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].action, "face_enrollment.refused");
  const payload = h.audits[0].afterJson as Record<string, unknown>;
  assert.equal(payload.collidedWithStudentId, "student-2");
  assert.equal(payload.similarity, 0.93);
  assert.equal(auditText(h).includes(String(UNIT_VECTOR[0])), false, "no vector in the log");
});

// ---------------------------------------------------------------------------
// Consistency with the student's own samples
// ---------------------------------------------------------------------------

test("a photograph of somebody else entirely is refused, even when nobody is enrolled with it", async () => {
  // The defect this check exists for: the neighbour scan is silent because the
  // person in the photograph has no template anywhere, so without a comparison
  // against this student's *own* samples the face is stored under their name
  // and that person is marked present as them.
  const h = harness({
    storedModels: [MODEL],
    ownSimilarities: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.19 }],
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "does_not_match_student");
  assert.equal(h.inserted.length, 0);
});

test("the mismatch refusal is retryable, because the next photograph may be the right one", async () => {
  const h = harness({
    storedModels: [MODEL],
    ownSimilarities: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.19 }],
  });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok === false && result.retryable, true);
});

test("a mismatch is audited with no second student and no vector", async () => {
  // There is no other student to name — that is the whole point of this
  // refusal — so the row carries only the score and how many templates it lost
  // to.
  const h = harness({
    storedModels: [MODEL],
    ownSimilarities: [
      { embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.19 },
      { embeddingId: "emb-own-2", studentId: "student-1", rawSimilarity: 0.11 },
    ],
  });

  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.equal(h.audits.length, 1);
  const payload = h.audits[0].afterJson as Record<string, unknown>;
  assert.equal(payload.refusal, "does_not_match_student");
  assert.equal(payload.similarity, 0.19);
  assert.equal(payload.comparedWith, 2);
  assert.equal(payload.collidedWithStudentId, undefined);
  assert.equal(auditText(h).includes(String(UNIT_VECTOR[0])), false, "no vector in the log");
});

test("the own-sample query is scoped to one student at one institution", async () => {
  const h = harness({ storedModels: [MODEL] });
  await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);

  assert.deepEqual(h.ownScans, [{ institutionId: "inst-A", studentId: "student-1" }]);
});

test("a staff mismatch says whose photograph to check; a student's does not name anyone", async () => {
  const mismatch = {
    storedModels: [MODEL],
    ownSimilarities: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.19 }],
  };
  const staff = harness(mismatch);
  const staffResult = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    staff.deps,
  );
  assert.match(staffResult.message, /photograph/i);

  const own = harness({ ...mismatch, institution: institution({ type: "COLLEGE" }) });
  const ownResult = await enrollOwnFaceRequest(studentUser(), CAMERA, own.deps);
  assert.equal(ownResult.ok === false && ownResult.reason, "does_not_match_student");
  assert.doesNotMatch(ownResult.message, /student-1/);
});

test("a student with no samples yet is not asked to match samples that do not exist", async () => {
  const h = harness({ ownSimilarities: [] });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
});

test("a failed own-sample query does not fail the enrollment", async () => {
  // Same posture as the neighbour scan: a safety query that could not run is
  // not evidence of a problem, and making enrollment depend on pgvector being
  // reachable would take the whole feature down with it.
  const h = harness({ storedModels: [MODEL], ownScanThrows: true });
  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );
  assert.equal(result.ok, true);
});

test("a replacement is not checked against the templates it is about to retire", async () => {
  // Re-enrolment from scratch is the intended answer when a student no longer
  // resembles their old templates — a child who has grown, a new model. If the
  // check ran here, that student would have no way back in.
  const h = harness({
    storedModels: [MODEL],
    ownSimilarities: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.05 }],
  });

  const result = await replaceFaceEnrollmentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(h.ownScans, [], "and the query is not even made");
});

test("re-submitting the same photograph is reported, not stored twice", async () => {
  const h = harness({
    neighbours: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.999 }],
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
    neighbours: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.85 }],
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
  assert.equal(JSON.stringify(result).includes(String(UNIT_VECTOR[0])), false);
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
  assert.equal(row.embeddingDim, EMBEDDING_DIMENSION);
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
  assert.equal(auditText(h).includes(String(UNIT_VECTOR[0])), false);
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
    neighbours: [{ embeddingId: "emb-own", studentId: "student-1", rawSimilarity: 0.999 }],
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
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.95 }],
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
      embeddingDim: EMBEDDING_DIMENSION,
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
      embeddingDim: EMBEDDING_DIMENSION,
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

// ---------------------------------------------------------------------------
// Gallery providers (Azure AI Face). Every provider answer is a fixture.
// ---------------------------------------------------------------------------

const GALLERY_MODEL_INFO: ModelInfoResponse = {
  ...MODEL_INFO,
  modelName: "azure-face",
  modelVersion: "detection_03+recognition_04",
  embeddingDim: 0,
  commercialUse: "permitted",
  productionEligible: true,
  templateKind: "gallery",
  identification: "enabled",
};

function galleryResponse(
  overrides: Partial<GalleryEnrollResponse> = {},
): GalleryEnrollResponse {
  return {
    outcome: "accepted",
    assessment: { reason: "ok", qualityScore: 0.92, faceCount: 1 },
    placements: [
      { galleryId: "att-co1", personId: "person-1", persistedFaceId: "face-1", personCreated: true },
    ],
    collision: null,
    ownConfidence: null,
    modelName: GALLERY_MODEL_INFO.modelName,
    modelVersion: GALLERY_MODEL_INFO.modelVersion,
    ...overrides,
  };
}

function galleryHarness(options: {
  identification?: ModelInfoResponse["identification"];
  cohorts?: string[];
  persons?: Map<string, string>;
  response?: GalleryEnrollResponse | Error;
  insertThrows?: boolean;
  collisionOwner?: string | null;
  students?: Student[];
} = {}) {
  const base = harness({ students: options.students });
  const g = {
    enrollRequests: [] as GalleryEnrollRequest[],
    removals: [] as GalleryRemoveRequest[],
    inserted: [] as InsertGallerySampleInput[],
    replacedWith: [] as InsertGallerySampleInput[],
    released: 0,
    faceEnrollCalls: 0,
  };
  base.deps = {
    ...base.deps,
    faceModelInfo: async () => ({
      ...GALLERY_MODEL_INFO,
      identification: options.identification ?? "enabled",
    }),
    faceEnroll: async () => {
      g.faceEnrollCalls++;
      throw new Error("the vector path must not run for a gallery model");
    },
    listActiveCohortIdsForStudent: async () => options.cohorts ?? ["co1"],
    listActiveGalleryPersons: async () => options.persons ?? new Map(),
    findStudentForGalleryPerson: async () =>
      options.collisionOwner === undefined ? "student-2" : options.collisionOwner,
    galleryEnroll: async (request) => {
      g.enrollRequests.push(request);
      const r = options.response ?? galleryResponse();
      if (r instanceof Error) throw r;
      return r;
    },
    galleryRemove: async (request) => {
      g.removals.push(request);
      return { removed: request.removals.length };
    },
    insertGallerySample: async (input) => {
      if (options.insertThrows) throw new Error("db down");
      g.inserted.push(input);
      return { id: "fe-gallery-1" };
    },
    replaceWithGallerySample: async (input) => {
      g.replacedWith.push(input);
      return { id: "fe-gallery-2", retired: 2 };
    },
    releaseGalleryFaces: async () => {
      g.released++;
      return { removed: 0, pending: 0 };
    },
  };
  return { h: base, g };
}

test("gallery: identification not approved refuses before the image is sent", async () => {
  const { h, g } = galleryHarness({ identification: "not_approved" });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok === false && result.reason, "recognition_not_enabled");
  assert.equal(result.ok === false && result.retryable, false);
  assert.equal(g.enrollRequests.length, 0);
  assert.equal(g.faceEnrollCalls, 0);
});

test("gallery: an unreachable identification service is a retryable outage, not a pending approval", async () => {
  const { h, g } = galleryHarness({ identification: "unavailable" });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok === false && result.reason, "service_error");
  assert.equal(result.ok === false && result.retryable, true);
  assert.equal(g.enrollRequests.length, 0);
});

test("gallery: a provider 409 identification_not_approved is the same refusal", async () => {
  const error = Object.assign(new Error("face_ai_request_failed"), { code: "identification_not_approved" });
  const { h, g } = galleryHarness({ response: error });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok === false && result.reason, "recognition_not_enabled");
  assert.equal(g.inserted.length, 0);
});

test("gallery: a student in no class is refused before the image is sent", async () => {
  const { h, g } = galleryHarness({ cohorts: [] });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok === false && result.reason, "no_active_class");
  assert.equal(g.enrollRequests.length, 0);
});

test("gallery: an accepted sample is placed in one gallery per class and stored without a vector", async () => {
  const persons = new Map([["att-co1", "person-existing"]]);
  const { h, g } = galleryHarness({
    cohorts: ["co1", "co2"],
    persons,
    response: galleryResponse({
      placements: [
        { galleryId: "att-co1", personId: "person-existing", persistedFaceId: "f1", personCreated: false },
        { galleryId: "att-co2", personId: "person-new", persistedFaceId: "f2", personCreated: true },
      ],
      ownConfidence: 0.9,
    }),
  });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok, true);
  const request = g.enrollRequests[0];
  assert.deepEqual(request.targets, [
    { galleryId: "att-co1", personId: "person-existing", personName: "student-1" },
    { galleryId: "att-co2", personId: null, personName: "student-1" },
  ]);
  assert.equal(request.otherPersonMinConfidence, 0.7);
  assert.equal(request.ownPersonMinConfidence, 0.5);
  assert.equal(g.inserted.length, 1);
  assert.equal(g.inserted[0].modelName, "azure-face");
  assert.equal(g.inserted[0].cohortOfGallery.get("att-co2"), "co2");
  assert.equal(h.inserted.length, 0, "no vector row is written");
  const audit = h.audits.find((a) => a.action === "face_enrollment.created");
  assert.ok(audit);
  assert.doesNotMatch(JSON.stringify(audit), /person-|"f1"|"f2"|AAAA/);
});

test("gallery: a collision with another student is refused and names them to staff", async () => {
  const other = student({ id: "student-2", studentCode: "S-002", firstName: "Arjun", lastName: "Mehta", userId: null });
  const { h, g } = galleryHarness({
    students: [student(), other],
    response: galleryResponse({
      outcome: "collision",
      placements: [],
      collision: { galleryId: "att-co1", personId: "person-9", confidence: 0.88 },
    }),
  });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok === false && result.reason, "duplicate_identity");
  assert.match(result.ok === false ? result.message : "", /Arjun Mehta/);
  assert.equal(g.inserted.length, 0);
  assert.ok(h.audits.some((a) => a.action === "face_enrollment.refused"));
});

test("gallery: a face that does not verify against the student's own samples is refused", async () => {
  const { h, g } = galleryHarness({
    persons: new Map([["att-co1", "person-1"]]),
    response: galleryResponse({ outcome: "own_mismatch", placements: [], ownConfidence: 0.2 }),
  });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok === false && result.reason, "does_not_match_student");
  assert.equal(g.inserted.length, 0);
});

test("gallery: a quality rejection is reported as itself and stores nothing", async () => {
  const { h, g } = galleryHarness({
    response: galleryResponse({
      outcome: "rejected",
      placements: [],
      assessment: { reason: "blurred", qualityScore: 0.2, faceCount: 1 },
    }),
  });
  const result = await enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.retryable, true);
  assert.equal(g.inserted.length, 0);
});

test("gallery: a failed database write removes what the provider just stored", async () => {
  const { h, g } = galleryHarness({
    insertThrows: true,
    response: galleryResponse({
      placements: [
        { galleryId: "att-co1", personId: "person-old", persistedFaceId: "f1", personCreated: false },
        { galleryId: "att-co2", personId: "person-new", persistedFaceId: "f2", personCreated: true },
      ],
    }),
    cohorts: ["co1", "co2"],
  });
  await assert.rejects(
    enrollFaceForStudentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps),
    /db down/,
  );
  assert.deepEqual(g.removals[0].removals, [
    { galleryId: "att-co1", personId: "person-old", persistedFaceId: "f1" },
    { galleryId: "att-co2", personId: "person-new", persistedFaceId: null },
  ]);
});

test("gallery: replace skips the own-person check, retires old samples and releases their faces", async () => {
  const { h, g } = galleryHarness({ persons: new Map([["att-co1", "person-1"]]) });
  const result = await replaceFaceEnrollmentRequest(staffAdmin(), { studentId: "student-1", ...CAMERA }, h.deps);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.replaced, 2);
  assert.equal(g.enrollRequests[0].ownPersonMinConfidence, 0);
  assert.equal(g.replacedWith.length, 1);
  // Once before sending (stale faces), once after retiring.
  assert.equal(g.released, 2);
});

test("enrollment stops when the model's scale cannot be established", async () => {
  // Without model-info there is no way to know what the duplicate and
  // collision scans' numbers mean. Storing a template on the strength of a
  // check that did not mean what it said is the one mistake here that cannot
  // be undone by retrying — so this refuses, retryably, before the
  // photograph is sent anywhere.
  const h = harness({ storedModels: [MODEL] });
  h.deps.faceModelInfo = async () => {
    throw new Error("down");
  };

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

test("enrollment stops when a production model publishes no score calibration", async () => {
  const h = harness({ storedModels: [MODEL] });
  h.deps.faceModelInfo = async () => ({
    ...MODEL_INFO,
    commercialUse: "permitted",
    productionEligible: true,
    templateKind: "embedding",
    calibration: null,
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  assert.equal(result.ok === false && result.reason, "service_error");
  assert.equal(h.inserted.length, 0);
});

test("a collision scan on a calibrated backend uses the product's scale", async () => {
  // The neighbour is at 0.94 raw — two different people for the dlib
  // recogniser, and 0.518 calibrated. Read raw it would refuse this student's
  // own enrollment as somebody else's face; calibrated it is a lookalike.
  const h = harness({
    students: [
      student(),
      student({ id: "student-2", userId: "u2", studentCode: "S-002", firstName: "Rohan", lastName: "Gupta" }),
    ],
    storedModels: [MODEL],
    neighbours: [{ embeddingId: "emb-x", studentId: "student-2", rawSimilarity: 0.94 }],
  });
  h.deps.faceModelInfo = async () => ({
    ...MODEL_INFO,
    calibration: {
      id: "test",
      knots: [
        { raw: -1, calibrated: -1 },
        { raw: 0.93, calibrated: 0.45 },
        { raw: 0.955, calibrated: 0.62 },
        { raw: 1, calibrated: 1 },
      ],
      rawAmbiguityMargin: 0.01,
    },
  });

  const result = await enrollFaceForStudentRequest(
    staffAdmin(),
    { studentId: "student-1", ...CAMERA },
    h.deps,
  );

  // Read raw, 0.94 is past presentMin and this would be refused as somebody
  // else's face. On the product's scale it is a lookalike: enrolled, noted.
  assert.equal(result.ok, true);
  assert.equal(h.inserted.length, 1);
  assert.match(result.message, /Rohan Gupta/);
});
