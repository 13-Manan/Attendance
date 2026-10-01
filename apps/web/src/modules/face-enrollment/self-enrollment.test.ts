import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBEDDING_DIMENSION, type EnrollResponse, type FaceQualityReason, type ModelInfoResponse } from "@attendance/shared-types";
import { SYSTEM_ROLES, type PermissionKey } from "../authorization/permissions.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { Student } from "../students/types.ts";
import { MAX_SAMPLES_PER_STUDENT } from "./policy.ts";
import type { InsertFaceEmbeddingInput, NearestTemplateRow } from "./repository.ts";
import { deriveSelfCaptureKey, issueSelfCaptureToken, SELF_CAPTURE_TOKEN_TTL_MS } from "./self-capture.ts";
import {
  enrollOwnFaceFromCameraRequest,
  getOwnFaceEnrollmentOverview,
  shouldPromptOwnFaceEnrollment,
  startOwnFaceCaptureRequest,
  type EnrollmentLock,
  type OwnActiveSample,
  type SelfEnrollmentDeps,
} from "./self-enrollment.ts";
import { enrollFaceForStudentRequest } from "./service.ts";
import { HUMAN_REASON, describeRefusal } from "./types.ts";

/**
 * Student self-enrollment, end to end, without a database or a face service.
 *
 * The path's own rules — camera only, one at a time, the caller's own record
 * and nobody else's — each stated as one test, over the unchanged enrollment
 * core. The core's own rules (quality, the cap, the duplicate scan) have their
 * own suite in service.test.ts; the tests here that touch them check only that
 * the student path still reaches them. The database lock is tested against
 * Postgres in self-enrollment.integration.test.ts.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = deriveSelfCaptureKey("self-enrollment-test-secret");
const NOW = Date.UTC(2026, 8, 30, 10, 0, 0);
const MODEL = { modelName: "self-test", modelVersion: "1+pp1" };
const MODEL_INFO: ModelInfoResponse = {
  ...MODEL,
  weightsVersion: "1",
  preprocessingVersion: "1",
  embeddingDim: EMBEDDING_DIMENSION,
  embeddingNormalized: true,
  runtime: "test",
  commercialUse: "not-applicable",
  productionEligible: false,
  contractVersion: "v1",
};
const UNIT: number[] = Array.from({ length: EMBEDDING_DIMENSION }, () => 1 / Math.sqrt(EMBEDDING_DIMENSION));

function accepted(): EnrollResponse {
  return {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: UNIT,
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
    weightsVersion: "1",
    preprocessingVersion: "1",
    embeddingDim: EMBEDDING_DIMENSION,
    aligned: true,
  };
}

function rejected(reason: FaceQualityReason): EnrollResponse {
  return {
    accepted: false,
    assessment: { reason, qualityScore: 0.1, faceCount: 1 },
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  };
}

/** A JPEG header the way a canvas writes one, padded to a plausible body. */
function jpeg(width = 1280, height = 720): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, ...new Array<number>(400).fill(0x55), 0xff, 0xd9]).toString("base64");
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(300).fill(0)]).toString("base64");

