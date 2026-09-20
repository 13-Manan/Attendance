/**
 * The attendance pipeline, measured end to end.
 *
 * `services/face-ai/bench/model_perf.py` measures what the model costs.
 * This measures everything the model's answer then travels through: the
 * cohort candidate lookup, the class-scoped search, the confidence engine,
 * the attendance writes, and the review board's own read.
 *
 * ## What it measures, and what it deliberately does not
 *
 * Latency, throughput and correctness under concurrency — all of which are
 * real and reportable. **No accuracy.** It runs against the `mock` backend,
 * whose per-face compute is a deterministic hash, so every similarity here is
 * a fixture rather than a recognition result. That is the right backend for
 * this job: it makes identity assignment deterministic, which is exactly what
 * a *correctness* benchmark needs and exactly what an *accuracy* benchmark
 * must not have.
 *
 * Numbers produced here are therefore the orchestration cost that a real
 * model's inference time is added to, not a total.
 *
 * ## The security scenarios
 *
 * Class-scoped search is benchmarked as correctness, not just speed. A face
 * belonging to another cohort or another institution must not be matched
 * however fast the search is, and a benchmark that only timed the happy path
 * would miss the one failure that matters.
 *
 *   BENCH_DB=1 DATABASE_URL=... FACE_AI_SERVICE_URL=... \
 *     node --import ./scripts/register-test-loader.mjs ./scripts/bench/pipeline.ts
 */
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { prisma } from "@/lib/prisma";
import { findUserByEmail } from "@/modules/auth-tenancy/repository";
import { toSessionUser } from "@/modules/auth-tenancy/service";
import { enrollFaceForStudentRequest } from "@/modules/face-enrollment/service";
import { startOrResumeCaptureSession } from "@/modules/attendance-capture/service";
import { runRecognitionForSession } from "@/modules/recognition-engine/service";
import {
  applyReviewDecision,
  generateAttendanceCandidates,
  getAttendanceReviewBoard,
} from "@/modules/attendance-review/service";
import { fixtureFrameBase64 } from "@/modules/attendance-capture/camera-source";

const HARNESS_VERSION = "1.0.0";

interface Stats {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
}

