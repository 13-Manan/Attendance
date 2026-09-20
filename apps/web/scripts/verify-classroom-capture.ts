/**
 * Phase 4 end-to-end verification, against a real database and a real face-ai.
 *
 * The unit suites inject every repository, so the SQL that actually enforces
 * cohort scoping — the `$queryRaw` joins in
 * `modules/recognition-results/repository.ts` — is never executed by them. This
 * script runs the real functions against the real local Postgres (with
 * pgvector) and a real FastAPI process, which is the only way to find out
 * whether those queries return what the engine believes they return.
 *
 * It is a development tool, not a test: it needs a live database and a live
 * service, so it cannot run in the hermetic suite. Guarded to localhost for
 * the same reason `dev-fixture.ts` is — this writes attendance rows, and it
 * must never do so anywhere real.
 *
 * Run:
 *   source /tmp/dev-env.sh
 *   node --import ./scripts/register-test-loader.mjs scripts/verify-classroom-capture.ts
 *
 * Leaves the database as it found it: every row it creates is removed in a
 * `finally`, including on failure.
 */

export {};

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("Refusing to run: DATABASE_URL does not point at localhost.");
  process.exit(1);
}

const { prisma } = await import("@/lib/prisma");
const { runRecognitionForSession } = await import("@/modules/recognition-engine/service");
const { generateAttendanceCandidates, getAttendanceReviewBoard, applyReviewDecision, confirmAttendance } =
  await import("@/modules/attendance-review/service");
const { analyzeCaptureImage, startOrResumeCaptureSession } = await import(
  "@/modules/attendance-capture/service"
);
const { enrollFaceForStudentRequest } = await import("@/modules/face-enrollment/service");
const { findUserByEmail } = await import("@/modules/auth-tenancy/repository");
const { toSessionUser } = await import("@/modules/auth-tenancy/service");

/** Loads a fixture account as the session user the services expect. */
async function actorFor(email: string) {
  const user = await findUserByEmail(email);
  if (!user) throw new Error(`Fixture account missing: ${email}`);
  return toSessionUser(user);
}
const { fixtureFrameBase64 } = await import("@/modules/attendance-capture/camera-source");

let failures = 0;
const created = { sessionIds: [] as string[], embeddingIds: [] as string[] };

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * A distinct base64 payload per student.
 *
 * The mock backend derives its embedding from a hash of the bytes, so two
 * different payloads produce two different (and reliably dissimilar) vectors —
 * which is what makes "did the right student match?" a meaningful question
 * against it. The payload is a real JPEG with base64 padding appended, so it
 * passes both the client and server validators.
 */
function imageFor(seed: string): string {
  const base = fixtureFrameBase64();
  return base.slice(0, base.length - seed.length * 8) + "A".repeat(seed.length * 8 - 4) + btoa(seed).replace(/=/g, "");
}

