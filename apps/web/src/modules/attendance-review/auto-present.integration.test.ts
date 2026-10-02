import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { SYSTEM_ROLES } from "@/modules/authorization/permissions";
import { ForbiddenError } from "@/modules/authorization/types";
import { enrollFaceForStudentRequest } from "@/modules/face-enrollment/service";
import {
  removeStudentFromClassForRequest,
  setStudentStatusForRequest,
} from "@/modules/students/directory-service";
import { runRecognitionForSession } from "@/modules/recognition-engine/service";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import { aggregateOverall } from "@/modules/attendance-reporting/repository";
import { startOrResumeCaptureSession } from "@/modules/attendance-capture/service";
import type { DetectEmbedResponse, EnrollResponse, ModelInfoResponse } from "@attendance/shared-types";
import {
  ATTENDANCE_METADATA_KEY,
  applyReviewDecision,
  confirmAttendance,
  generateAttendanceCandidates,
  getAttendanceReviewBoard,
} from "./service.ts";

/**
 * Recognised students are Present (2026-10-02), measured against the real
 * database: the register writes, the corrections, finishing, the audit rows,
 * the reports and their percentage.
 *
 * Everything that decides is real — pgvector matching, eligibility, the
 * one-to-one assignment, the register write, every authorisation check (the
 * actors carry the real role definitions, and the class teacher is linked to
 * the class the way the product links them). Only face-ai is replaced, by a
 * stand-in that returns a fixed vector per "face".
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "autop-";
const I1 = `${P}inst-1`;
const I2 = `${P}inst-2`;
const DAY = new Date("2026-09-25T00:00:00Z");
const WINDOW = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") };

/**
 * Shaped like what production runs — a production-approved embedding model,
 * which must publish a score calibration (an identity map here) — and not the
 * test stand-in, whose matches would stay suggestions.
 */
const MODEL: ModelInfoResponse = {
  modelName: "autop-model",
  modelVersion: "1+pp1",
  weightsVersion: "1+pp1",
  preprocessingVersion: "1",
  embeddingDim: 128,
  embeddingNormalized: true,
  runtime: "test",
  commercialUse: "permitted",
  productionEligible: true,
  contractVersion: "v1",
  calibration: {
    id: "autop-identity",
    knots: [
      { raw: -1, calibrated: -1 },
      { raw: 1, calibrated: 1 },
    ],
    rawAmbiguityMargin: 0.05,
  },
};

// One "face" is an axis; its enrolment samples lean slightly off it, so they
// all match the face (~0.99) and different faces are ~0.02 apart.
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
const faceSample = (face: number, sample: number) => unit({ [face]: 1, [100 + sample]: 0.15 });

// ---------------------------------------------------------------------------
// People: real roles, real user rows
// ---------------------------------------------------------------------------

function withRole(institutionId: string, userId: string, roleKey: string, permissions?: string[]): SessionUser {
  const role = SYSTEM_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(`no role ${roleKey}`);
  return {
    userId,
    email: `${userId}@test.local`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [
      {
        key: role.key,
        name: role.name,
        institutionId,
        campusId: null,
        permissions: (permissions ?? role.permissions) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

/** Sets up students and faces. Not under test here; enrolment has its own suites. */
function admin(institutionId: string): SessionUser {
  return {
    ...withRole(institutionId, `${institutionId}-admin`, "FACULTY"),
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Admin",
        institutionId,
        campusId: null,
        permissions: ["faceEmbedding.manage", "student.update", "student.read", "enrollment.manage"],
      },
    ],
  };
}

const PEOPLE = ["admin", "teacher", "other", "operator"] as const;

async function cleanup() {
  const institutions = { in: [I1, I2] };
  await prisma.attendanceCorrection.deleteMany({ where: { attendanceRecord: { institutionId: institutions } } });
  await prisma.attendanceRecord.deleteMany({ where: { institutionId: institutions } });
  await prisma.sessionImage.deleteMany({ where: { session: { institutionId: institutions } } });
  await prisma.attendanceSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.faceGalleryPlacement.deleteMany({ where: { institutionId: institutions } });
  await prisma.faceEmbedding.deleteMany({ where: { institutionId: institutions } });
  await prisma.enrollment.deleteMany({ where: { institutionId: institutions } });
  await prisma.student.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: { institutionId: institutions } } });
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
    for (const who of PEOPLE) {
      await prisma.user.create({
        data: { id: `${id}-${who}`, institutionId: id, email: `${id}-${who}@test.local`, name: who, passwordHash: "x", status: "ACTIVE" },
      });
    }
    await prisma.academicUnit.create({ data: { id: `${id}-unit`, institutionId: id, kind: "GRADE", name: "Grade" } });
    await prisma.academicSession.create({
      data: { id: `${id}-term`, institutionId: id, name: "2026-27", startDate: new Date("2026-04-01T00:00:00Z"), endDate: new Date("2027-03-31T00:00:00Z"), isCurrent: true },
    });
  }
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// A class, its teacher, a register in progress
// ---------------------------------------------------------------------------

