import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReviewDecision,
  confirmAttendance,
  countAttendance,
  decideCandidate,
  generateAttendanceCandidates,
  getAttendanceReviewBoard,
  resolveSessionRoster,
} from "./service.ts";
import type { AttendanceReviewDeps } from "./service.ts";
import type { AttendanceRecordRow, SessionDetailRow } from "./repository.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { AttendanceRecord } from "../attendance/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { AttendanceRealtimeEvent } from "../realtime/types.ts";
import type { RecognitionRunSummary, StudentRecognitionAggregate } from "../recognition-engine/types.ts";
import type { AttendanceSession, SessionStatus } from "../sessions/types.ts";
import type { WebhookEventEnvelope } from "../integrations/types.ts";
import type { AttendanceRosterStudent } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_PERMISSIONS = [
  "cohort.read",
  "student.read",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
];

function makeUser(
  overrides: { permissions?: string[]; userId?: string; institutionId?: string } = {},
): SessionUser {
  return {
    userId: overrides.userId ?? "user-faculty",
    email: "faculty@example.com",
    name: "Dr. Faculty",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: null,
    roles: [
      {
        key: "FACULTY",
        name: "Faculty",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: (overrides.permissions ??
          ALL_PERMISSIONS) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function makeSession(status: SessionStatus = "CAPTURING"): AttendanceSession {
  return {
    id: "sess-1",
    institutionId: "inst-A",
    cohortId: "coh-1",
    cohortSubjectId: null,
    facultyId: "user-faculty",
    // A real row always has these; the fixture omitted them while nothing read
    // them. The webhook payloads do, and a cast that hides a missing column is
    // how a green test suite ships a TypeError.
    sessionDate: new Date("2026-09-15T00:00:00Z"),
    startedAt: new Date("2026-09-15T09:00:00Z"),
    endedAt: null,
    status,
  } as unknown as AttendanceSession;
}

/** A class of `n` students, coded S001…S0nn. */
function roster(n: number): AttendanceRosterStudent[] {
  return Array.from({ length: n }, (_, i) => {
    const num = String(i + 1).padStart(3, "0");
    return {
      studentId: `stu-${num}`,
      studentCode: `S${num}`,
      firstName: `Student${num}`,
      lastName: `Class${num}`,
    };
  });
}

function aggregate(
  studentId: string,
  advisoryResult: "PRESENT" | "NEEDS_REVIEW" | "ABSENT",
  bestSimilarity: number | null,
  wasAmbiguous = false,
): StudentRecognitionAggregate {
  return {
    studentId,
    bestSimilarity,
    bestDetectionConfidence: 0.99,
    bestQualityScore: 0.8,
    bestFaceId: "1:0",
    bestEmbeddingId: `emb-${studentId}`,
    advisoryResult,
    matchStatus: advisoryResult === "PRESENT" ? "MATCHED" : advisoryResult === "ABSENT" ? "UNMATCHED" : "UNCERTAIN",
    wasAmbiguous,
    downgrades: wasAmbiguous ? ["ambiguous_face"] : [],
    observations: [
      {
        captureNumber: 1,
        faceIndex: 0,
        detectedFaceId: "1:0",
        similarity: bestSimilarity ?? 0,
        detectionConfidence: 0.99,
        qualityScore: 0.8,
        matchStatus:
          advisoryResult === "PRESENT"
            ? "MATCHED"
            : advisoryResult === "ABSENT"
              ? "UNMATCHED"
              : "UNCERTAIN",
        wasAmbiguous,
        candidateEmbeddingId: `emb-${studentId}`,
      },
    ],
  } as StudentRecognitionAggregate;
}

function runSummary(perStudent: StudentRecognitionAggregate[]): RecognitionRunSummary {
  return {
    sessionId: "sess-1",
    cohortId: "coh-1",
    candidateScope: "cohort",
    candidatePoolSize: perStudent.length,
    skippedIncompatibleCandidates: 0,
    detectedFacesTotal: perStudent.length,
    scoredFacesTotal: perStudent.length,
    modelName: "stub",
    modelVersion: "0.0.1",
    productionEligible: false,
    completedAt: "2026-09-20T09:00:00.000Z",
    durationMs: 42,
    policy: {
      presentMin: 0.62,
      reviewMin: 0.45,
      ambiguityMargin: 0.05,
      minDetectionConfidence: 0.5,
    },
    perFace: [
      { imageSequenceNumber: 1, qualityScore: 0.8 },
      { imageSequenceNumber: 1, qualityScore: 0.6 },
      { imageSequenceNumber: 2, qualityScore: 0.9 },
    ] as RecognitionRunSummary["perFace"],
    perStudent,
    unmatchedStudentIds: [],
    rejectedFaces: {},
    flaggedFaces: {},
    unknownFacesTotal: 0,
    recommendRetake: false,
  };
}

/**
 * An in-memory attendance register that behaves like the real one: rows are
 * keyed by (sessionId, studentId), corrections append, and `aiResult` is
 * never overwritten by a correction.
 */
function makeStore(students: AttendanceRosterStudent[], sessionStatus: SessionStatus = "CAPTURING") {
  const rows = new Map<string, AttendanceRecordRow>();
  const corrections: Array<{
    attendanceRecordId: string;
    previousResult: string;
    newResult: string;
    changedByUserId: string;
    source: string;
    reason?: string;
  }> = [];
  const transitions: Array<[SessionStatus, SessionStatus]> = [];
  const events: AttendanceRealtimeEvent[] = [];
  const studentEvents: Array<{ studentId: string; event: AttendanceRealtimeEvent }> = [];
  // Captured rather than left to the default, which is the real dispatcher: an
  // un-injected emit sends every unit test at the webhook_endpoint table and
  // logs a DATABASE_URL failure per assertion. Capturing keeps the suite
  // offline and makes the outbound contract assertable.
  const webhooks: WebhookEventEnvelope[] = [];
  let metadata: Record<string, unknown> = {};
  let status = sessionStatus;
  let finalizedCalls = 0;

  const deps: AttendanceReviewDeps = {
    getSessionById: async () => ({ ...makeSession(status) }),
    getSessionDetailRow: async () =>
      ({
        id: "sess-1",
        institutionId: "inst-A",
        cohortId: "coh-1",
        cohortSubjectId: null,
        facultyId: "user-faculty",
        sessionDate: new Date("2026-09-15T00:00:00Z"),
        startedAt: new Date("2026-09-15T09:00:00Z"),
        endedAt: null,
        status,
        metadata,
        faculty: { name: "Dr. Faculty" },
        cohort: {
          name: "Grade 10-A",
          termLabel: null,
          academicSessionId: "as-1",
          academicSession: { name: "2026-27" },
        },
        cohortSubject: null,
      }) as SessionDetailRow,
    getInstitutionById: async () =>
      ({ id: "inst-A", name: "Test School", type: "SCHOOL", settings: {} }) as unknown as Institution,
    getUserNameById: async () => "Dr. Faculty",
    requireCohortAccess: async () => {},
    listCohortRoster: async () => students,
    listCohortSubjectRoster: async () => [],
    listComparableTemplates: async (ids) => ids,
    listAnyTemplates: async (ids) => ids,
    listAttendanceRecords: async () => Array.from(rows.values()),
    upsertCandidates: async (incoming) => {
      let created = 0;
      let refreshed = 0;
      for (const row of incoming) {
        const existing = rows.get(row.studentId);
        if (!existing) {
          rows.set(row.studentId, {
            id: `rec-${row.studentId}`,
            sessionId: row.sessionId,
            studentId: row.studentId,
            aiResult: row.aiResult,
            aiConfidence: row.aiConfidence,
            finalResult: row.finalResult,
            isManuallyCorrected: false,
          });
          created++;
        } else if (!existing.isManuallyCorrected) {
          existing.aiResult = row.aiResult;
          existing.aiConfidence = row.aiConfidence;
          existing.finalResult = row.finalResult;
          refreshed++;
        }
      }
      return { created, refreshed };
    },
    mergeSessionMetadata: async (_id, patch) => {
      metadata = { ...metadata, ...patch };
    },
    transitionSessionStatus: async (_id, from, to) => {
      if (status !== from) throw new Error("session_status_conflict");
      transitions.push([from, to]);
      status = to;
      return { ...makeSession(status) };
    },
    getAttendanceRecordById: async (id) => {
      const row = Array.from(rows.values()).find((r) => r.id === id);
      return row ? ({ ...row, institutionId: "inst-A" } as unknown as AttendanceRecord) : null;
    },
    correctAttendanceRecord: async (input) => {
      const row = Array.from(rows.values()).find((r) => r.id === input.attendanceRecordId);
      if (!row) throw new Error("not_found");
      // Mirrors the real compare-and-set: a guarded write that no longer
      // matches is a no-op, not a second entry for one decision.
      if (input.onlyIfCurrentResultIn && !input.onlyIfCurrentResultIn.includes(row.finalResult)) {
        return { ...row, institutionId: "inst-A" } as unknown as AttendanceRecord;
      }
      corrections.push({
        attendanceRecordId: row.id,
        previousResult: row.finalResult,
        newResult: input.newResult,
        changedByUserId: input.changedByUserId,
        source: input.source,
        reason: input.reason,
      });
      // The storage primitive touches finalResult only — aiResult survives.
      row.finalResult = input.newResult;
      row.isManuallyCorrected = true;
      return { ...row, institutionId: "inst-A" } as unknown as AttendanceRecord;
    },
    finalizeAttendanceSession: async (_actor, _id, finalizeDeps) => {
      finalizedCalls++;
      const records = await (finalizeDeps?.listAttendanceRecords?.("sess-1") ??
        Promise.resolve(Array.from(rows.values())));
      if (records.length === 0) throw new Error("no_attendance_records");
      const unresolved = records.filter(
        (r) => r.finalResult === "NEEDS_REVIEW" || r.finalResult === "NOT_EVALUATED",
      ).length;
      if (unresolved > 0) throw new Error(`unresolved_review_states:${unresolved}`);
      status = "FINALIZED";
      return { ...makeSession(status) };
    },
    recordAuditLog: async () => {},
    publisher: {
      publish: (event) => events.push(event),
      subscribe: () => () => {},
      publishToStudent: (studentId, event) => studentEvents.push({ studentId, event }),
      subscribeToStudent: () => () => {},
    },
    emitWebhook: (envelope) => webhooks.push(envelope),
    now: () => new Date("2026-09-15T10:00:00Z"),
  };

  return {
    deps,
    rows,
    corrections,
    transitions,
    events,
    studentEvents,
    webhooks,
    get status() {
      return status;
    },
    get finalizedCalls() {
      return finalizedCalls;
    },
    get metadata() {
      return metadata;
    },
    recordIdFor: (studentId: string) => `rec-${studentId}`,
    rowFor: (studentId: string) => {
      const row = rows.get(studentId);
      if (!row) throw new Error(`no register row for ${studentId}`);
      return row;
    },
  };
}

/**
 * Resolve every row that blocks confirmation.
 *
 * In the scenario fixture that is the 5 unmatched plus the 2 uncertain —
 * indices 43-49. The 43 suggested-present rows are deliberately left alone,
 * because confirming the register is what accepts those.
 */
async function resolveBlockers(
  store: ReturnType<typeof makeStore>,
  students: AttendanceRosterStudent[],
) {
  for (const index of [43, 44, 45, 46, 47, 48, 49]) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(students[index].studentId), newResult: "ABSENT" },
      store.deps,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure decision table
// ---------------------------------------------------------------------------

test("a student we could not compare is never marked absent", () => {
  const noTemplate = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: false,
    hasAnyTemplate: false,
  });
  assert.equal(noTemplate.finalResult, "NEEDS_REVIEW");
  assert.equal(noTemplate.aiResult, "NOT_EVALUATED");
  assert.equal(noTemplate.note.reason, "no_face_template");

  // A template exists but under a superseded model build — the reviewer is
  // told which of the two situations they are in.
  const stale = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: false,
    hasAnyTemplate: true,
  });
  assert.equal(stale.finalResult, "NEEDS_REVIEW");
  assert.equal(stale.note.reason, "incompatible_face_template");
});

