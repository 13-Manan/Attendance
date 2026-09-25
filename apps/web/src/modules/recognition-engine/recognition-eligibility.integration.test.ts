import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  deactivateFaceEmbeddingRequest,
  enrollFaceForStudentRequest,
  replaceFaceEnrollmentRequest,
} from "@/modules/face-enrollment/service";
import { findNearestTemplatesInInstitution } from "@/modules/face-enrollment/repository";
import { insertGallerySample, findGalleryCandidates } from "@/modules/face-gallery/repository";
import { galleryIdForCohort } from "@/modules/face-gallery/policy";
import { deleteStudentFaceData } from "@/modules/privacy/service";
import {
  removeStudentFromClassForRequest,
  setStudentStatusForRequest,
} from "@/modules/students/directory-service";
import { generateAttendanceCandidates } from "@/modules/attendance-review/service";
import {
  findCandidateEmbeddingsWithVectorsForCohort,
  findCandidateEmbeddingsWithVectorsForCohortSubject,
} from "@/modules/recognition-results/repository";
import { runRecognitionForSession } from "./service.ts";
import type { RecognitionRunSummary } from "./types.ts";
import type { DetectEmbedResponse, EnrollResponse, ModelInfoResponse } from "@attendance/shared-types";

/**
 * Recognition eligibility across a student's whole lifecycle, against the real
 * database: the reported bug was a student "deleted" (archived) in the
 * directory who kept being recognised, because nothing between the database
 * and the recogniser read the student's status. See
 * modules/recognition-results/eligibility.ts for the rule.
 *
 * Everything that decides is real — the pgvector queries, enrollment's
 * duplicate scan, recognition, the register write, archiving, erasure. Only
 * face-ai is replaced, by a stand-in that returns a fixed vector per "face", so
 * a face can be enrolled under one student and later under another. Access
 * checks that read role assignments are waived: authorisation has its own
 * suites, and this one is about which templates exist for whom.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "elig-";
const I1 = `${P}inst-1`;
const I2 = `${P}inst-2`;

function model(version: string): ModelInfoResponse {
  return {
    modelName: "elig-model",
    modelVersion: version,
    weightsVersion: version,
    preprocessingVersion: "1",
    embeddingDim: 128,
    embeddingNormalized: true,
    runtime: "test",
    commercialUse: "not-applicable",
    productionEligible: false,
    contractVersion: "v1",
  };
}
const MODEL = model("1+pp1");
const OLD_MODEL = model("0+pp1");

// One "face" is an axis; its samples lean slightly off it in different
// directions, so five samples of one face are five distinct templates that all
// match the face (0.989) and each other (0.978). Different faces are ~0.02.
const unit = (weights: Record<number, number>): number[] => {
  const v = new Array<number>(128).fill(0);
  let norm = 0;
  for (const [i, w] of Object.entries(weights)) {
    v[Number(i)] = w;
    norm += w * w;
  }
  return v.map((x) => x / Math.sqrt(norm));
};
const faceProbe = (face: number) => unit({ [face]: 1 });
const faceSample = (face: number, sample: number) => unit({ [face]: 1, [40 + sample]: 0.15 });

function admin(institutionId: string): SessionUser {
  return {
    userId: `${institutionId}-admin`,
    email: `${institutionId}-admin@test.local`,
    name: "Admin",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Admin",
        institutionId,
        campusId: null,
        permissions: [
          "faceEmbedding.manage",
          "student.update",
          "student.read",
          "attendanceSession.capture",
          "enrollment.manage",
        ],
      },
    ],
  };
}

async function cleanup() {
  const institutions = { in: [I1, I2] };
  await prisma.attendanceRecord.deleteMany({ where: { institutionId: institutions } });
  await prisma.attendanceSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.faceGalleryPlacement.deleteMany({ where: { institutionId: institutions } });
  await prisma.faceEmbedding.deleteMany({ where: { institutionId: institutions } });
  await prisma.studentSubjectEnrollment.deleteMany({ where: { student: { institutionId: institutions } } });
  await prisma.enrollment.deleteMany({ where: { institutionId: institutions } });
  await prisma.student.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohortSubject.deleteMany({ where: { cohort: { institutionId: institutions } } });
  await prisma.subject.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohort.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicUnit.deleteMany({ where: { institutionId: institutions } });
  await prisma.auditLog.deleteMany({ where: { institutionId: institutions } });
  await prisma.user.deleteMany({ where: { institutionId: institutions } });
  await prisma.institution.deleteMany({ where: { id: institutions } });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  for (const id of [I1, I2]) {
    await prisma.institution.create({ data: { id, name: id, type: "SCHOOL" } });
    await prisma.user.create({
      data: { id: `${id}-admin`, institutionId: id, email: `${id}-admin@test.local`, name: "Admin", passwordHash: "x", status: "ACTIVE" },
    });
    await prisma.academicUnit.create({ data: { id: `${id}-unit`, institutionId: id, kind: "GRADE", name: "Grade" } });
    await prisma.academicSession.create({
      data: { id: `${id}-term`, institutionId: id, name: "2026-27", startDate: new Date("2026-04-01T00:00:00Z"), endDate: new Date("2027-03-31T00:00:00Z") },
    });
  }
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// A class, a session, and the operations a school performs
// ---------------------------------------------------------------------------

let worlds = 0;

async function world(institutionId: string = I1) {
  const key = `${institutionId}-w${++worlds}`;
  const cohortId = `${key}-class`;
  await prisma.cohort.create({
    data: { id: cohortId, institutionId, academicUnitId: `${institutionId}-unit`, academicSessionId: `${institutionId}-term`, name: key },
  });
  const sessionId = `${key}-session`;
  await prisma.attendanceSession.create({
    data: { id: sessionId, institutionId, cohortId, facultyId: `${institutionId}-admin`, sessionDate: new Date("2026-09-25T00:00:00Z"), status: "OPEN" },
  });
  const actor = admin(institutionId);
  return {
    key,
    institutionId,
    cohortId,
    sessionId,
    actor,
    /** A student on roll and, unless told otherwise, in this class. */
    async student(label: string, opts: { inClass?: boolean } = {}): Promise<string> {
      const id = `${key}-${label}`;
      await prisma.student.create({
        data: { id, institutionId, studentCode: id, firstName: label, lastName: "Test" },
      });
      if (opts.inClass !== false) {
        await prisma.enrollment.create({ data: { institutionId, studentId: id, cohortId } });
      }
      return id;
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

function faceAi(m: ModelInfoResponse, vector: number[]) {
  const response: EnrollResponse = {
    accepted: true,
    assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
    embedding: vector,
    modelName: m.modelName,
    modelVersion: m.modelVersion,
    embeddingDim: 128,
    weightsVersion: m.weightsVersion,
    preprocessingVersion: m.preprocessingVersion,
    aligned: true,
  };
  return { faceModelInfo: async () => m, faceEnroll: async () => response };
}

async function enrol(
  w: World,
  studentId: string,
  face: number,
  sample: number,
  opts: { model?: ModelInfoResponse; confirmDistinctFromStudentId?: string } = {},
) {
  return enrollFaceForStudentRequest(
    w.actor,
    {
      studentId,
      imageBase64: "AAAA",
      captureSource: "CAMERA",
      confirmDistinctFromStudentId: opts.confirmDistinctFromStudentId,
    },
    faceAi(opts.model ?? MODEL, faceSample(face, sample)),
  );
}

async function enrolFive(w: World, studentId: string, face: number) {
  for (let s = 0; s < 5; s++) {
    const result = await enrol(w, studentId, face, s);
    assert.equal(result.ok, true, `sample ${s + 1} of ${studentId}: ${result.ok ? "" : result.reason}`);
  }
}

async function recognise(
  w: World,
  faces: number[],
  opts: { model?: ModelInfoResponse; sessionId?: string } = {},
): Promise<RecognitionRunSummary> {
  const m = opts.model ?? MODEL;
  const detect = {
    faces: faces.map((face, i) => ({
      sequenceNumber: 1,
      boundingBox: { x: i * 200, y: 0, width: 120, height: 120 },
      embedding: faceProbe(face),
      detectionConfidence: 0.99,
      qualityScore: 0.9,
    })),
    modelName: m.modelName,
    modelVersion: m.modelVersion,
  } as DetectEmbedResponse;
  return runRecognitionForSession(
    w.actor,
    { sessionId: opts.sessionId ?? w.sessionId, images: [{ sequenceNumber: 1, imageBase64: "x".repeat(64) }] },
    { requireCohortAccess: async () => {}, fetchModelInfo: async () => m, detectEmbed: async () => detect },
  );
}

const withResult = (summary: RecognitionRunSummary, result: string) =>
  summary.perStudent.filter((s) => s.advisoryResult === result).map((s) => s.studentId).sort();
const named = (summary: RecognitionRunSummary) =>
  summary.perStudent.filter((s) => s.matchStatus !== "UNMATCHED").map((s) => s.studentId).sort();

async function candidates(cohortId: string, m: ModelInfoResponse = MODEL) {
  const rows = await findCandidateEmbeddingsWithVectorsForCohort(cohortId, m);
  return [...new Set(rows.map((r) => r.studentId))].sort();
}

const archive = (w: World, studentId: string) => setStudentStatusForRequest(w.actor, studentId, "INACTIVE");
const restore = (w: World, studentId: string) => setStudentStatusForRequest(w.actor, studentId, "ACTIVE");

async function writeRegister(w: World, recognition: RecognitionRunSummary, merge = false) {
  return generateAttendanceCandidates(
    w.actor,
    { sessionId: w.sessionId, recognition, merge },
    { requireCohortAccess: async () => {} },
  );
}

function recordOf(sessionId: string, studentId: string) {
  return prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId, studentId } } });
}