let worlds = 0;

async function world(institutionId: string = I1, opts: { session?: boolean } = {}) {
  const key = `${institutionId}-w${++worlds}`;
  const cohortId = `${key}-class`;
  await prisma.cohort.create({
    data: { id: cohortId, institutionId, academicUnitId: `${institutionId}-unit`, academicSessionId: `${institutionId}-term`, name: key },
  });
  // The class teacher and an operator are linked to this class; "other" teaches elsewhere.
  for (const who of ["teacher", "operator"]) {
    await prisma.cohortFaculty.create({ data: { cohortId, userId: `${institutionId}-${who}` } });
  }
  let sessionId = `${key}-session`;
  if (opts.session !== false) {
    // Started, as the capture page leaves it: generation then walks it to REVIEW.
    await prisma.attendanceSession.create({
      data: { id: sessionId, institutionId, cohortId, facultyId: `${institutionId}-teacher`, sessionDate: DAY, status: "CAPTURING" },
    });
  }
  return {
    key,
    institutionId,
    cohortId,
    get sessionId() {
      return sessionId;
    },
    set sessionId(id: string) {
      sessionId = id;
    },
    admin: admin(institutionId),
    teacher: withRole(institutionId, `${institutionId}-teacher`, "CLASS_TEACHER"),
    other: withRole(institutionId, `${institutionId}-other`, "FACULTY"),
    operator: withRole(institutionId, `${institutionId}-operator`, "ATTENDANCE_OPERATOR"),
    async student(label: string): Promise<string> {
      const id = `${key}-${label}`;
      await prisma.student.create({ data: { id, institutionId, studentCode: id, firstName: label, lastName: "Test" } });
      await prisma.enrollment.create({ data: { institutionId, studentId: id, cohortId } });
      return id;
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function enrolFive(w: World, studentId: string, face: number) {
  for (let s = 0; s < 5; s++) {
    const response: EnrollResponse = {
      accepted: true,
      assessment: { reason: "ok", qualityScore: 0.9, faceCount: 1 },
      embedding: faceSample(face, s),
      modelName: MODEL.modelName,
      modelVersion: MODEL.modelVersion,
      embeddingDim: 128,
      weightsVersion: MODEL.weightsVersion,
      preprocessingVersion: MODEL.preprocessingVersion,
      aligned: true,
    };
    const result = await enrollFaceForStudentRequest(
      w.admin,
      { studentId, imageBase64: "AAAA", captureSource: "CAMERA" },
      { faceModelInfo: async () => MODEL, faceEnroll: async () => response },
    );
    assert.equal(result.ok, true, `sample ${s + 1} of ${studentId}: ${result.ok ? "" : result.reason}`);
  }
}

/** One recognition run over one or more photos; each photo is the list of faces in it. */
async function recognise(w: World, photos: number[][], actor: SessionUser = w.teacher): Promise<RecognitionRunSummary> {
  const detect = {
    faces: photos.flatMap((faces, p) =>
      faces.map((face, i) => ({
        sequenceNumber: p + 1,
        boundingBox: { x: i * 200, y: 0, width: 120, height: 120 },
        embedding: faceProbe(face),
        detectionConfidence: 0.99,
        qualityScore: 0.9,
      })),
    ),
    modelName: MODEL.modelName,
    modelVersion: MODEL.modelVersion,
  } as DetectEmbedResponse;
  return runRecognitionForSession(
    actor,
    {
      sessionId: w.sessionId,
      // A session holds at most three photos; the type says so.
      images: photos.map((_, p) => ({ sequenceNumber: (p + 1) as 1 | 2 | 3, imageBase64: "x".repeat(64) })),
    },
    { fetchModelInfo: async () => MODEL, detectEmbed: async () => detect },
  );
}

/** The register write, as the teacher — real access checks, no waiver. */
function writeRegister(w: World, recognition: RecognitionRunSummary, merge = false, actor: SessionUser = w.teacher) {
  return generateAttendanceCandidates(actor, { sessionId: w.sessionId, recognition, merge });
}

function recordOf(w: World, studentId: string) {
  return prisma.attendanceRecord.findUnique({ where: { sessionId_studentId: { sessionId: w.sessionId, studentId } } });
}

async function decide(w: World, studentId: string, newResult: "PRESENT" | "ABSENT", opts: { actor?: SessionUser; reason?: string; now?: Date } = {}) {
  const row = await recordOf(w, studentId);
  return applyReviewDecision(
    opts.actor ?? w.teacher,
    { attendanceRecordId: row!.id, newResult, ...(opts.reason ? { reason: opts.reason } : {}) },
    opts.now ? { now: () => opts.now! } : {},
  );
}

function correctionsOf(w: World, studentId?: string) {
  return prisma.attendanceCorrection.findMany({
    where: { attendanceRecord: { sessionId: w.sessionId, ...(studentId ? { studentId } : {}) } },
    orderBy: { changedAt: "asc" },
  });
}

const countWith = (w: World, finalResult: "PRESENT" | "ABSENT" | "NEEDS_REVIEW") =>
  prisma.attendanceRecord.count({ where: { sessionId: w.sessionId, finalResult } });

/** What a report says for this class, and the percentage it would quote. */
async function report(w: World) {
  const [row] = await aggregateOverall(w.institutionId, WINDOW, { cohortIds: [w.cohortId], buckets: null, facultyScope: null });
  const present = row?.present ?? 0;
  const absent = row?.absent ?? 0;
  const rate = present + absent === 0 ? null : Math.round((present / (present + absent)) * 1000) / 10;
  return { present, absent, rate };
}

async function auditAfter(w: World, action: string) {
  const rows = await prisma.auditLog.findMany({ where: { entityId: w.sessionId, action }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.afterJson as Record<string, unknown>);
}

const forbidden = (reason?: string) => (e: unknown) =>
  e instanceof ForbiddenError && (reason === undefined || e.reason.startsWith(reason));

// ---------------------------------------------------------------------------
// 1–3. All present, none present, and the mix
// ---------------------------------------------------------------------------

test("everyone recognised: present at once, nothing to review, finishing decides nobody; reports count them only once finished", { skip: SKIP }, async () => {
  const w = await world();
  const ids = [await w.student("a"), await w.student("b"), await w.student("c")];
  for (const [i, id] of ids.entries()) await enrolFive(w, id, 50 + i);
  await writeRegister(w, await recognise(w, [[50, 51, 52]]));

  for (const id of ids) {
    const row = await recordOf(w, id);
    assert.deepEqual([row?.aiResult, row?.finalResult, row?.isManuallyCorrected], ["PRESENT", "PRESENT", false]);
  }
  assert.equal((await correctionsOf(w)).length, 0, "no approval rows");
  const board = await getAttendanceReviewBoard(w.teacher, w.sessionId);
  assert.deepEqual([board.present.length, board.needsReview.length, board.absent.length, board.canFinalize], [3, 0, 0, true]);

  assert.deepEqual(await report(w), { present: 0, absent: 0, rate: null }, "an unfinished register is not attendance yet");
  await confirmAttendance(w.teacher, w.sessionId);
  assert.equal((await correctionsOf(w)).length, 0, "finishing approved nobody, because nobody needed approving");
  assert.deepEqual(await report(w), { present: 3, absent: 0, rate: 100 });

  const [generated] = await auditAfter(w, "attendance.candidates_generated");
  assert.equal(generated.confidentMatches, "recorded");
  assert.deepEqual(generated.presentByRecognitionStudentIds, [...ids].sort());
  const [finalized] = await auditAfter(w, "attendance.finalized");
  assert.deepEqual(finalized.counts, { present: 3, absent: 0, presentByRecognition: 3, presentByTeacher: 0 });
});

test("nobody recognised — a stranger's face only: the whole class waits for the teacher, and nobody is absent", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 53);
  await enrolFive(w, b, 54);
  const run = await recognise(w, [[55]]);
  assert.equal(run.unknownFacesTotal, 1, "the stranger is counted, and is nobody");
  await writeRegister(w, run);

  for (const id of [a, b]) {
    const row = await recordOf(w, id);
    assert.deepEqual([row?.aiResult, row?.finalResult], ["ABSENT", "NEEDS_REVIEW"], "not detected is not absent");
  }
  assert.equal(await countWith(w, "PRESENT"), 0);
  assert.equal(await countWith(w, "ABSENT"), 0);
  await assert.rejects(() => confirmAttendance(w.teacher, w.sessionId), /unresolved/);
});

test("an unknown face beside a recognised student: the student is present, the stranger is nobody", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 56);
  await enrolFive(w, b, 57);
  const run = await recognise(w, [[56, 58]]);
  assert.equal(run.unknownFacesTotal, 1);
  await writeRegister(w, run);
  assert.equal((await recordOf(w, a))?.finalResult, "PRESENT");
  assert.equal((await recordOf(w, b))?.finalResult, "NEEDS_REVIEW");
  assert.equal(await countWith(w, "PRESENT"), 1, "the stranger made nobody present");
});