test("uncertainty is never promoted to present", () => {
  const uncertain = decideCandidate({
    aggregate: aggregate("stu-001", "NEEDS_REVIEW", 0.55, true),
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(uncertain.aiResult, "NEEDS_REVIEW");
  assert.equal(uncertain.finalResult, "NEEDS_REVIEW");
  assert.equal(uncertain.note.reason, "ambiguous_match");
});

test("a compared student with no match is NOT marked absent — only a person may do that", () => {
  // This used to write finalResult ABSENT and was the single place the system
  // asserted absence on its own evidence. Failing to find somebody has many
  // causes that are not the student being elsewhere: hidden behind a
  // classmate, turned away, at the back of a dark room, outside the frame.
  const unmatched = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(unmatched.aiResult, "ABSENT", "the evidence is still recorded honestly");
  assert.equal(unmatched.finalResult, "NEEDS_REVIEW", "but the register waits for a human");
  assert.equal(unmatched.note.reason, "no_match");
  assert.equal(unmatched.note.aiSuggestion, null);
  assert.equal(unmatched.note.wasComparable, true);
});

test("a confident match is a suggestion, not a decision", () => {
  const matched = decideCandidate({
    aggregate: {
      advisoryResult: "PRESENT",
      bestSimilarity: 0.91,
      wasAmbiguous: false,
      bestFaceId: "1:0",
      bestEmbeddingId: "emb-1",
    },
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(matched.aiResult, "PRESENT");
  assert.equal(matched.aiConfidence, 0.91);
  assert.equal(matched.note.aiSuggestion, "PRESENT");
  assert.equal(
    matched.finalResult,
    "NEEDS_REVIEW",
    "the register records it as unresolved until somebody confirms",
  );
});

test("no branch of the decision table can write a final PRESENT or ABSENT", () => {
  // The structural guarantee, asserted over every reachable combination rather
  // than one case at a time.
  const advisories = ["PRESENT", "NEEDS_REVIEW", "ABSENT", undefined] as const;
  for (const advisory of advisories) {
    for (const recognitionRan of [true, false]) {
      for (const hasComparable of [true, false]) {
        for (const noFaces of [true, false]) {
          const d = decideCandidate({
            aggregate: advisory
              ? {
                  advisoryResult: advisory,
                  bestSimilarity: 0.8,
                  wasAmbiguous: false,
                  bestFaceId: "1:0",
                }
              : undefined,
            recognitionRan,
            hasComparableTemplate: hasComparable,
            hasAnyTemplate: hasComparable,
            noFacesDetected: noFaces,
          });
          assert.equal(
            d.finalResult,
            "NEEDS_REVIEW",
            `advisory=${advisory} ran=${recognitionRan} comparable=${hasComparable} noFaces=${noFaces}`,
          );
        }
      }
    }
  }
});

test("a session where no face was detected says so, rather than reporting no match", () => {
  const d = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
    noFacesDetected: true,
  });
  assert.equal(d.note.reason, "no_face_detected");
  assert.equal(d.finalResult, "NEEDS_REVIEW");
});

test("a recognition error is distinguished from recognition never running", () => {
  const errored = decideCandidate({
    aggregate: undefined,
    recognitionRan: false,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
    recognitionErrored: true,
  });
  assert.equal(errored.note.reason, "recognition_error");

  const never = decideCandidate({
    aggregate: undefined,
    recognitionRan: false,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(never.note.reason, "recognition_unavailable");
});

test("when recognition did not run, nobody is presumed anything", () => {
  const d = decideCandidate({
    aggregate: undefined,
    recognitionRan: false,
    hasComparableTemplate: false,
    hasAnyTemplate: false,
  });
  assert.equal(d.aiResult, "NOT_EVALUATED");
  assert.equal(d.finalResult, "NEEDS_REVIEW");
  assert.equal(d.note.reason, "recognition_unavailable");
});

test("countAttendance partitions a register exactly", () => {
  const counts = countAttendance([
    { finalResult: "PRESENT" },
    { finalResult: "PRESENT" },
    { finalResult: "ABSENT" },
    { finalResult: "NEEDS_REVIEW" },
    { finalResult: "NOT_EVALUATED" },
  ]);
  assert.deepEqual(counts, {
    total: 5,
    present: 2,
    absent: 1,
    needsReview: 1,
    notEvaluated: 1,
  });
});

// ---------------------------------------------------------------------------
// Roster scoping
// ---------------------------------------------------------------------------

test("subject sessions use subject enrollment, falling back to the cohort", async () => {
  const subjectOnly = await resolveSessionRoster(
    { cohortId: "coh-1", cohortSubjectId: "cs-1" },
    {
      listCohortSubjectRoster: async () => roster(3),
      listCohortRoster: async () => roster(40),
    },
  );
  assert.equal(subjectOnly.scope, "cohortSubject");
  assert.equal(subjectOnly.students.length, 3);

  // A non-elective subject legitimately has no per-student enrollment rows;
  // that must not produce an empty register for a full classroom.
  const fallback = await resolveSessionRoster(
    { cohortId: "coh-1", cohortSubjectId: "cs-1" },
    {
      listCohortSubjectRoster: async () => [],
      listCohortRoster: async () => roster(40),
    },
  );
  assert.equal(fallback.scope, "cohort");
  assert.equal(fallback.students.length, 40);
});

// ---------------------------------------------------------------------------
// Candidate generation — "do not lose them"
// ---------------------------------------------------------------------------

test("every enrolled student gets a row, including those recognition never returned", async () => {
  const students = roster(50);
  const store = makeStore(students);
  // Recognition only reports on the 10 students it matched. The other 40 are
  // absent from its output entirely — they must NOT be absent from ours.
  const recognition = runSummary(
    students.slice(0, 10).map((s) => aggregate(s.studentId, "PRESENT", 0.9)),
  );

  const result = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition },
    store.deps,
  );

  assert.equal(result.counts.total, 50, "every enrolled student has a row");
  assert.equal(store.rows.size, 50);
  // Nobody is decided at generation, including the 40 the model never
  // returned. "Recognition did not mention you" is not a fact about you.
  assert.equal(result.counts.present, 0);
  assert.equal(result.counts.absent, 0);
  assert.equal(result.counts.needsReview, 50);
});

test("generation walks the session CAPTURING → PROCESSING → REVIEW", async () => {
  const store = makeStore(roster(3));
  await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: runSummary([]) },
    store.deps,
  );
  assert.deepEqual(store.transitions, [
    ["CAPTURING", "PROCESSING"],
    ["PROCESSING", "REVIEW"],
  ]);
  assert.equal(store.status, "REVIEW");
});