// ---------------------------------------------------------------------------
// The reported bug, and the lifecycle it belongs to
// ---------------------------------------------------------------------------

test("test_deleted_student_cannot_reappear_after_same_face_reenrollment", { skip: SKIP }, async () => {
  const w = await world();
  const FACE_X = 0;

  // 1. A enrols face X -> X is A.
  const a = await w.student("a");
  await enrolFive(w, a, FACE_X);
  assert.deepEqual(withResult(await recognise(w, [FACE_X]), "PRESENT"), [a]);

  // 2. A is deleted (archived: the directory never deletes a student).
  await archive(w, a);
  assert.deepEqual(await candidates(w.cohortId), [], "A's templates must not come back from pgvector");
  const afterDelete = await recognise(w, [FACE_X]);
  assert.deepEqual(named(afterDelete), [], "X must match nobody");
  assert.equal(afterDelete.unknownFacesTotal, 1);

  // 3. B enrols the SAME face X — accepted, not refused as A's duplicate.
  const b = await w.student("b");
  await enrolFive(w, b, FACE_X);
  const asB = await recognise(w, [FACE_X]);
  assert.deepEqual(withResult(asB, "PRESENT"), [b], "X must be B");
  assert.equal(asB.perStudent.some((s) => s.studentId === a), false, "A must not be named at all");

  // 4. B deleted -> nobody. 5. C enrols X -> C. And again, twice more.
  let previous = b;
  for (const label of ["c", "d", "e"]) {
    await archive(w, previous);
    assert.deepEqual(named(await recognise(w, [FACE_X])), [], `after deleting ${previous}`);
    const next = await w.student(label);
    await enrolFive(w, next, FACE_X);
    assert.deepEqual(withResult(await recognise(w, [FACE_X]), "PRESENT"), [next]);
    assert.deepEqual(await candidates(w.cohortId), [next]);
    previous = next;
  }

  // The deleted students' vectors still physically exist, live: exclusion is
  // the rule, not an accident of cleanup.
  assert.equal(await prisma.faceEmbedding.count({ where: { studentId: a, isActive: true } }), 5);
});