// ---------------------------------------------------------------------------
// 5. Duplicates; 7–8. several photos
// ---------------------------------------------------------------------------

test("one student's face twice in one photo is not trusted: they wait for the teacher", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  await enrolFive(w, a, 59);
  await writeRegister(w, await recognise(w, [[59, 59]]));
  const row = await recordOf(w, a);
  assert.equal(row?.finalResult, "NEEDS_REVIEW", "two faces claiming one student is a duplicate, never a present");
  assert.equal(await countWith(w, "PRESENT"), 0);
});

test("two photos in one run: found only in the second is present; found in both is one present row", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  const c = await w.student("c");
  await enrolFive(w, a, 60);
  await enrolFive(w, b, 61);
  await enrolFive(w, c, 62);
  await writeRegister(w, await recognise(w, [[60], [60, 61]]));

  assert.equal((await recordOf(w, a))?.finalResult, "PRESENT");
  assert.equal(await prisma.attendanceRecord.count({ where: { sessionId: w.sessionId, studentId: a } }), 1, "counted once");
  assert.equal((await recordOf(w, b))?.finalResult, "PRESENT", "the second photo counts");
  assert.equal((await recordOf(w, c))?.finalResult, "NEEDS_REVIEW");
  assert.equal(await prisma.attendanceRecord.count({ where: { sessionId: w.sessionId } }), 3, "one row per student");
});