test("a student matched in two images counts once", async () => {
  const students = roster(2);
  const store = makeStore(students);
  // The engine deduplicates upstream (one aggregate per student); this
  // asserts the register agrees — one row per student, never two.
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary([aggregate("stu-001", "PRESENT", 0.91)]),
    },
    store.deps,
  );
  const rowsForStudent = Array.from(store.rows.values()).filter(
    (r) => r.studentId === "stu-001",
  );
  assert.equal(rowsForStudent.length, 1);
  assert.equal(store.rows.size, 2);
});

test("reprocessing refreshes untouched rows and preserves manual corrections", async () => {
  const students = roster(3);
  const store = makeStore(students);
  await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: runSummary([]) },
    store.deps,
  );
  // Faculty corrects student 1 to PRESENT, then the class is re-photographed.
  await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor("stu-001"), newResult: "PRESENT" },
    store.deps,
  );

  const second = await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary([aggregate("stu-002", "PRESENT", 0.88)]),
    },
    store.deps,
  );

  assert.equal(second.created, 0);
  // The human decision is untouched by reprocessing.
  assert.equal(store.rows.get("stu-001")!.finalResult, "PRESENT");
  assert.equal(store.rows.get("stu-001")!.isManuallyCorrected, true);
  // Everyone else stays unresolved — a second recognition run is more
  // evidence, not a decision.
  assert.equal(store.rows.get("stu-002")!.finalResult, "NEEDS_REVIEW");
  assert.equal(store.rows.get("stu-002")!.aiResult, "PRESENT", "refreshed advisory");
  assert.equal(store.rows.get("stu-003")!.finalResult, "NEEDS_REVIEW");
});