test("A with five templates: archiving excludes all five; B's five are the only eligible ones", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 28);
  assert.equal((await findCandidateEmbeddingsWithVectorsForCohort(w.cohortId, MODEL)).length, 5);
  await archive(w, a);
  assert.equal((await findCandidateEmbeddingsWithVectorsForCohort(w.cohortId, MODEL)).length, 0);
  await enrolFive(w, b, 28);
  const rows = await findCandidateEmbeddingsWithVectorsForCohort(w.cohortId, MODEL);
  assert.equal(rows.length, 5);
  assert.deepEqual([...new Set(rows.map((r) => r.studentId))], [b]);
});

test("erasing face data (hard delete) ends recognition, and the same face can be enrolled again", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 1);
  const erased = await deleteStudentFaceData(w.actor, a);
  assert.equal(erased.deletedTemplates, 5);
  assert.deepEqual(named(await recognise(w, [1])), []);
  await enrolFive(w, b, 1);
  assert.deepEqual(withResult(await recognise(w, [1]), "PRESENT"), [b]);
});

test("withdrawing one template keeps the rest; withdrawing all ends recognition", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 2);
  const ids = (await prisma.faceEmbedding.findMany({ where: { studentId: a }, select: { id: true }, orderBy: { createdAt: "asc" } })).map((r) => r.id);

  await deactivateFaceEmbeddingRequest(w.actor, ids[0]!);
  assert.equal((await findCandidateEmbeddingsWithVectorsForCohort(w.cohortId, MODEL)).length, 4);
  assert.deepEqual(withResult(await recognise(w, [2]), "PRESENT"), [a]);

  for (const id of ids.slice(1)) await deactivateFaceEmbeddingRequest(w.actor, id);
  assert.deepEqual(named(await recognise(w, [2])), []);
  await enrolFive(w, b, 2);
  assert.deepEqual(withResult(await recognise(w, [2]), "PRESENT"), [b]);
});