// ---------------------------------------------------------------------------
// 15. Coming back to a register
// ---------------------------------------------------------------------------

test("another photo later keeps every teacher decision and every recorded present, and records a newly found student present", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  const c = await w.student("c");
  await enrolFive(w, a, 63);
  await enrolFive(w, b, 64);
  await enrolFive(w, c, 65);
  await writeRegister(w, await recognise(w, [[63]]));
  await decide(w, c, "ABSENT");

  // The teacher adds a photo in which b and c both appear.
  await writeRegister(w, await recognise(w, [[64, 65]]), true);

  assert.deepEqual(
    [(await recordOf(w, a))?.finalResult, (await recordOf(w, b))?.finalResult, (await recordOf(w, c))?.finalResult],
    ["PRESENT", "PRESENT", "ABSENT"],
    "a kept, b newly present, c is still what the teacher said",
  );
  assert.equal((await recordOf(w, b))?.isManuallyCorrected, false, "b was recorded by recognition");
  assert.deepEqual((await correctionsOf(w)).map((x) => x.newResult), ["ABSENT"], "only the teacher's decision is a correction");
  const rounds = await auditAfter(w, "attendance.candidates_generated");
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[1].presentByRecognitionStudentIds, [a, b].sort());
});

test("starting again the same day resumes the same register, never a second one; a finished register cannot be restarted", { skip: SKIP }, async () => {
  const w = await world(I1, { session: false });
  const a = await w.student("a");
  const first = await startOrResumeCaptureSession(w.teacher, { cohortId: w.cohortId });
  const again = await startOrResumeCaptureSession(w.teacher, { cohortId: w.cohortId });
  assert.equal(again.session.id, first.session.id);
  assert.equal(again.resumed, true);

  w.sessionId = first.session.id;
  await writeRegister(w, await recognise(w, [[66]]));
  const inReview = await startOrResumeCaptureSession(w.teacher, { cohortId: w.cohortId });
  assert.equal(inReview.session.id, first.session.id);
  assert.equal(inReview.session.status, "REVIEW", "resuming never pushes a register back into capture");

  await decide(w, a, "PRESENT");
  await confirmAttendance(w.teacher, w.sessionId);
  await assert.rejects(() => startOrResumeCaptureSession(w.teacher, { cohortId: w.cohortId }), /session_locked:FINALIZED/);
  assert.equal(await prisma.attendanceSession.count({ where: { cohortId: w.cohortId } }), 1, "one register for the day");
});