test("manual roll call puts the whole class in review and presumes nothing", async () => {
  const store = makeStore(roster(50));
  const result = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: null },
    store.deps,
  );
  assert.equal(result.generationSource, "manual");
  assert.equal(result.counts.needsReview, 50);
  assert.equal(result.counts.present, 0);
  assert.equal(result.counts.absent, 0);
});

test("generation refuses a finalized session", async () => {
  const store = makeStore(roster(3), "FINALIZED");
  await assert.rejects(
    () =>
      generateAttendanceCandidates(
        makeUser(),
        { sessionId: "sess-1", recognition: runSummary([]) },
        store.deps,
      ),
    /session_locked:FINALIZED/,
  );
});

// ---------------------------------------------------------------------------
// The Phase 6 scenario: 50 students, 43 recognized, 5 absent, 2 review
// ---------------------------------------------------------------------------

/** Builds the exact starting register the phase spec describes. */
async function seedScenario() {
  const students = roster(50);
  const store = makeStore(students);
  const recognition = runSummary([
    ...students.slice(0, 43).map((s) => aggregate(s.studentId, "PRESENT", 0.88)),
    // 44 and 45 are uncertain — a near-collision and a low score.
    aggregate(students[43].studentId, "NEEDS_REVIEW", 0.58, true),
    aggregate(students[44].studentId, "NEEDS_REVIEW", 0.51),
    // 46–50 were compared and matched nobody.
  ]);
  const result = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition },
    store.deps,
  );
  return { store, students, result };
}