test("replacing a student's set leaves only the new templates eligible", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  await enrolFive(w, a, 3);
  const replaced = await replaceFaceEnrollmentRequest(
    w.actor,
    { studentId: a, imageBase64: "AAAA", captureSource: "CAMERA" },
    faceAi(MODEL, faceSample(4, 0)),
  );
  assert.equal(replaced.ok, true);
  assert.equal((await findCandidateEmbeddingsWithVectorsForCohort(w.cohortId, MODEL)).length, 1);
  assert.deepEqual(named(await recognise(w, [3])), [], "the retired face no longer matches");
  assert.deepEqual(withResult(await recognise(w, [4]), "PRESENT"), [a]);
});

test("a student taken out of the class is not a candidate there, but is still a live identity", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 5);
  await removeStudentFromClassForRequest(w.actor, { studentId: a, cohortId: w.cohortId });
  assert.deepEqual(await candidates(w.cohortId), []);
  assert.deepEqual(named(await recognise(w, [5])), []);
  // Still on roll: their face still belongs to them, and B cannot take it.
  const attempt = await enrol(w, b, 5, 0);
  assert.equal(attempt.ok === false && attempt.reason, "duplicate_identity");
});

test("restoring an archived student restores eligibility — and a lookalike pair still goes to review", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 6);
  await archive(w, a);
  await enrolFive(w, b, 6);
  await restore(w, a);
  assert.deepEqual(await candidates(w.cohortId), [a, b].sort());

  // The same face under two students on roll: never PRESENT for either, and
  // the one face is given to one student only.
  const run = await recognise(w, [6]);
  assert.deepEqual(withResult(run, "PRESENT"), []);
  assert.equal(named(run).length, 1, "one face, one student");
  assert.equal(withResult(run, "NEEDS_REVIEW").length, 1);

  const revoked = await prisma.auditLog.findMany({ where: { entityId: a, action: "face_enrollment.eligibility_revoked" } });
  const restored = await prisma.auditLog.findMany({ where: { entityId: a, action: "face_enrollment.eligibility_restored" } });
  assert.equal(revoked.length, 1);
  assert.equal(restored.length, 1);
  assert.equal((revoked[0]!.afterJson as { liveTemplates: number }).liveTemplates, 5);
});