// ---------------------------------------------------------------------------
// 9–14. Teachers' changes, corrections and who may make them
// ---------------------------------------------------------------------------

test("before finishing: Present → Absent, review → Present and review → Absent are each the teacher's decision on record", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  const c = await w.student("c");
  const d = await w.student("d");
  await enrolFive(w, a, 67);
  await enrolFive(w, b, 68);
  await enrolFive(w, c, 69);
  await enrolFive(w, d, 70);
  await writeRegister(w, await recognise(w, [[67, 68]]));

  await decide(w, a, "ABSENT"); // recognised, but the teacher says otherwise
  await decide(w, c, "PRESENT"); // not detected, but here
  await decide(w, d, "ABSENT"); // not detected, and away

  const trail = async (id: string) =>
    (await correctionsOf(w, id)).map((x) => [x.previousResult, x.newResult, x.source, x.changedByUserId]);
  assert.deepEqual(await trail(a), [["PRESENT", "ABSENT", "FACULTY_REVIEW", w.teacher.userId]]);
  assert.deepEqual(await trail(c), [["NEEDS_REVIEW", "PRESENT", "FACULTY_REVIEW", w.teacher.userId]]);
  assert.deepEqual(await trail(d), [["NEEDS_REVIEW", "ABSENT", "FACULTY_REVIEW", w.teacher.userId]]);
  assert.deepEqual(await trail(b), [], "b was never decided by anyone");

  const board = await getAttendanceReviewBoard(w.teacher, w.sessionId);
  assert.deepEqual([board.counts.present, board.counts.absent, board.counts.needsReview], [2, 2, 0]);
  assert.deepEqual(await report(w), { present: 0, absent: 0, rate: null });
  await confirmAttendance(w.teacher, w.sessionId);
  assert.deepEqual(await report(w), { present: 2, absent: 2, rate: 50 });
  const [finalized] = await auditAfter(w, "attendance.finalized");
  assert.deepEqual(finalized.counts, { present: 2, absent: 2, presentByRecognition: 1, presentByTeacher: 1 });
});