test("scenario: generation decides nothing — all 50 rows are unresolved", async () => {
  // The Phase 6 invariant, at register scale. 43 confident matches, 5 that
  // matched nobody and 2 uncertain all land in the same place: waiting for a
  // person. The machine's findings are recorded, the register is not.
  const { result } = await seedScenario();
  assert.deepEqual(result.counts, {
    total: 50,
    present: 0,
    absent: 0,
    needsReview: 50,
    notEvaluated: 0,
  });
});

test("scenario: the board shows 43 as suggested-present and 7 as needing a decision", async () => {
  const { store } = await seedScenario();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);

  assert.equal(board.present.length, 43, "confident matches surface where a reviewer looks");
  assert.equal(board.absent.length, 0, "nothing is absent until somebody says so");
  assert.equal(board.needsReview.length, 7, "5 unmatched + 2 uncertain");
  assert.equal(board.awaitingConfirmation, 43);
  assert.equal(board.awaitingDecision, 7);

  // Every row in Present is still a suggestion, not a result.
  assert.ok(board.present.every((r) => r.finalResult === "NEEDS_REVIEW"));
  assert.ok(board.present.every((r) => r.aiSuggestion === "PRESENT"));
  // And nothing in Needs Review carries a suggestion.
  assert.ok(board.needsReview.every((r) => r.aiSuggestion === null));
});

test("scenario: only the un-suggested rows block confirmation", async () => {
  const { store } = await seedScenario();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.canFinalize, false);
  assert.match(board.finalizeBlockedReason ?? "", /7 students still need review/);
});

test("scenario: marking an unmatched student present moves exactly one row", async () => {
  const { store, students } = await seedScenario();
  // students[45] is one of the five the model matched to nobody.
  const decision = await applyReviewDecision(
    makeUser(),
    {
      attendanceRecordId: store.recordIdFor(students[45].studentId),
      newResult: "PRESENT",
      reason: "Was seated behind a pillar",
    },
    store.deps,
  );

  assert.equal(decision.counts.present, 1, "one faculty-owned PRESENT");
  assert.equal(decision.counts.absent, 0);
  assert.equal(decision.counts.needsReview, 49);
  // The four buckets still partition the class exactly.
  assert.equal(
    decision.counts.present +
      decision.counts.absent +
      decision.counts.needsReview +
      decision.counts.notEvaluated,
    50,
  );

  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.awaitingDecision, 6, "one fewer row blocking confirmation");
});