test("archiving a student with no templates records no eligibility change", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  await archive(w, a);
  assert.equal(await prisma.auditLog.count({ where: { entityId: a, action: { startsWith: "face_enrollment.eligibility" } } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { entityId: a, action: "student.archived" } }), 1);
});

// ---------------------------------------------------------------------------
// Scope: tenant, class, subject, model
// ---------------------------------------------------------------------------

test("institutions are isolated: deleting in one never touches the other, and a mis-linked row is excluded", { skip: SKIP }, async () => {
  const w1 = await world(I1);
  const w2 = await world(I2);
  const a = await w1.student("a");
  const z = await w2.student("z");
  // The same face in both institutions: the duplicate scan is per tenant.
  await enrolFive(w1, a, 7);
  await enrolFive(w2, z, 7);
  await archive(w1, a);
  assert.deepEqual(withResult(await recognise(w2, [7]), "PRESENT"), [z]);
  assert.deepEqual(named(await recognise(w1, [7])), []);
  assert.deepEqual(await candidates(w1.cohortId), []);

  // An enrollment row linking institution 1's student into institution 2's
  // class — data that must never exist, and must not matter if it does.
  const stray = await w1.student("stray", { inClass: false });
  await enrolFive(w1, stray, 8);
  await prisma.enrollment.create({ data: { institutionId: I2, studentId: stray, cohortId: w2.cohortId } });
  assert.deepEqual(await candidates(w2.cohortId), [z]);
  assert.deepEqual(named(await recognise(w2, [8])), []);
});

test("classes are isolated: a student is a candidate only in their own class", { skip: SKIP }, async () => {
  const w1 = await world();
  const w2 = await world();
  const a = await w1.student("a");
  await enrolFive(w1, a, 9);
  assert.deepEqual(await candidates(w1.cohortId), [a]);
  assert.deepEqual(await candidates(w2.cohortId), []);
  assert.deepEqual(named(await recognise(w2, [9])), []);
});

test("subject sessions apply the same rule", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const c = await w.student("c");
  await enrolFive(w, a, 10);
  await enrolFive(w, c, 11);
  const subject = await prisma.subject.create({ data: { institutionId: I1, code: `${w.key}-sub`, name: "Subject" } });
  const link = await prisma.cohortSubject.create({ data: { cohortId: w.cohortId, subjectId: subject.id } });
  await prisma.studentSubjectEnrollment.createMany({ data: [a, c].map((studentId) => ({ studentId, cohortSubjectId: link.id })) });

  const before = await findCandidateEmbeddingsWithVectorsForCohortSubject(link.id, MODEL);
  assert.deepEqual([...new Set(before.map((r) => r.studentId))].sort(), [a, c].sort());
  await archive(w, a);
  const after = await findCandidateEmbeddingsWithVectorsForCohortSubject(link.id, MODEL);
  assert.deepEqual([...new Set(after.map((r) => r.studentId))], [c]);
});

test("model version filtering is unchanged: another build's templates are never candidates", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  for (let s = 0; s < 3; s++) assert.equal((await enrol(w, a, 12, s, { model: OLD_MODEL })).ok, true);
  await enrolFive(w, b, 13);
  assert.deepEqual(await candidates(w.cohortId, MODEL), [b]);
  assert.deepEqual(await candidates(w.cohortId, OLD_MODEL), [a]);
  assert.deepEqual(named(await recognise(w, [12])), []);
  assert.deepEqual(withResult(await recognise(w, [13]), "PRESENT"), [b]);
});