function withRole(roleKey: string, overrides: Partial<SessionUser> = {}): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey);
  assert.ok(role, roleKey);
  const institutionId = overrides.institutionId ?? "college-a";
  return {
    userId: overrides.userId ?? "user-me",
    email: "someone@test.local",
    name: "Someone",
    institutionId,
    campusId: null,
    roles: [{ key: role.key, name: role.name, institutionId, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}
const me = (overrides: Partial<SessionUser> = {}) => withRole("STUDENT", overrides);

function student(overrides: Partial<Student> = {}): Student {
  return {
    id: "student-me",
    institutionId: "college-a",
    userId: "user-me",
    studentCode: "CSE101",
    firstName: "Riya",
    lastName: "Sen",
    status: "ACTIVE",
    ...overrides,
  } as Student;
}
const CLASSMATE = student({ id: "student-other", userId: "user-other", studentCode: "CSE102", firstName: "Priya", lastName: "Sharma" });

function institution(overrides: Partial<Institution> = {}): Institution {
  return { id: "college-a", name: "College A", type: "COLLEGE", settings: {}, ...overrides } as Institution;
}
const SCHOOL = institution({ id: "school-b", name: "School B", type: "SCHOOL" });
const OPEN_SCHOOL = institution({
  id: "school-b",
  name: "School B",
  type: "SCHOOL",
  settings: { faceEnrollmentPolicy: { selfEnrollmentEnabled: true } },
});

/** A lock that behaves as the database one does: one holder per student, a refusal for anybody else. */
function memoryLock(held = new Set<string>()): EnrollmentLock {
  return async (studentId, work) => {
    if (held.has(studentId)) return { acquired: false };
    held.add(studentId);
    try {
      return { acquired: true, value: await work({}) };
    } finally {
      held.delete(studentId);
    }
  };
}

interface Harness {
  deps: SelfEnrollmentDeps;
  inserted: InsertFaceEmbeddingInput[];
  audits: RecordAuditLogInput[];
  logs: string[];
  enrollCalls: number;
  clock: { now: number };
  held: Set<string>;
}

function harness(options: {
  students?: Student[];
  institutions?: Institution[];
  stored?: OwnActiveSample[];
  enrollResponse?: EnrollResponse;
  neighbours?: NearestTemplateRow[];
  enrollDelayMs?: number;
} = {}): Harness {
  const students = options.students ?? [student(), CLASSMATE];
  const institutions = options.institutions ?? [institution(), SCHOOL];
  const stored = [...(options.stored ?? [])];
  const h: Harness = { deps: {}, inserted: [], audits: [], logs: [], enrollCalls: 0, clock: { now: NOW }, held: new Set() };
  h.deps = {
    getStudentById: async (id) => students.find((s) => s.id === id) ?? null,
    getStudentByUserId: async (userId) => students.find((s) => s.userId === userId) ?? null,
    getInstitution: async (id) => institutions.find((i) => i.id === id) ?? null,
    faceModelInfo: async () => MODEL_INFO,
    faceEnroll: async () => {
      h.enrollCalls += 1;
      if (options.enrollDelayMs) await new Promise((resolve) => setTimeout(resolve, options.enrollDelayMs));
      return options.enrollResponse ?? accepted();
    },
    listActiveTemplateModelsForStudent: async (studentId) =>
      studentId === "student-me" ? stored.map(({ modelName, modelVersion }) => ({ modelName, modelVersion })) : [],
    listActiveSamples: async (studentId) => (studentId === "student-me" ? stored : []),
    findNearestTemplates: async () => options.neighbours ?? [],
    findOwnTemplateSimilarities: async () => [],
    insertFaceEmbedding: async (input) => {
      h.inserted.push(input);
      stored.push({ modelName: input.modelName, modelVersion: input.modelVersion, createdAt: new Date(h.clock.now) });
      return { id: `emb-${h.inserted.length}` };
    },
    recordAuditLog: async (input) => {
      h.audits.push(input);
    },
    releaseGalleryFaces: async () => ({ removed: 0, pending: 0 }),
    ownTwinReview: async () => null,
    withEnrollmentLock: memoryLock(h.held),
    captureKey: () => KEY,
    now: () => h.clock.now,
    log: (_level, line) => {
      h.logs.push(line);
    },
  };
  return h;
}

/** Opens a camera session the way the portal does, and returns its token. */
async function cameraSession(h: Harness, actor: SessionUser = me()): Promise<string> {
  const started = await startOwnFaceCaptureRequest(actor, h.deps);
  assert.equal(started.ok, true, started.ok ? "" : started.message);
  return started.ok ? started.captureToken : "";
}

async function captureAndSend(h: Harness, actor: SessionUser = me(), extra: Record<string, unknown> = {}) {
  const captureToken = await cameraSession(h, actor);
  return enrollOwnFaceFromCameraRequest(
    actor,
    { imageBase64: jpeg(), captureSource: "CAMERA", captureToken, ...extra },
    h.deps,
  );
}

const reasonOf = (result: { ok: boolean; reason?: string }) => (result.ok ? "ok" : result.reason);

// ---------------------------------------------------------------------------
// Authorization: the caller's own record, and nobody else's
// ---------------------------------------------------------------------------

test("1. a student can view their own enrollment status", async () => {
  const h = harness({ stored: [{ ...MODEL, createdAt: new Date("2026-09-20T08:00:00Z") }] });
  const overview = await getOwnFaceEnrollmentOverview(me(), h.deps);
  assert.equal(overview.status.status, "ENROLLED");
  assert.equal(overview.status.usableSamples, 1);
  assert.equal(overview.selfEnrollmentEnabled, true);
  assert.deepEqual(overview.enrolledOn, new Date("2026-09-20T08:00:00Z"));
});

test("2. a student can enroll their own face through the camera flow", async () => {
  const h = harness();
  const result = await captureAndSend(h);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.equal(h.inserted.length, 1);
  assert.deepEqual(
    [h.inserted[0].studentId, h.inserted[0].institutionId, h.inserted[0].channel, h.inserted[0].captureSource, h.inserted[0].enrolledByUserId],
    ["student-me", "college-a", "SELF", "CAMERA", "user-me"],
  );
  assert.equal(h.inserted[0].sourceImageUrl, null, "the photograph is not kept");
  assert.equal(h.audits.filter((row) => row.action === "face_enrollment.created").length, 1);
});

test("3/21. a student cannot target another student: a student id in the request is ignored", async () => {
  const h = harness();
  const result = await captureAndSend(h, me(), { studentId: CLASSMATE.id, userId: CLASSMATE.userId });
  assert.equal(result.ok, true);
  assert.equal(h.inserted[0].studentId, "student-me", "the session decides the subject");
});

test("4. there is no way to name another student's record: a camera session from one student is refused for another", async () => {
  const h = harness();
  const mine = await cameraSession(h);
  const classmate = me({ userId: "user-other" });
  const result = await enrollOwnFaceFromCameraRequest(
    classmate,
    { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: mine },
    h.deps,
  );
  assert.equal(reasonOf(result), "camera_required");
  assert.equal(h.enrollCalls, 0, "the photograph was never sent to the model");
  assert.equal(h.inserted.length, 0);
});

test("5. a caller without the self-enrollment permission is refused before anything is read", async () => {
  // Every staff role, including the ones that teach: none of them enrols a
  // face through the student path, and none gains the permission here.
  for (const roleKey of ["FACULTY", "DEPARTMENT_FACULTY", "HOD", "COLLEGE_ADMIN", "SCHOOL_ADMIN", "INSTITUTION_ADMIN"]) {
    if (!SYSTEM_ROLES.some((role) => role.key === roleKey)) continue;
    const h = harness();
    let reads = 0;
    h.deps.getStudentByUserId = async () => {
      reads += 1;
      return student();
    };
    const staff = withRole(roleKey, { userId: "user-me" });
    await assert.rejects(() => startOwnFaceCaptureRequest(staff, h.deps), ForbiddenError, roleKey);
    await assert.rejects(
      () => enrollOwnFaceFromCameraRequest(staff, { imageBase64: jpeg(), captureSource: "CAMERA" }, h.deps),
      ForbiddenError,
      roleKey,
    );
    await assert.rejects(() => getOwnFaceEnrollmentOverview(staff, h.deps), ForbiddenError, roleKey);
    assert.equal(reads, 0, `${roleKey}: refused before any read`);
    assert.equal(h.inserted.length, 0);
  }
});

test("5b. only the STUDENT role holds the self-enrollment permission — no staff role gains it", () => {
  // The platform super-administrator holds every permission by definition;
  // it has no student record, so the path refuses it at "which student?".
  const holders = SYSTEM_ROLES.filter(
    (role) => role.key !== "PLATFORM_SUPER_ADMIN" && role.permissions.includes("faceEmbedding.enroll.own"),
  ).map((role) => role.key);
  assert.deepEqual(holders, ["STUDENT"]);
  const student = SYSTEM_ROLES.find((role) => role.key === "STUDENT")!;
  assert.equal(student.permissions.includes("faceEmbedding.manage"), false, "a student never manages anyone's face");
});

test("6. an archived (disabled) student cannot start the camera or enroll", async () => {
  const h = harness({ students: [student({ status: "INACTIVE" })] });
  await assert.rejects(() => startOwnFaceCaptureRequest(me(), h.deps), ForbiddenError);
  await assert.rejects(
    () => enrollOwnFaceFromCameraRequest(me(), { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: "x" }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.enrollCalls, 0);
  assert.equal(h.inserted.length, 0);
});

test("7. a student at one college cannot enroll against a record at another", async () => {
  // A session from College A whose account is — by whatever data accident —
  // linked to a record at College B.
  const h = harness({
    students: [student({ institutionId: "college-b" })],
    institutions: [institution(), institution({ id: "college-b", name: "College B" })],
  });
  await assert.rejects(() => startOwnFaceCaptureRequest(me(), h.deps), ForbiddenError);
  await assert.rejects(
    () => enrollOwnFaceFromCameraRequest(me(), { imageBase64: jpeg(), captureSource: "CAMERA" }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.inserted.length, 0);
});

test("8/9. a school student cannot reach a college record, nor a college student a school's", async () => {
  const schoolRecord = student({ institutionId: "school-b" });
  const college = harness({ students: [schoolRecord], institutions: [institution(), OPEN_SCHOOL] });
  await assert.rejects(() => startOwnFaceCaptureRequest(me({ institutionId: "college-a" }), college.deps), ForbiddenError);

  const school = harness({ students: [student()], institutions: [institution(), OPEN_SCHOOL] });
  await assert.rejects(() => startOwnFaceCaptureRequest(me({ institutionId: "school-b" }), school.deps), ForbiddenError);

  // And a camera session opened at the college is no use at the school, even
  // for the same account and record id.
  const token = issueSelfCaptureToken(KEY, { userId: "user-me", studentId: "student-me", institutionId: "college-a" }, NOW).token;
  const atSchool = harness({ students: [student({ institutionId: "school-b" })], institutions: [OPEN_SCHOOL] });
  const result = await enrollOwnFaceFromCameraRequest(
    me({ institutionId: "school-b" }),
    { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: token },
    atSchool.deps,
  );
  assert.equal(reasonOf(result), "camera_required");
  assert.equal(atSchool.inserted.length, 0);
});

// ---------------------------------------------------------------------------
// Camera only
// ---------------------------------------------------------------------------

test("10. a frame from the camera flow is accepted", async () => {
  const h = harness();
  const token = await cameraSession(h);
  for (const [width, height] of [[1280, 720], [720, 1280], [640, 480]]) {
    h.inserted.length = 0;
    const result = await enrollOwnFaceFromCameraRequest(
      me(),
      { imageBase64: jpeg(width, height), captureSource: "CAMERA", captureToken: token },
      { ...h.deps, findOwnTemplateSimilarities: async () => [] },
    );
    assert.equal(result.ok, true, `${width}x${height}`);
  }
});

test("11. an uploaded image is refused, even with a camera session and a camera-shaped file", async () => {
  const h = harness();
  const token = await cameraSession(h);
  const result = await enrollOwnFaceFromCameraRequest(
    me(),
    { imageBase64: jpeg(), captureSource: "UPLOAD", captureToken: token },
    h.deps,
  );
  assert.equal(reasonOf(result), "camera_required");
  assert.equal(result.ok === false && result.retryable, true, "a capture from the camera can still succeed");
  assert.match(result.message, /camera on this page/);
  assert.equal(h.enrollCalls, 0);
  assert.equal(h.inserted.length, 0);
});

test("12. a multipart / file-upload request is refused", async () => {
  // What a form post of a file would hand the action: FormData, not the
  // object the camera flow sends.
  const h = harness();
  const token = await cameraSession(h);
  const form = new FormData();
  form.set("imageBase64", jpeg());
  form.set("captureSource", "CAMERA");
  form.set("captureToken", token);
  form.set("file", new Blob([Buffer.from(jpeg(), "base64")], { type: "image/jpeg" }), "me.jpg");
  const result = await enrollOwnFaceFromCameraRequest(me(), form as never, h.deps);
  assert.equal(reasonOf(result), "camera_required");
  assert.equal(h.enrollCalls, 0);
  assert.equal(h.inserted.length, 0);
});

test("13. a direct call that skips the camera is refused, however it is dressed", async () => {
  const h = harness();
  const token = await cameraSession(h);
  const expired = issueSelfCaptureToken(KEY, { userId: "user-me", studentId: "student-me", institutionId: "college-a" }, NOW - SELF_CAPTURE_TOKEN_TTL_MS - 1).token;
  const forged = issueSelfCaptureToken(deriveSelfCaptureKey("a guess"), { userId: "user-me", studentId: "student-me", institutionId: "college-a" }, NOW).token;
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["no camera session", { imageBase64: jpeg(), captureSource: "CAMERA" }],
    ["an invented session", { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: "made.up.token" }],
    ["an expired session", { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: expired }],
    ["a forged session", { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: forged }],
    ["a PNG", { imageBase64: PNG, captureSource: "CAMERA", captureToken: token }],
    ["a phone photograph at full size", { imageBase64: jpeg(4032, 3024), captureSource: "CAMERA", captureToken: token }],
    ["no source", { imageBase64: jpeg(), captureToken: token }],
    ["an image URL", { imageUrl: "https://example.com/me.jpg", captureSource: "CAMERA", captureToken: token }],
  ];
  for (const [label, input] of attempts) {
    const result = await enrollOwnFaceFromCameraRequest(me(), input as never, h.deps);
    assert.equal(reasonOf(result), "camera_required", label);
  }
  assert.equal(h.enrollCalls, 0, "none of them reached the model");
  assert.equal(h.inserted.length, 0);
});

test("the staff path is untouched: it still accepts an upload", async () => {
  const h = harness();
  const result = await enrollFaceForStudentRequest(
    withRole("SCHOOL_ADMIN", { institutionId: "college-a" }),
    { studentId: "student-me", imageBase64: PNG, captureSource: "UPLOAD" },
    h.deps,
  );
  assert.equal(result.ok, true);
  assert.deepEqual([h.inserted[0].channel, h.inserted[0].captureSource], ["STAFF", "UPLOAD"]);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("15/17. opening the page, and starting the camera, write nothing — however often", async () => {
  const h = harness({ stored: [{ ...MODEL, createdAt: new Date(NOW) }] });
  for (let i = 0; i < 3; i++) {
    await getOwnFaceEnrollmentOverview(me(), h.deps);
    await startOwnFaceCaptureRequest(me(), h.deps);
  }
  assert.equal(h.inserted.length, 0);
  assert.equal(h.audits.length, 0);
  assert.equal(h.enrollCalls, 0);
});

test("18. a cancelled capture leaves nothing behind: a camera session alone stores nothing", async () => {
  const h = harness();
  await cameraSession(h);
  h.clock.now += SELF_CAPTURE_TOKEN_TTL_MS + 1;
  const overview = await getOwnFaceEnrollmentOverview(me(), h.deps);
  assert.equal(overview.status.status, "NOT_ENROLLED");
  assert.equal(h.inserted.length, 0);
});

test("19. a photograph the quality gates refuse creates no template, and says what to fix", async () => {
  for (const [reason, pattern] of [
    ["no_face", /No face detected\. Position your face inside the frame/],
    ["face_too_small", /Face is too small\. Move closer/],
    ["too_dark", /Lighting is too dark\. Move to a brighter area/],
    ["blurred", /Image is too blurry\. Hold your device steady/],
    ["bad_angle", /Please look toward the camera/],
    ["multiple_faces", /only you are in the frame/],
  ] as const) {
    const h = harness({ enrollResponse: rejected(reason) });
    const result = await captureAndSend(h);
    assert.equal(reasonOf(result), reason);
    assert.equal(result.ok === false && result.retryable, true, reason);
    assert.match(result.message, pattern, reason);
    assert.equal(h.inserted.length, 0, reason);
  }
});

test("the quality gates are the staff gates: the student's wording changes, the decision does not", () => {
  for (const reason of Object.keys(HUMAN_REASON).filter((r) => r !== "ok") as Array<Exclude<FaceQualityReason, "ok">>) {
    assert.equal(describeRefusal(reason, { channel: "STAFF" }), HUMAN_REASON[reason], "staff wording unchanged");
    assert.ok(describeRefusal(reason, { channel: "SELF" }).length > 0);
  }
});

test("20. a double submit stores one template: the second is told an enrollment is in progress", async () => {
  const h = harness({ enrollDelayMs: 25 });
  const token = await cameraSession(h);
  const send = () =>
    enrollOwnFaceFromCameraRequest(me(), { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: token }, h.deps);
  const results = await Promise.all([send(), send()]);
  assert.deepEqual(results.map(reasonOf).sort(), ["enrollment_in_progress", "ok"]);
  assert.equal(h.inserted.length, 1);
  assert.equal(h.enrollCalls, 1, "the second photograph never reached the model");
  const busy = results.find((r) => !r.ok)!;
  assert.equal(busy.ok === false && busy.retryable, true);
  assert.match(busy.message, /still being processed/);
});

test("a full set of samples is refused at the camera start, and again at the capture", async () => {
  const full = Array.from({ length: MAX_SAMPLES_PER_STUDENT }, () => ({ ...MODEL, createdAt: new Date(NOW) }));
  const h = harness({ stored: full });
  const started = await startOwnFaceCaptureRequest(me(), h.deps);
  assert.deepEqual(started.ok ? "ok" : started.reason, "sample_limit");
  const token = issueSelfCaptureToken(KEY, { userId: "user-me", studentId: "student-me", institutionId: "college-a" }, NOW).token;
  const result = await enrollOwnFaceFromCameraRequest(me(), { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: token }, h.deps);
  assert.equal(reasonOf(result), "sample_limit");
  assert.equal(h.enrollCalls, 0);
});

test("a student adds samples; the guided set is only called complete when it is", async () => {
  const h = harness();
  const messages: string[] = [];
  for (let i = 0; i < MAX_SAMPLES_PER_STUDENT; i++) {
    const result = await captureAndSend(h);
    assert.equal(result.ok, true, `sample ${i + 1}`);
    messages.push(result.message);
  }
  assert.match(messages[0], /^Photo 1 of 5 saved\. Your face is now available for attendance recognition/);
  assert.match(messages[3], /^Photo 4 of 5 saved/);
  assert.equal(messages[4], "Face enrollment complete. Your face is now available for attendance recognition.");
  const overview = await getOwnFaceEnrollmentOverview(me(), h.deps);
  assert.deepEqual([overview.status.status, overview.status.usableSamples, overview.status.remainingSlots], ["ENROLLED", 5, 0]);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("22/24. a collision names nobody, and a student cannot confirm they are a different person", async () => {
  const neighbours: NearestTemplateRow[] = [{ embeddingId: "their-sample", studentId: CLASSMATE.id, rawSimilarity: 0.999 }];
  const h = harness({ neighbours });
  const result = await captureAndSend(h, me(), { confirmDistinctFromStudentId: CLASSMATE.id });
  assert.equal(reasonOf(result), "duplicate_identity", "the confirmation field does nothing on this path");
  assert.equal(result.ok === false && result.collidedWith, undefined);
  for (const secret of [CLASSMATE.id, CLASSMATE.firstName, CLASSMATE.lastName, CLASSMATE.studentCode]) {
    assert.equal(JSON.stringify(result).includes(secret), false, `${secret} reached the student`);
  }
  assert.equal(h.inserted.length, 0);
  assert.equal(h.audits.some((row) => row.action === "face_enrollment.distinct_person_confirmed"), false);
});

test("23. no vector, sample id, score or model provenance reaches the student", async () => {
  const h = harness();
  const result = await captureAndSend(h);
  const overview = await getOwnFaceEnrollmentOverview(me(), h.deps);
  assert.deepEqual(Object.keys(result).sort(), ["message", "ok", "replaced", "status"]);
  assert.deepEqual(Object.keys(overview).sort(), [
    "enrolledOn",
    "institutionType",
    "selfEnrollmentEnabled",
    "status",
    "twinReview",
  ]);
  for (const value of [result, overview]) {
    const text = JSON.stringify(value);
    assert.equal(/embedding|\[-?0\.\d+,|emb-1|modelName|modelVersion|self-test/.test(text), false, text);
  }
});

test("the platform super-administrator, who holds every permission, still has no face to enrol here", async () => {
  const h = harness();
  const platform = withRole("PLATFORM_SUPER_ADMIN", { userId: "platform-admin" });
  await assert.rejects(() => startOwnFaceCaptureRequest(platform, h.deps), /no_linked_student_profile/);
  assert.equal(h.inserted.length, 0);
});

test("a school that has not turned self-enrollment on refuses it at the camera start and at the capture", async () => {
  const h = harness({ students: [student({ institutionId: "school-b" })], institutions: [SCHOOL] });
  const schoolStudent = me({ institutionId: "school-b" });
  const started = await startOwnFaceCaptureRequest(schoolStudent, h.deps);
  assert.equal(started.ok ? "ok" : started.reason, "self_enrollment_disabled");
  const result = await enrollOwnFaceFromCameraRequest(schoolStudent, { imageBase64: jpeg(), captureSource: "CAMERA" }, h.deps);
  assert.equal(reasonOf(result), "self_enrollment_disabled");
  assert.equal(h.inserted.length, 0);
});

test("a school that has turned it on works exactly as a college does", async () => {
  const h = harness({ students: [student({ institutionId: "school-b" })], institutions: [OPEN_SCHOOL] });
  const result = await captureAndSend(h, me({ institutionId: "school-b" }));
  assert.equal(result.ok, true);
  assert.deepEqual([h.inserted[0].institutionId, h.inserted[0].channel], ["school-b", "SELF"]);
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

test("every outcome is logged with ids and categories — never the image, the token or a vector", async () => {
  const h = harness();
  const token = await cameraSession(h);
  await enrollOwnFaceFromCameraRequest(me(), { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: token }, h.deps);
  await enrollOwnFaceFromCameraRequest(me(), { imageBase64: PNG, captureSource: "UPLOAD", captureToken: token }, h.deps);
  const events = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((e) => e.event), [
    "student_face_enrollment.started",
    "student_face_enrollment.success",
    "student_face_enrollment.rejected",
  ]);
  for (const event of events) {
    assert.equal(event.log, "student_face_enrollment");
    assert.deepEqual([event.studentId, event.institutionId, event.scope], ["student-me", "college-a", "college"]);
  }
  const all = h.logs.join("\n");
  for (const secret of [token, jpeg(), PNG, String(UNIT[0])]) {
    assert.equal(all.includes(secret), false, "a secret or an image in the log");
  }
});

test("an unexpected failure is logged by category and reaches the browser as a generic error", async () => {
  const h = harness();
  h.deps.insertFaceEmbedding = async () => {
    throw Object.assign(new Error('invalid input syntax for type vector: "[0.1,0.2]"'), { code: "P2010" });
  };
  const token = await cameraSession(h);
  await assert.rejects(
    () => enrollOwnFaceFromCameraRequest(me(), { imageBase64: jpeg(), captureSource: "CAMERA", captureToken: token }, h.deps),
    (error: Error) => error.message === "face_enrollment_failed",
  );
  const failed = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((e) => e.event === "student_face_enrollment.failed");
  assert.deepEqual([failed?.reason, failed?.detail], ["error", "P2010"]);
  assert.equal(h.logs.join("\n").includes("0.1,0.2"), false, "the error text is not logged");
});

// ---------------------------------------------------------------------------
// The portal home prompt
// ---------------------------------------------------------------------------

test("the portal home invites only a student who may enrol and has no samples", async () => {
  assert.equal(await shouldPromptOwnFaceEnrollment(me(), harness().deps), true);
  assert.equal(
    await shouldPromptOwnFaceEnrollment(me(), harness({ stored: [{ ...MODEL, createdAt: new Date(NOW) }] }).deps),
    false,
    "already enrolled",
  );
  assert.equal(
    await shouldPromptOwnFaceEnrollment(me({ institutionId: "school-b" }), harness({ students: [student({ institutionId: "school-b" })] }).deps),
    false,
    "a school that has not turned it on",
  );
  assert.equal(await shouldPromptOwnFaceEnrollment(withRole("FACULTY"), harness().deps), false, "staff");
  const broken = harness();
  broken.deps.getStudentByUserId = async () => {
    throw new Error("database unavailable");
  };
  assert.equal(await shouldPromptOwnFaceEnrollment(me(), broken.deps), false, "never an error on the home page");
});