test("scenario: a review row can be resolved either way", async () => {
  const asPresent = await seedScenario();
  const presentBranch = await applyReviewDecision(
    makeUser(),
    {
      attendanceRecordId: asPresent.store.recordIdFor(asPresent.students[43].studentId),
      newResult: "PRESENT",
    },
    asPresent.store.deps,
  );
  assert.equal(presentBranch.counts.present, 1);
  assert.equal(presentBranch.counts.absent, 0);

  const asAbsent = await seedScenario();
  const absentBranch = await applyReviewDecision(
    makeUser(),
    {
      attendanceRecordId: asAbsent.store.recordIdFor(asAbsent.students[43].studentId),
      newResult: "ABSENT",
    },
    asAbsent.store.deps,
  );
  assert.equal(absentBranch.counts.absent, 1, "the only route to ABSENT is this one");
  assert.equal(absentBranch.counts.present, 0);
});

test("scenario: the register cannot be confirmed while an undecided row remains", async () => {
  const { store, students } = await seedScenario();
  // Resolve six of the seven.
  for (const index of [43, 44, 45, 46, 47, 48]) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(students[index].studentId), newResult: "ABSENT" },
      store.deps,
    );
  }

  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.canFinalize, false);
  assert.match(board.finalizeBlockedReason ?? "", /1 student still needs review/);

  await assert.rejects(() => confirmAttendance(makeUser(), "sess-1", store.deps), /unresolved/);
  assert.notEqual(store.status, "FINALIZED");
});

test("scenario: confirming accepts every suggestion and records who accepted it", async () => {
  const { store, students } = await seedScenario();
  for (const index of [43, 44, 45, 46, 47, 48, 49]) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(students[index].studentId), newResult: "ABSENT" },
      store.deps,
    );
  }

  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.canFinalize, true);
  assert.equal(board.awaitingConfirmation, 43, "the suggestions are still unconfirmed");

  const correctionsBefore = store.corrections.length;
  const confirmed = await confirmAttendance(makeUser(), "sess-1", store.deps);

  assert.equal(store.status, "FINALIZED");
  assert.equal(confirmed.counts.present, 43, "every suggestion became a real PRESENT");
  assert.equal(confirmed.counts.absent, 7);
  assert.equal(confirmed.counts.needsReview, 0);
  assert.equal(confirmed.finalizedByUserId, "user-faculty");

  // Each accepted suggestion is a recorded faculty decision, not a bulk flip:
  // "who decided this student was present?" has an answer for all 43.
  assert.equal(
    store.corrections.length - correctionsBefore,
    43,
    "one correction row per confirmed suggestion",
  );
  const confirmations = store.corrections.slice(correctionsBefore);
  assert.ok(confirmations.every((c) => c.changedByUserId === "user-faculty"));
  assert.ok(confirmations.every((c) => c.newResult === "PRESENT"));
  assert.ok(confirmations.every((c) => c.previousResult === "NEEDS_REVIEW"));

  const finalizedEvent = store.events.find((e) => e.type === "attendance-session-finalized");
  assert.ok(finalizedEvent, "session channel received the finalization");
});

test("scenario: confirming never overrides a decision a person already made", async () => {
  // A student the model matched, whom the teacher then marked absent, must
  // stay absent when the register is confirmed.
  const { store, students } = await seedScenario();
  const matched = students[0].studentId;
  await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor(matched), newResult: "ABSENT", reason: "Left early" },
    store.deps,
  );
  for (const index of [43, 44, 45, 46, 47, 48, 49]) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(students[index].studentId), newResult: "ABSENT" },
      store.deps,
    );
  }

  await confirmAttendance(makeUser(), "sess-1", store.deps);

  const row = store.rowFor(matched);
  assert.equal(row.finalResult, "ABSENT", "the human decision survived confirmation");
  assert.equal(row.aiResult, "PRESENT", "and the machine's finding survived too");
  assert.equal(row.isManuallyCorrected, true);
});

test("a correction preserves the original AI result and appends an audit row", async () => {
  const { store, students } = await seedScenario();
  const target = students[45].studentId;
  assert.equal(store.rows.get(target)!.aiResult, "ABSENT");

  await applyReviewDecision(
    makeUser(),
    {
      attendanceRecordId: store.recordIdFor(target),
      newResult: "PRESENT",
      reason: "Late arrival",
    },
    store.deps,
  );

  const row = store.rows.get(target)!;
  assert.equal(row.finalResult, "PRESENT");
  // The machine's claim survives the human's disagreement.
  assert.equal(row.aiResult, "ABSENT");
  assert.equal(row.isManuallyCorrected, true);

  assert.equal(store.corrections.length, 1);
  assert.deepEqual(store.corrections[0], {
    attendanceRecordId: `rec-${target}`,
    previousResult: "NEEDS_REVIEW",
    newResult: "PRESENT",
    changedByUserId: "user-faculty",
    source: "FACULTY_REVIEW",
    reason: "Late arrival",
  });
});