test("the gallery path applies the same rule", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const galleryId = galleryIdForCohort(w.cohortId);
  const gallery = { modelName: "elig-gallery", modelVersion: "g1" };
  await insertGallerySample({
    institutionId: I1,
    studentId: a,
    ...gallery,
    qualityScore: 0.9,
    captureSource: "CAMERA",
    channel: "STAFF",
    enrolledByUserId: null,
    cohortOfGallery: new Map([[galleryId, w.cohortId]]),
    placements: [{ galleryId, personId: `${w.key}-person-a`, persistedFaceId: `${w.key}-face-a`, personCreated: true }],
  });
  assert.deepEqual((await findGalleryCandidates(galleryId, { cohortId: w.cohortId }, gallery)).map((c) => c.studentId), [a]);
  await archive(w, a);
  assert.deepEqual(await findGalleryCandidates(galleryId, { cohortId: w.cohortId }, gallery), []);
});

// ---------------------------------------------------------------------------
// Enrollment's duplicate scan
// ---------------------------------------------------------------------------

test("the duplicate scan ignores archived students, but a student always sees their own samples", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  for (let sample = 0; sample < 3; sample++) assert.equal((await enrol(w, a, 14, sample)).ok, true);
  await archive(w, a);
  const probe = faceSample(14, 0);
  const others = await findNearestTemplatesInInstitution(I1, probe, MODEL, 8);
  assert.equal(others.some((r) => r.studentId === a), false);
  const own = await findNearestTemplatesInInstitution(I1, probe, MODEL, 8, { enrollingStudentId: a });
  assert.equal(own.filter((r) => r.studentId === a).length, 3);
  // Re-submitting the same photograph for the archived student is still caught.
  const again = await enrol(w, a, 14, 0);
  assert.equal(again.ok === false && again.reason, "already_enrolled");
});

// ---------------------------------------------------------------------------
// What must not change
// ---------------------------------------------------------------------------

test("one-to-one assignment and unrelated students are unaffected", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  const c = await w.student("c");
  await enrolFive(w, a, 15);
  await enrolFive(w, b, 16);
  await enrolFive(w, c, 17);
  const both = await recognise(w, [15, 16]);
  assert.deepEqual(withResult(both, "PRESENT"), [a, b].sort());
  assert.equal(new Set(both.perFace.map((f) => f.candidateStudentId).filter(Boolean)).size, 2);

  await archive(w, a);
  const run = await recognise(w, [15, 16, 17]);
  assert.deepEqual(withResult(run, "PRESENT"), [b, c].sort());
  assert.equal(run.unknownFacesTotal, 1);
});

test("historical attendance survives archiving and erasure", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  await enrolFive(w, a, 18);
  await writeRegister(w, await recognise(w, [18]));
  const before = await recordOf(w.sessionId, a);
  assert.equal(before?.aiResult, "PRESENT");
  assert.ok(before?.matchedEmbeddingId);

  await archive(w, a);
  const archived = await recordOf(w.sessionId, a);
  assert.equal(archived?.aiResult, "PRESENT");
  assert.equal(archived?.finalResult, before?.finalResult);

  await deleteStudentFaceData(w.actor, a);
  const erased = await recordOf(w.sessionId, a);
  assert.equal(erased?.aiResult, "PRESENT", "the register keeps what it recorded");
  assert.equal(erased?.matchedEmbeddingId, null, "only the pointer to the erased template goes");
});

// ---------------------------------------------------------------------------
// No cache, any process, any timing
// ---------------------------------------------------------------------------