test("after finishing: the class teacher may still correct a recognised Present — as an override, under the school's rules; reports follow", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 71);
  await enrolFive(w, b, 72);
  await writeRegister(w, await recognise(w, [[71, 72]]));
  await confirmAttendance(w.teacher, w.sessionId);
  assert.deepEqual(await report(w), { present: 2, absent: 0, rate: 100 });

  const institution = await prisma.institution.findUniqueOrThrow({ where: { id: w.institutionId } });
  try {
    await prisma.institution.update({
      where: { id: w.institutionId },
      data: { settings: { attendancePolicy: { correctionWindowDays: 1, requireReasonAfterFinalization: true } } },
    });
    await assert.rejects(() => decide(w, a, "ABSENT"), /correction_reason_required/);
    const finishedAt = (await prisma.attendanceSession.findUniqueOrThrow({ where: { id: w.sessionId } })).endedAt!;
    await assert.rejects(
      () => decide(w, a, "ABSENT", { reason: "Left early", now: new Date(finishedAt.getTime() + 3 * 86_400_000) }),
      forbidden("correction_window_closed"),
    );
    assert.equal((await recordOf(w, a))?.finalResult, "PRESENT", "refused changes changed nothing");

    await decide(w, a, "ABSENT", { reason: "Left after the first period" });
  } finally {
    await prisma.institution.update({ where: { id: w.institutionId }, data: { settings: institution.settings ?? {} } });
  }
  const [override] = await correctionsOf(w, a);
  assert.deepEqual(
    [override.previousResult, override.newResult, override.source, override.changedByUserId, override.reason],
    ["PRESENT", "ABSENT", "ADMIN_OVERRIDE", w.teacher.userId, "Left after the first period"],
  );
  assert.deepEqual(await report(w), { present: 1, absent: 1, rate: 50 }, "the report and its percentage follow the correction");
});

test("who may not change a recognised Present: an operator, a teacher of another class, another school — or, once finished, anyone without the finalize permission", { skip: SKIP }, async () => {
  const w = await world();
  const elsewhere = await world(I2);
  const a = await w.student("a");
  const b = await w.student("b");
  await enrolFive(w, a, 73);
  await writeRegister(w, await recognise(w, [[73]]));

  await assert.rejects(() => decide(w, a, "ABSENT", { actor: w.operator }), forbidden("attendanceRecord.correct"));
  await assert.rejects(() => decide(w, a, "ABSENT", { actor: w.other }), forbidden("not_cohort_faculty"));
  await assert.rejects(() => decide(w, a, "ABSENT", { actor: elsewhere.teacher }), forbidden());
  const untouched = await recordOf(w, a);
  assert.deepEqual([untouched?.finalResult, untouched?.isManuallyCorrected], ["PRESENT", false]);
  assert.equal((await correctionsOf(w)).length, 0);

  await decide(w, b, "ABSENT");
  await confirmAttendance(w.teacher, w.sessionId);
  // Linked to the class and allowed to correct, but not to close a register —
  // so not to reopen a line in a closed one either.
  const corrector = withRole(w.institutionId, `${w.institutionId}-operator`, "ATTENDANCE_OPERATOR", [
    "attendanceRecord.read",
    "attendanceRecord.correct",
  ]);
  await assert.rejects(() => decide(w, a, "ABSENT", { actor: corrector }), forbidden("attendance_finalized"));
  assert.equal((await recordOf(w, a))?.finalResult, "PRESENT");
});

// ---------------------------------------------------------------------------
// What automatic Present must never reach
// ---------------------------------------------------------------------------