test("re-asserting the same result writes no correction row", async () => {
  const { store, students } = await seedScenario();
  const target = students[0].studentId;
  // Confirm once, so the row genuinely holds PRESENT.
  await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor(target), newResult: "PRESENT" },
    store.deps,
  );
  const before = store.corrections.length;

  // Asserting the same result again is a non-event and must not pollute the
  // audit trail with one.
  const result = await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor(target), newResult: "PRESENT" },
    store.deps,
  );
  assert.equal(result.record.finalResult, "PRESENT");
  assert.equal(store.corrections.length, before);
});

test("a correction publishes to the session board and to the student alone", async () => {
  const { store, students } = await seedScenario();
  const target = students[45].studentId;
  await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor(target), newResult: "PRESENT" },
    store.deps,
  );

  const boardEvent = store.events.find((e) => e.type === "attendance-record-updated");
  assert.ok(boardEvent);
  assert.equal(boardEvent.type === "attendance-record-updated" && boardEvent.counts.present, 1);

  assert.equal(store.studentEvents.length, 1);
  assert.equal(store.studentEvents[0].studentId, target);
});

test("correcting requires attendanceRecord.correct", async () => {
  const { store, students } = await seedScenario();
  const readOnly = makeUser({ permissions: ["attendanceRecord.read", "cohort.read"] });
  await assert.rejects(
    () =>
      applyReviewDecision(
        readOnly,
        { attendanceRecordId: store.recordIdFor(students[45].studentId), newResult: "PRESENT" },
        store.deps,
      ),
    ForbiddenError,
  );
  assert.equal(store.corrections.length, 0);
});

test("after finalization only a finalizer may correct, and it is an override", async () => {
  const { store, students } = await seedScenario();
  await resolveBlockers(store, students);
  await confirmAttendance(makeUser(), "sess-1", store.deps);
  const correctionsBefore = store.corrections.length;

  // A faculty member without finalize rights (e.g. an operator-like role)
  // cannot reopen a closed register.
  const noFinalize = makeUser({
    permissions: ["attendanceRecord.correct", "attendanceRecord.read", "cohort.read"],
  });
  await assert.rejects(
    () =>
      applyReviewDecision(
        noFinalize,
        { attendanceRecordId: store.recordIdFor(students[0].studentId), newResult: "ABSENT" },
        store.deps,
      ),
    ForbiddenError,
  );
  assert.equal(store.corrections.length, correctionsBefore);

  // Whoever may close the register may reopen a line in it — recorded as an
  // ADMIN_OVERRIDE rather than routine review.
  await applyReviewDecision(
    makeUser(),
    {
      attendanceRecordId: store.recordIdFor(students[0].studentId),
      newResult: "ABSENT",
      reason: "Recorded in error",
    },
    store.deps,
  );
  const latest = store.corrections.at(-1)!;
  assert.equal(latest.source, "ADMIN_OVERRIDE");
  assert.equal(latest.previousResult, "PRESENT");
});

test("a cancelled session accepts no corrections", async () => {
  const store = makeStore(roster(3), "CAPTURING");
  await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: runSummary([]) },
    store.deps,
  );
  const cancelled: AttendanceReviewDeps = {
    ...store.deps,
    getSessionById: async () => makeSession("CANCELLED"),
  };
  await assert.rejects(
    () =>
      applyReviewDecision(
        makeUser(),
        { attendanceRecordId: store.recordIdFor("stu-001"), newResult: "PRESENT" },
        cancelled,
      ),
    /session_cancelled/,
  );
});

// ---------------------------------------------------------------------------
// Review board shape
// ---------------------------------------------------------------------------

test("the board explains why each reviewed student is there", async () => {
  const { store, students } = await seedScenario();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);

  // 43 suggested-present, and the 7 rows the model could not settle. Nothing
  // is absent, because nobody has said so.
  assert.equal(board.present.length, 43);
  assert.equal(board.absent.length, 0);
  assert.equal(board.needsReview.length, 7);

  const ambiguous = board.needsReview.find((s) => s.studentId === students[43].studentId)!;
  assert.equal(ambiguous.reason, "ambiguous_match");
  assert.equal(ambiguous.wasAmbiguous, true);
  assert.equal(ambiguous.aiConfidence, 0.58);
  // Candidate information the reviewer needs to jump to the frame.
  assert.equal(ambiguous.bestFaceId, "1:0");

  const lowConfidence = board.needsReview.find((s) => s.studentId === students[44].studentId)!;
  assert.equal(lowConfidence.reason, "low_confidence");

  // Every row carries the identity fields the lists render.
  for (const row of [...board.present, ...board.absent, ...board.needsReview]) {
    assert.ok(row.studentCode.startsWith("S"));
    assert.equal(row.initials.length, 2);
    assert.equal(row.photoUrl, null);
  }
});