test("a fresh process — or another replica — sees the deletion at once", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const c = await w.student("c");
  await enrolFive(w, a, 19);
  await enrolFive(w, c, 20);
  await archive(w, a);
  const probeProcess = () =>
    spawnSync(
      process.execPath,
      ["--import", "./scripts/register-test-loader.mjs", "src/modules/recognition-results/eligibility-probe.fixture.ts", w.cohortId, MODEL.modelName, MODEL.modelVersion],
      { encoding: "utf8", env: process.env },
    );
  for (const replica of [probeProcess(), probeProcess()]) {
    assert.equal(replica.status, 0, replica.stderr);
    assert.deepEqual(JSON.parse(replica.stdout), [c]);
  }
});

test("recognition started after the deletion committed never uses the deleted student", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  await enrolFive(w, a, 21);
  // Runs in flight while A is archived may have read A's templates first.
  // Whatever they return, every run that starts after the archive has
  // committed must not name A.
  const inFlight = Array.from({ length: 6 }, () => recognise(w, [21]));
  await archive(w, a);
  await Promise.allSettled(inFlight);
  const after = await Promise.all(Array.from({ length: 6 }, () => recognise(w, [21])));
  for (const run of after) assert.deepEqual(named(run), []);
});

test("a match made before the deletion is not written to the register after it", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const c = await w.student("c");
  await enrolFive(w, a, 22);
  await enrolFive(w, c, 23);
  // The run reads A's templates and matches the face — then A is archived
  // before the register is written.
  const run = await recognise(w, [22, 23]);
  assert.deepEqual(withResult(run, "PRESENT"), [a, c].sort());
  await archive(w, a);
  await writeRegister(w, run);
  const recordA = await recordOf(w.sessionId, a);
  assert.notEqual(recordA?.aiResult, "PRESENT");
  assert.equal(recordA?.aiResult, "NOT_EVALUATED");
  assert.equal(recordA?.matchedEmbeddingId, null);
  assert.equal((await recordOf(w.sessionId, c))?.aiResult, "PRESENT");
});

test("adding another photo after a deletion does not keep the deleted student's earlier match", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const c = await w.student("c");
  const b = await w.student("b");
  await enrolFive(w, a, 24);
  await enrolFive(w, c, 25);
  // Round 1: A and C found.
  await writeRegister(w, await recognise(w, [24, 25]));
  assert.equal((await recordOf(w.sessionId, a))?.aiResult, "PRESENT");

  // A is deleted; B enrols A's face; round 2 photographs only that face.
  await archive(w, a);
  await enrolFive(w, b, 24);
  await writeRegister(w, await recognise(w, [24]), true);

  assert.equal((await recordOf(w.sessionId, a))?.aiResult, "NOT_EVALUATED", "A's round-1 match rested on a revoked template");
  assert.equal((await recordOf(w.sessionId, b))?.aiResult, "PRESENT");
  // Unchanged merge rule for everyone else: C, not in round 2's photo, keeps round 1.
  assert.equal((await recordOf(w.sessionId, c))?.aiResult, "PRESENT");
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

test("the run log counts what eligibility excluded, never who", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("alpha");
  const c = await w.student("gamma");
  await enrolFive(w, a, 26);
  await enrolFive(w, c, 27);
  await archive(w, a);
  const lines: string[] = [];
  const original = console.info;
  console.info = (line: string) => void lines.push(String(line));
  try {
    await recognise(w, [26, 27]);
  } finally {
    console.info = original;
  }
  const run = JSON.parse(lines.find((l) => l.includes('"recognition.run"'))!);
  assert.equal(run.candidateTemplates, 5);
  assert.equal(run.excludedArchivedStudents, 1);
  assert.equal(run.excludedArchivedTemplates, 5);
  assert.equal(run.excludedTenantMismatchTemplates, 0);
  assert.equal(lines.some((l) => l.includes(a) || l.includes(c)), false, "no student ids");
  assert.doesNotMatch(lines.join("\n"), /0\.9\d{4,}|\[-?0\.\d+,/, "no vectors or similarity lists");
});