test("automatic Present never reaches an archived student, a student taken out of the class, another school's student, or a class the teacher does not teach", { skip: SKIP }, async () => {
  const w = await world();
  const elsewhere = await world(I2);
  const archived = await w.student("archived");
  const moved = await w.student("moved");
  const stays = await w.student("stays");
  const theirs = await elsewhere.student("theirs");
  await enrolFive(w, archived, 74);
  await enrolFive(w, moved, 75);
  await enrolFive(elsewhere, theirs, 76);
  await setStudentStatusForRequest(w.admin, archived, "INACTIVE");
  await removeStudentFromClassForRequest(w.admin, { studentId: moved, cohortId: w.cohortId });

  // A teacher who does not teach this class can neither run recognition on it nor write its register.
  await assert.rejects(() => recognise(w, [[74, 75, 76]], w.other), forbidden("not_cohort_faculty"));

  const run = await recognise(w, [[74, 75, 76]]);
  await assert.rejects(() => writeRegister(w, run, false, w.other), forbidden("not_cohort_faculty"));
  await writeRegister(w, run);

  assert.equal(await countWith(w, "PRESENT"), 0, "none of those faces may make anybody present here");
  assert.notEqual((await recordOf(w, archived))?.finalResult, "PRESENT");
  assert.equal(await recordOf(w, moved), null, "no longer on this class's register at all");
  assert.equal((await recordOf(w, stays))?.finalResult, "NEEDS_REVIEW");
  assert.equal(
    await prisma.attendanceRecord.count({ where: { studentId: theirs } }),
    0,
    "another school's student is never written into this one's register",
  );
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("a register written under the suggestion rule (before this change) still finishes the old way: the teacher's finish confirms its suggestions", { skip: SKIP }, async () => {
  const w = await world();
  const a = await w.student("a");
  const b = await w.student("b");
  const c = await w.student("c");
  const note = (suggested: boolean) => ({
    reason: suggested ? null : "no_match",
    ...(suggested ? { aiSuggestion: "PRESENT" } : {}),
    wasAmbiguous: false,
    wasComparable: true,
    bestFaceId: suggested ? "1:0" : null,
  });
  await prisma.attendanceSession.update({
    where: { id: w.sessionId },
    data: {
      status: "REVIEW",
      metadata: {
        [ATTENDANCE_METADATA_KEY]: {
          rosterScope: "cohort",
          generationSource: "recognition",
          generatedAt: "2026-09-25T09:00:00.000Z",
          captureImages: [],
          recognition: null,
          studentNotes: { [a]: note(true), [b]: note(true), [c]: note(false) },
        },
      },
    },
  });
  for (const [id, suggested] of [[a, true], [b, true], [c, false]] as const) {
    await prisma.attendanceRecord.create({
      data: {
        institutionId: w.institutionId,
        sessionId: w.sessionId,
        studentId: id,
        aiResult: suggested ? "PRESENT" : "ABSENT",
        finalResult: "NEEDS_REVIEW",
      },
    });
  }

  const board = await getAttendanceReviewBoard(w.teacher, w.sessionId);
  assert.deepEqual([board.present.length, board.needsReview.length, board.awaitingConfirmation], [2, 1, 2]);
  await decide(w, c, "ABSENT");
  await confirmAttendance(w.teacher, w.sessionId);

  for (const id of [a, b]) {
    assert.equal((await recordOf(w, id))?.finalResult, "PRESENT");
    assert.deepEqual(
      (await correctionsOf(w, id)).map((x) => [x.previousResult, x.newResult, x.changedByUserId]),
      [["NEEDS_REVIEW", "PRESENT", w.teacher.userId]],
      "confirmed by the teacher who finished, as before",
    );
  }
  const [finalized] = await auditAfter(w, "attendance.finalized");
  assert.deepEqual(finalized.counts, { present: 2, absent: 1, presentByRecognition: 0, presentByTeacher: 2 });
  assert.deepEqual(await report(w), { present: 2, absent: 1, rate: 66.7 });
});