test("the board reports finalization state and who closed the register", async () => {
  const { store, students } = await seedScenario();
  await resolveBlockers(store, students);
  await confirmAttendance(makeUser(), "sess-1", store.deps);

  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.session.processingStatus, "FINALIZED");
  assert.equal(board.session.finalizedByUserId, "user-faculty");
  assert.equal(board.session.finalizedAt, "2026-09-15T10:00:00.000Z");
  assert.equal(board.session.finalizedByName, "Dr. Faculty");
  assert.equal(board.canFinalize, false);
  assert.match(board.finalizeBlockedReason ?? "", /already been finalized/);
});

test("the board records capture-image and model provenance", async () => {
  const { store } = await seedScenario();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.session.generationSource, "recognition");
  assert.equal(board.session.rosterScope, "cohort");
  assert.deepEqual(board.session.captureImages, [
    { sequenceNumber: 1, facesDetected: 2, qualityScore: 0.7 },
    { sequenceNumber: 2, facesDetected: 1, qualityScore: 0.9 },
  ]);
  assert.equal(board.session.recognition?.productionEligible, false);
  assert.equal(board.session.recognition?.presentMin, 0.62);
});

test("cross-institution access to a review board is denied", async () => {
  const { store } = await seedScenario();
  const outsider = makeUser({ institutionId: "inst-B" });
  await assert.rejects(
    () => getAttendanceReviewBoard(outsider, "sess-1", store.deps),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// Outbound webhooks
// ---------------------------------------------------------------------------

test("generation, correction and finalization each emit exactly one event", async () => {
  const { store, students } = await seedScenario();

  // One event for the whole generation, not one per student: a receiver wants
  // "this register now exists", and 50 deliveries for one classroom would put
  // a school's ERP behind a retry queue every period.
  const created = store.webhooks.filter((e) => e.type === "attendance.created");
  assert.equal(created.length, 1);
  assert.equal((created[0].data as { sessionStatus: string }).sessionStatus, "REVIEW");
  assert.equal((created[0].data as { sessionId: string }).sessionId, "sess-1");
  assert.equal(created[0].institutionId, "inst-A");

  await applyReviewDecision(
    makeUser(),
    {
      attendanceRecordId: store.recordIdFor(students[44].studentId),
      newResult: "ABSENT",
      reason: "Not in the room",
    },
    store.deps,
  );

  const corrected = store.webhooks.filter((e) => e.type === "attendance.corrected");
  assert.equal(corrected.length, 1);
  const correction = corrected[0].data as Record<string, unknown>;
  assert.equal(correction.studentId, students[44].studentId);
  assert.equal(correction.previousResult, "NEEDS_REVIEW");
  assert.equal(correction.result, "ABSENT");
  assert.equal(correction.correctedByUserId, "user-faculty");
  assert.equal(correction.afterFinalization, false);
  assert.equal(correction.reason, "Not in the room");
  // The more specific event only — an endpoint subscribed to both corrected
  // and updated must not receive the same change twice.
  assert.equal(store.webhooks.filter((e) => e.type === "attendance.updated").length, 0);

  // students[44] is already decided above; clear the rest of the blockers.
  for (const index of [43, 45, 46, 47, 48, 49]) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(students[index].studentId), newResult: "PRESENT" },
      store.deps,
    );
  }
  await confirmAttendance(makeUser(), "sess-1", store.deps);

  const finalized = store.webhooks.filter((e) => e.type === "attendance.finalized");
  assert.equal(finalized.length, 1);
  const payload = finalized[0].data as {
    counts: { present: number; absent: number; needsReview: number };
    records: Array<{ studentId: string; result: string }>;
    finalizedByUserId: string;
  };
  assert.equal(payload.finalizedByUserId, "user-faculty");
  assert.equal(payload.counts.needsReview, 0);
  assert.equal(payload.counts.present + payload.counts.absent, 50);
  assert.equal(payload.records.length, 50);
});

test("no outbound payload carries an AI confidence, AI result or image", async () => {
  const { store, students } = await seedScenario();
  await resolveBlockers(store, students);
  await confirmAttendance(makeUser(), "sess-1", store.deps);

  assert.equal(store.webhooks.length >= 3, true);
  // Serialized, so a field nested anywhere in any payload is caught — the
  // model's guess and a classroom photo are the two things that must never
  // leave this system over a webhook.
  const wire = JSON.stringify(store.webhooks);
  for (const forbidden of [
    "aiResult",
    "aiConfidence",
    "matchedEmbeddingId",
    "embedding",
    "imageUrl",
    "storageKey",
  ]) {
    assert.equal(wire.includes(forbidden), false, `${forbidden} leaked into a webhook payload`);
  }
});