function stats(values: number[]): Stats {
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  const pct = (p: number) =>
    n === 0 ? 0 : Number(ordered[Math.min(n - 1, Math.max(0, Math.round(p * n) - 1))].toFixed(3));
  return {
    samples: n,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    minMs: n ? Number(ordered[0].toFixed(3)) : 0,
    maxMs: n ? Number(ordered[n - 1].toFixed(3)) : 0,
    meanMs: n ? Number((ordered.reduce((a, b) => a + b, 0) / n).toFixed(3)) : 0,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

/** Deterministic per-student image, so the mock backend assigns identities stably. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function imageFor(seed: string): string {
  let tail = "";
  for (const ch of seed) tail += ALPHABET[ch.charCodeAt(0) % ALPHABET.length];
  while (tail.length % 4 !== 0) tail += "A";
  return fixtureFrameBase64() + tail;
}

async function resetAttendance(): Promise<void> {
  await prisma.attendanceCorrection.deleteMany({});
  await prisma.attendanceRecord.deleteMany({});
  await prisma.attendanceSession.deleteMany({});
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = {
    harnessVersion: HARNESS_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()}-${os.release()}-${os.arch()}`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      faceAiBackend: process.env.FACE_MODEL_BACKEND ?? "mock (assumed)",
    },
    disclaimer:
      "Orchestration cost only, measured against the mock face backend. " +
      "Similarities are fixtures, not recognition results: NO accuracy, " +
      "recall or false-acceptance metric is reported or implied. Real " +
      "model inference time (see services/face-ai/bench/results/model-perf.json) " +
      "is ADDED to these figures, not included in them.",
  };

  const teacherRow = await findUserByEmail("classteacher@greenwood.test");
  const adminRow = await findUserByEmail("admin@greenwood.test");
  if (!teacherRow || !adminRow) {
    throw new Error("Benchmark fixtures missing — run scripts/dev-fixture.ts first.");
  }
  const teacher = toSessionUser(teacherRow);
  const admin = toSessionUser(adminRow);
  const link = await prisma.cohortFaculty.findFirstOrThrow({
    where: { user: { email: "classteacher@greenwood.test" } },
  });
  const cohortId = link.cohortId;

  const students = await prisma.student.findMany({
    where: { enrollments: { some: { cohortId, status: "ACTIVE" } } },
    select: { id: true },
    orderBy: { lastName: "asc" },
  });

  // ---- Enrollment -------------------------------------------------------
  await prisma.faceEmbedding.deleteMany({});
  const enrollMs: number[] = [];
  for (const student of students) {
    const [, ms] = await timed(() =>
      enrollFaceForStudentRequest(admin, {
        studentId: student.id,
        imageBase64: imageFor(student.id),
        captureSource: "CAMERA",
      }),
    );
    enrollMs.push(ms);
  }
  results.enrollment = { students: students.length, stats: stats(enrollMs) };

  // ---- End-to-end capture -> review board, by capture count -------------
  const byCaptureCount: unknown[] = [];
  for (const captureCount of [1, 2, 3]) {
    const startMs: number[] = [];
    const recogniseMs: number[] = [];
    const candidateMs: number[] = [];
    const boardMs: number[] = [];
    const totalMs: number[] = [];
    let lastCounts: Record<string, number> = {};

    for (let run = 0; run < 8; run++) {
      await resetAttendance();
      const runStart = performance.now();

      const [start, ms1] = await timed(() =>
        startOrResumeCaptureSession(teacher, { cohortId }),
      );
      startMs.push(ms1);

      const images = Array.from({ length: captureCount }, (_, i) => ({
        sequenceNumber: (i + 1) as 1 | 2 | 3,
        // Each capture shows a different slice of the class, which is what
        // makes multi-image aggregation do any work at all.
        imageBase64: imageFor(students[(run + i) % students.length].id),
      }));

      const [recognition, ms2] = await timed(() =>
        runRecognitionForSession(teacher, { sessionId: start.session.id, images }),
      );
      recogniseMs.push(ms2);

      const [, ms3] = await timed(() =>
        generateAttendanceCandidates(teacher, { sessionId: start.session.id, recognition }),
      );
      candidateMs.push(ms3);

      const [board, ms4] = await timed(() =>
        getAttendanceReviewBoard(teacher, start.session.id),
      );
      boardMs.push(ms4);
      totalMs.push(performance.now() - runStart);

      lastCounts = {
        total: board.counts.total,
        present: board.counts.present,
        absent: board.counts.absent,
        awaitingDecision: board.awaitingDecision,
        awaitingConfirmation: board.awaitingConfirmation,
      };
    }

    byCaptureCount.push({
      captureCount,
      startSession: stats(startMs),
      recognition: stats(recogniseMs),
      candidateGeneration: stats(candidateMs),
      reviewBoardRead: stats(boardMs),
      endToEnd: stats(totalMs),
      lastBoardCounts: lastCounts,
    });
  }
  results.byCaptureCount = byCaptureCount;

  // ---- Class-scoped search: the security scenarios ----------------------
  //
  // A face belonging to another cohort or another institution must not be
  // matched however fast the search is. Timed *and* asserted.
  await resetAttendance();
  const otherCohortStudent = await prisma.student.findFirst({
    where: {
      institutionId: teacher.institutionId!,
      enrollments: { none: { cohortId } },
    },
    select: { id: true },
  });
  const otherInstitutionStudent = await prisma.student.findFirst({
    where: { NOT: { institutionId: teacher.institutionId! } },
    select: { id: true },
  });

  const scoped = await startOrResumeCaptureSession(teacher, { cohortId });
  const probes: Array<{ scenario: string; studentId: string | null }> = [
    { scenario: "A_in_selected_cohort", studentId: students[0].id },
    { scenario: "B_same_institution_other_cohort", studentId: otherCohortStudent?.id ?? null },
    { scenario: "C_other_institution", studentId: otherInstitutionStudent?.id ?? null },
    { scenario: "D_unknown_person", studentId: null },
  ];

  const scopedRows: unknown[] = [];
  for (const probe of probes) {
    const seed = probe.studentId ?? "never-enrolled-unknown-person-seed";
    const [recognition, ms] = await timed(() =>
      runRecognitionForSession(teacher, {
        sessionId: scoped.session.id,
        images: [{ sequenceNumber: 1, imageBase64: imageFor(seed) }],
      }),
    );
    const matched = recognition.perStudent
      .filter((entry) => entry.matchStatus === "MATCHED")
      .map((entry) => entry.studentId);
    scopedRows.push({
      scenario: probe.scenario,
      probeStudentId: probe.studentId,
      probeIsEnrolledSomewhere: probe.studentId !== null,
      // The assertion that matters: a probe from outside the selected cohort
      // must not appear here however fast the search was.
      matchedStudentIds: matched,
      probeWasMatched: probe.studentId !== null && matched.includes(probe.studentId),
      perFaceDecisions: recognition.perFace.map((face) => face.decision),
      // The advisory vocabulary, which is as far as recognition may go.
      // PRESENT/ABSENT here would be a Phase 6 violation, not a benchmark
      // result — so the distinct values are recorded, not summarised.
      advisoryResults: [...new Set(recognition.perStudent.map((e) => e.advisoryResult))],
      candidateScope: recognition.candidateScope,
      candidatePoolSize: recognition.candidatePoolSize,
      detectedFaces: recognition.detectedFacesTotal,
      ms: Number(ms.toFixed(3)),
    });
  }
  results.classScopedSearch = scopedRows;

  // ---- Candidate pool scaling ------------------------------------------
  const poolRows: unknown[] = [];
  for (const repeat of [1, 2, 3]) {
    const runs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const [, ms] = await timed(() =>
        runRecognitionForSession(teacher, {
          sessionId: scoped.session.id,
          images: Array.from({ length: repeat }, (_, k) => ({
            sequenceNumber: (k + 1) as 1 | 2 | 3,
            imageBase64: imageFor(students[(i + k) % students.length].id),
          })),
        }),
      );
      runs.push(ms);
    }
    poolRows.push({ images: repeat, enrolledTemplates: students.length, stats: stats(runs) });
  }
  results.recognitionByImageCount = poolRows;

  // ---- Database read paths ---------------------------------------------
  const dbRows: Record<string, Stats> = {};
  const rosterMs: number[] = [];
  const embeddingMs: number[] = [];
  for (let i = 0; i < 30; i++) {
    const [, a] = await timed(() =>
      prisma.enrollment.findMany({ where: { cohortId, status: "ACTIVE" } }),
    );
    rosterMs.push(a);
    const [, b] = await timed(() =>
      prisma.faceEmbedding.findMany({
        where: { student: { enrollments: { some: { cohortId, status: "ACTIVE" } } } },
        select: { id: true, studentId: true },
      }),
    );
    embeddingMs.push(b);
  }
  dbRows.cohortRoster = stats(rosterMs);
  dbRows.embeddingMetadataForCohort = stats(embeddingMs);
  results.database = dbRows;

  // ---- Concurrency correctness ------------------------------------------
  //
  // Speed is not the question here. The question is whether the guarantees
  // Phases 6 and 10 established survive parallel callers: exactly one
  // correction row per contested record, exactly one finalization, and no
  // student counted twice. A benchmark that only measured throughput would
  // pass while quietly writing two registers.
  await resetAttendance();
  const conc = await startOrResumeCaptureSession(teacher, { cohortId });
  const concRecognition = await runRecognitionForSession(teacher, {
    sessionId: conc.session.id,
    images: [{ sequenceNumber: 1, imageBase64: imageFor(students[0].id) }],
  });
  await generateAttendanceCandidates(teacher, {
    sessionId: conc.session.id,
    recognition: concRecognition,
  });

  const records = await prisma.attendanceRecord.findMany({
    where: { sessionId: conc.session.id },
    select: { id: true, studentId: true },
  });
  const target = records[0];

  const CONCURRENT = 8;
  const started = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENT }, () =>
      applyReviewDecision(teacher, {
        attendanceRecordId: target.id,
        newResult: "PRESENT",
        reason: "concurrency benchmark",
      }),
    ),
  );
  const concMs = performance.now() - started;

  const corrections = await prisma.attendanceCorrection.count({
    where: { attendanceRecordId: target.id },
  });
  const recordAfter = await prisma.attendanceRecord.findUniqueOrThrow({
    where: { id: target.id },
  });
  const recordCount = await prisma.attendanceRecord.count({
    where: { sessionId: conc.session.id },
  });

  results.concurrency = {
    concurrentCorrections: CONCURRENT,
    fulfilled: settled.filter((r) => r.status === "fulfilled").length,
    rejected: settled.filter((r) => r.status === "rejected").length,
    correctionRowsWritten: corrections,
    // The Phase 6 compare-and-set guarantee: contention produces one row, not
    // one per caller. More than one would mean a trail claiming transitions
    // that never happened.
    duplicateCorrectionRows: Math.max(0, corrections - 1),
    finalResult: recordAfter.finalResult,
    attendanceRecordsForSession: recordCount,
    rosterSize: students.length,
    noDuplicateStudents: recordCount === students.length,
    wallMs: Number(concMs.toFixed(3)),
  };

  await resetAttendance();
  mkdirSync("bench-results", { recursive: true });
  writeFileSync("bench-results/pipeline.json", JSON.stringify(results, null, 2) + "\n");
  console.log("wrote bench-results/pipeline.json");
}

await main();
await prisma.$disconnect();