try {
  // -------------------------------------------------------------------------
  console.log("\n[1] Fixture tenancy");
  // -------------------------------------------------------------------------
  const school = await prisma.institution.findFirst({ where: { type: "SCHOOL" } });
  if (!school) throw new Error("No SCHOOL institution — run scripts/dev-fixture.ts first.");
  // The cohort this teacher is actually linked to. Picking any cohort would
  // test the wrong thing: `requireCohortAccess` is one of the checks under
  // examination, so the fixture must satisfy it honestly.
  const link = await prisma.cohortFaculty.findFirst({
    where: { user: { email: "classteacher@greenwood.test" } },
    include: { cohort: true },
  });
  if (!link) throw new Error("Fixture teacher has no cohort link.");
  const cohort = link.cohort;

  const roster = await prisma.student.findMany({
    where: { enrollments: { some: { cohortId: cohort.id, status: "ACTIVE" } } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { lastName: "asc" },
  });
  check("cohort has an enrolled roster", roster.length > 0, `${roster.length} students in ${cohort.name}`);

  // Two actors, because the fixture models a real separation of duties: the
  // class teacher takes attendance but cannot enrol biometrics, and the
  // institution admin can. Using one over-powered account would hide exactly
  // the permission split this phase relies on.
  const actor = await actorFor("classteacher@greenwood.test");
  const admin = await actorFor("admin@greenwood.test");
  check("teacher holds capture, not faceEmbedding.manage",
    actor.roles.some((r) => r.permissions.includes("attendanceSession.capture")) &&
      !actor.roles.some((r) => r.permissions.includes("faceEmbedding.manage")));
  check("admin holds faceEmbedding.manage", admin.roles.some((r) => r.permissions.includes("faceEmbedding.manage")));

  // -------------------------------------------------------------------------
  console.log("\n[2] Face enrollment through the real service (mock backend)");
  // -------------------------------------------------------------------------
  // Two students get templates; the rest deliberately get none, so the
  // "never compared, therefore never absent" rule is exercised for real.
  const enrolled = roster.slice(0, 2);
  for (const student of enrolled) {
    const result = await enrollFaceForStudentRequest(admin, {
      studentId: student.id,
      imageBase64: imageFor(student.id),
      captureSource: "CAMERA",
    });
    check(`enrolled ${student.firstName} ${student.lastName}`, result.ok, result.ok ? "" : result.message);
  }
  const embeddings = await prisma.faceEmbedding.findMany({
    where: { studentId: { in: enrolled.map((s) => s.id) } },
    select: { id: true },
  });
  created.embeddingIds.push(...embeddings.map((e) => e.id));
  check("templates are stored with a vector", embeddings.length === enrolled.length);

  // -------------------------------------------------------------------------
  console.log("\n[3] Cohort-scoped candidate SQL (the query unit tests mock away)");
  // -------------------------------------------------------------------------
  const { findCandidateEmbeddingsWithVectorsForCohort } = await import(
    "@/modules/recognition-results/repository"
  );
  const pool = await findCandidateEmbeddingsWithVectorsForCohort(cohort.id, {
    modelName: "mock",
    modelVersion: "0.1.0+pp1",
  });
  check("pgvector round-trips a 512-d vector", pool.every((c) => c.embedding.length === 512), `${pool.length} candidates`);
  check("every candidate is in this cohort", pool.every((c) => roster.some((r) => r.id === c.studentId)));

  const otherCohort = await prisma.cohort.findFirst({ where: { institutionId: { not: school.id } } });
  if (otherCohort) {
    const foreign = await findCandidateEmbeddingsWithVectorsForCohort(otherCohort.id);
    check(
      "another institution's cohort returns none of our templates",
      !foreign.some((c) => enrolled.some((e) => e.id === c.studentId)),
      `${foreign.length} rows`,
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n[4] Session start, capture gate, recognition");
  // -------------------------------------------------------------------------
  const start = await startOrResumeCaptureSession(actor, { cohortId: cohort.id });
  created.sessionIds.push(start.session.id);
  check("session opened in CAPTURING", start.session.status === "CAPTURING", start.session.id);
  check("enrolled count is reported", start.enrolledStudentCount === roster.length);

  const analysis = await analyzeCaptureImage(actor, {
    sessionId: start.session.id,
    sequenceNumber: 1,
    imageBase64: imageFor(enrolled[0].id),
  });
  check("capture gate accepted the frame", analysis.ok, analysis.ok ? `${analysis.faceCount} faces` : analysis.message);
  check("capture gate returned no embedding", !JSON.stringify(analysis).includes("embedding"));

  const stored = await prisma.attendanceSession.findUnique({
    where: { id: start.session.id },
    select: { metadata: true },
  });
  const captureBucket = (stored?.metadata as Record<string, unknown> | null)?.capture as
    | { analyses?: unknown[] }
    | undefined;
  check("the server recorded its own verdict", Array.isArray(captureBucket?.analyses) && captureBucket.analyses.length === 1);

  const recognition = await runRecognitionForSession(actor, {
    sessionId: start.session.id,
    images: [
      { sequenceNumber: 1, imageBase64: imageFor(enrolled[0].id) },
      { sequenceNumber: 2, imageBase64: imageFor(enrolled[1].id) },
    ],
  });
  check("recognition ran against the cohort pool", recognition.candidateScope === "cohort", `pool ${recognition.candidatePoolSize}`);
  check("model provenance is reported", recognition.modelName === "mock" && recognition.modelVersion === "0.1.0+pp1");
  check("production eligibility is reported honestly", recognition.productionEligible === false);
  check("the summary carries no vector", !JSON.stringify(recognition).includes('"embedding"'));
  check("each student appears at most once", new Set(recognition.perStudent.map((s) => s.studentId)).size === recognition.perStudent.length);
  check("run timing is recorded", typeof recognition.durationMs === "number" && recognition.completedAt.endsWith("Z"));

  // -------------------------------------------------------------------------
  console.log("\n[5] Register generation");
  // -------------------------------------------------------------------------
  const generation = await generateAttendanceCandidates(actor, {
    sessionId: start.session.id,
    recognition,
  });
  check("one row per enrolled student", generation.counts.total === roster.length, JSON.stringify(generation.counts));

  const unenrolledStudents = roster.filter((r) => !enrolled.some((e) => e.id === r.id));
  const rows = await prisma.attendanceRecord.findMany({
    where: { sessionId: start.session.id },
    select: { studentId: true, aiResult: true, finalResult: true, matchedEmbeddingId: true },
  });
  const byStudent = new Map(rows.map((r) => [r.studentId, r]));
  check(
    "a student with no template is NEVER marked absent",
    unenrolledStudents.every((s) => byStudent.get(s.id)?.finalResult === "NEEDS_REVIEW"),
    `${unenrolledStudents.length} students without templates`,
  );
  check(
    "no row is PRESENT without a matched template",
    rows.every((r) => r.finalResult !== "PRESENT" || r.matchedEmbeddingId !== null),
  );

  // -------------------------------------------------------------------------
  console.log("\n[6] Review board, correction, finalization");
  // -------------------------------------------------------------------------
  const board = await getAttendanceReviewBoard(actor, start.session.id);
  check("board partitions the register exactly once", board.present.length + board.absent.length + board.needsReview.length === roster.length);
  check("finalization is blocked while review rows remain", board.canFinalize === false, board.finalizeBlockedReason ?? "");

  // Resolve every outstanding row the way a teacher calling the roll would.
  for (const student of board.needsReview) {
    await applyReviewDecision(actor, {
      attendanceRecordId: student.attendanceRecordId,
      newResult: "PRESENT",
    });
  }
  const resolved = await getAttendanceReviewBoard(actor, start.session.id);
  check("resolving every row unblocks finalization", resolved.canFinalize === true, resolved.finalizeBlockedReason ?? "");

  const corrections = await prisma.attendanceCorrection.count({
    where: { attendanceRecord: { sessionId: start.session.id } },
  });
  check("every manual change wrote an audit row", corrections === board.needsReview.length, `${corrections} corrections`);

  const preservedAi = await prisma.attendanceRecord.findMany({
    where: { sessionId: start.session.id, isManuallyCorrected: true },
    select: { aiResult: true, finalResult: true },
  });
  check(
    "the original AI result survives a correction",
    preservedAi.some((r) => r.aiResult !== r.finalResult),
    "at least one row now disagrees with the machine, and both values are kept",
  );

  const confirmed = await confirmAttendance(actor, start.session.id);
  check("finalization closes the register", confirmed.counts.needsReview === 0 && confirmed.counts.notEvaluated === 0);
  const finalSession = await prisma.attendanceSession.findUniqueOrThrow({
    where: { id: start.session.id },
    select: { status: true, endedAt: true },
  });
  check("session reached FINALIZED", finalSession.status === "FINALIZED" && finalSession.endedAt !== null);

  await assertRejects(
    "a finalized session cannot be finalized twice",
    () => confirmAttendance(actor, start.session.id),
  );

  // -------------------------------------------------------------------------
  console.log("\n[7] Cross-tenant refusal, for real");
  // -------------------------------------------------------------------------
  {
    const intruder = await actorFor("faculty@northfield.test");
    {
      await assertRejects(
        "another institution's faculty cannot read this register",
        () => getAttendanceReviewBoard(intruder, start.session.id),
      );
      await assertRejects(
        "another institution's faculty cannot run recognition on it",
        () =>
          runRecognitionForSession(intruder, {
            sessionId: start.session.id,
            images: [{ sequenceNumber: 1, imageBase64: imageFor("intruder") }],
          }),
      );
    }
  }
} finally {
  // -------------------------------------------------------------------------
  console.log("\n[cleanup]");
  // -------------------------------------------------------------------------
  for (const sessionId of created.sessionIds) {
    await prisma.attendanceCorrection.deleteMany({ where: { attendanceRecord: { sessionId } } });
    await prisma.attendanceRecord.deleteMany({ where: { sessionId } });
    await prisma.sessionImage.deleteMany({ where: { sessionId } });
    await prisma.attendanceSession.delete({ where: { id: sessionId } }).catch(() => {});
  }
  if (created.embeddingIds.length > 0) {
    await prisma.attendanceRecord.updateMany({
      where: { matchedEmbeddingId: { in: created.embeddingIds } },
      data: { matchedEmbeddingId: null },
    });
    await prisma.faceEmbedding.deleteMany({ where: { id: { in: created.embeddingIds } } });
  }
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: created.sessionIds } },
  });
  console.log(`  removed ${created.sessionIds.length} session(s) and ${created.embeddingIds.length} template(s)`);
  await prisma.$disconnect();
}

async function assertRejects(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    failures += 1;
    console.error(`  FAIL  ${label} — it was allowed`);
  } catch (e) {
    console.log(`  ok    ${label} — refused (${e instanceof Error ? e.message : "error"})`);
  }
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
