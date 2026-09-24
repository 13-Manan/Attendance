import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReviewDecision,
  confirmAttendance,
  decideCandidate,
  generateAttendanceCandidates,
  getAttendanceReviewBoard,
  mergeRoundDecision,
} from "./service.ts";
import type { AttendanceReviewDeps } from "./service.ts";
import type { AttendanceRecordRow, SessionDetailRow } from "./repository.ts";
import { canTransitionSessionStatus } from "../sessions/service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { AttendanceRecord } from "../attendance/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { RecognitionRunSummary } from "../recognition-engine/types.ts";
import type { AttendanceSession, SessionStatus } from "../sessions/types.ts";
import type { AttendanceRosterStudent } from "./types.ts";

/**
 * The Phase 6 attendance engine: the rules that decide what a register says,
 * and who is allowed to say it.
 *
 * The invariant every test here circles is one sentence: **the machine
 * produces evidence, a person produces attendance.** Everything else —
 * the state machine, the authorization matrix, the idempotency guards — exists
 * to keep that true when a real classroom is pressing buttons.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FACULTY_PERMISSIONS = [
  "cohort.read",
  "student.read",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
];

/** A student-portal account: reads its own attendance and nothing else. */
const STUDENT_PERMISSIONS = ["attendanceRecord.read.own"];

/** An operator who may record attendance but not close a register. */
const OPERATOR_PERMISSIONS = [
  "attendanceRecord.read",
  "attendanceRecord.correct",
  "attendanceSession.capture",
];

function makeUser(
  overrides: { permissions?: string[]; userId?: string; institutionId?: string; key?: string } = {},
): SessionUser {
  return {
    userId: overrides.userId ?? "user-faculty",
    email: "user@example.com",
    name: "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: null,
    roles: [
      {
        key: overrides.key ?? "FACULTY",
        name: overrides.key ?? "Faculty",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: (overrides.permissions ??
          FACULTY_PERMISSIONS) as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

function makeSession(
  status: SessionStatus = "CAPTURING",
  overrides: Partial<AttendanceSession> = {},
): AttendanceSession {
  return {
    id: "sess-1",
    institutionId: "inst-A",
    cohortId: "coh-1",
    cohortSubjectId: null,
    facultyId: "user-faculty",
    sessionDate: new Date("2026-09-15T00:00:00Z"),
    startedAt: new Date("2026-09-15T09:00:00Z"),
    endedAt: null,
    status,
    ...overrides,
  } as unknown as AttendanceSession;
}

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

function runSummary(overrides: Partial<RecognitionRunSummary> = {}): RecognitionRunSummary {
  return {
    sessionId: "sess-1",
    cohortId: "coh-1",
    candidateScope: "cohort",
    candidatePoolSize: 1,
    skippedIncompatibleCandidates: 0,
    detectedFacesTotal: 1,
    scoredFacesTotal: 1,
    modelName: "stub",
    modelVersion: "0.0.1",
    productionEligible: false,
    completedAt: "2026-09-20T09:00:00.000Z",
    durationMs: 10,
    policy: { presentMin: 0.62, reviewMin: 0.45, ambiguityMargin: 0.05, minDetectionConfidence: 0.5 },
    perFace: [],
    perStudent: [],
    unmatchedStudentIds: [],
    rejectedFaces: {},
    flaggedFaces: {},
    unknownFacesTotal: 0,
    recommendRetake: false,
    ...overrides,
  };
}

function suggestion(studentId: string, similarity = 0.9) {
  return {
    studentId,
    bestSimilarity: similarity,
    bestDetectionConfidence: 0.95,
    bestQualityScore: 0.8,
    bestFaceId: "1:0",
    bestEmbeddingId: `emb-${studentId}`,
    advisoryResult: "PRESENT" as const,
    matchStatus: "MATCHED" as const,
    wasAmbiguous: false,
    downgrades: [],
    bestQualityFlags: [],
    observations: [],
  };
}

/** In-memory register with the real row semantics. */
function makeStore(
  students: AttendanceRosterStudent[],
  sessionStatus: SessionStatus = "CAPTURING",
  sessionOverrides: Partial<AttendanceSession> = {},
) {
  const rows = new Map<string, AttendanceRecordRow>();
  const corrections: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let metadata: Record<string, unknown> = {};
  let status = sessionStatus;
  let finalizeCalls = 0;

  const deps: AttendanceReviewDeps = {
    getSessionById: async () => makeSession(status, sessionOverrides),
    getSessionDetailRow: async () =>
      ({
        id: "sess-1",
        institutionId: "inst-A",
        cohortId: "coh-1",
        cohortSubjectId: sessionOverrides.cohortSubjectId ?? null,
        facultyId: "user-faculty",
        sessionDate: new Date("2026-09-15T00:00:00Z"),
        startedAt: new Date("2026-09-15T09:00:00Z"),
        endedAt: null,
        status,
        metadata,
        faculty: { name: "Test User" },
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
    getUserNameById: async () => "Test User",
    requireCohortAccess: async () => {},
    requireCohortSubjectAccess: async () => {},
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
      status = to;
      return makeSession(status, sessionOverrides);
    },
    getAttendanceRecordById: async (id) => {
      const row = Array.from(rows.values()).find((r) => r.id === id);
      if (!row) return null;
      return { ...row, institutionId: "inst-A" } as unknown as AttendanceRecord;
    },
    correctAttendanceRecord: async (input) => {
      const row = Array.from(rows.values()).find((r) => r.id === input.attendanceRecordId)!;
      // Mirrors the real compare-and-set: a guarded write that no longer
      // matches is a no-op, not a second entry for one decision.
      if (input.onlyIfCurrentResultIn && !input.onlyIfCurrentResultIn.includes(row.finalResult)) {
        return { ...row, institutionId: "inst-A" } as unknown as AttendanceRecord;
      }
      corrections.push({
        attendanceRecordId: input.attendanceRecordId,
        previousResult: row.finalResult,
        newResult: input.newResult,
        changedByUserId: input.changedByUserId,
        source: input.source,
        reason: input.reason,
      });
      row.finalResult = input.newResult;
      row.isManuallyCorrected = true;
      return { ...row, institutionId: "inst-A" } as unknown as AttendanceRecord;
    },
    finalizeAttendanceSession: async (_actor, _id, finalizeDeps) => {
      finalizeCalls++;
      const records = await (finalizeDeps?.listAttendanceRecords?.("sess-1") ??
        Promise.resolve(Array.from(rows.values())));
      if (records.length === 0) throw new Error("no_attendance_records");
      if (status === "FINALIZED") throw new Error("invalid_transition:FINALIZED->FINALIZED");
      const unresolved = records.filter(
        (r) => r.finalResult === "NEEDS_REVIEW" || r.finalResult === "NOT_EVALUATED",
      ).length;
      if (unresolved > 0) throw new Error(`unresolved_review_states:${unresolved}`);
      status = "FINALIZED";
      return makeSession(status, sessionOverrides);
    },
    recordAuditLog: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    // The realtime channel is inert here: these tests are about what the
    // register decides, not who gets told. Subscribe is stubbed to a no-op
    // unsubscribe so the shape matches the real publisher.
    publisher: {
      publish: () => {},
      publishToStudent: () => {},
      subscribe: () => () => {},
      subscribeToStudent: () => () => {},
    },
    emitWebhook: () => {},
    now: () => new Date("2026-09-15T10:00:00Z"),
  };

  return {
    deps,
    rows,
    corrections,
    audits,
    get status() {
      return status;
    },
    get finalizeCalls() {
      return finalizeCalls;
    },
    get metadata() {
      return metadata;
    },
    recordIdFor: (studentId: string) => `rec-${studentId}`,
  };
}

/** Generate a register: 3 suggested present, 2 with nothing found. */
async function seed(sessionStatus: SessionStatus = "CAPTURING") {
  const students = roster(5);
  const store = makeStore(students, sessionStatus);
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({
        detectedFacesTotal: 3,
        perStudent: [suggestion("stu-001"), suggestion("stu-002"), suggestion("stu-003")],
      }),
    },
    store.deps,
  );
  return { store, students };
}

async function resolveBlockers(store: ReturnType<typeof makeStore>) {
  for (const id of ["stu-004", "stu-005"]) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(id), newResult: "ABSENT" },
      store.deps,
    );
  }
}

// ===========================================================================
// 1. Session state machine
// ===========================================================================

test("the lifecycle only advances one way", () => {
  assert.equal(canTransitionSessionStatus("OPEN", "CAPTURING"), true);
  assert.equal(canTransitionSessionStatus("CAPTURING", "PROCESSING"), true);
  assert.equal(canTransitionSessionStatus("PROCESSING", "REVIEW"), true);
  assert.equal(canTransitionSessionStatus("REVIEW", "FINALIZED"), true);
});

test("a session cannot skip review on its way to finalized", () => {
  // The one transition that would let a register close without anybody
  // looking at it.
  assert.equal(canTransitionSessionStatus("PROCESSING", "FINALIZED"), false);
  assert.equal(canTransitionSessionStatus("CAPTURING", "FINALIZED"), false);
  assert.equal(canTransitionSessionStatus("OPEN", "FINALIZED"), false);
});

test("finalized and cancelled are terminal", () => {
  for (const target of ["OPEN", "CAPTURING", "PROCESSING", "REVIEW", "FINALIZED"] as const) {
    assert.equal(canTransitionSessionStatus("FINALIZED", target), false, `FINALIZED->${target}`);
    assert.equal(canTransitionSessionStatus("CANCELLED", target), false, `CANCELLED->${target}`);
  }
});

test("generation refuses a finalized or cancelled session", async () => {
  for (const status of ["FINALIZED", "CANCELLED"] as const) {
    const store = makeStore(roster(3), status);
    await assert.rejects(
      () =>
        generateAttendanceCandidates(
          makeUser(),
          { sessionId: "sess-1", recognition: null },
          store.deps,
        ),
      new RegExp(`session_locked:${status}`),
    );
  }
});

// ===========================================================================
// 2. Recognition → attendance mapping
// ===========================================================================

test("no recognition outcome produces a final result", () => {
  // The table, exhaustively. Every combination must leave the register
  // unresolved; the only differences are the evidence and the reason.
  const cases: Array<[string, Parameters<typeof decideCandidate>[0], string]> = [
    [
      "MATCHED",
      { aggregate: { advisoryResult: "PRESENT", bestSimilarity: 0.9, wasAmbiguous: false, bestFaceId: "1:0" }, recognitionRan: true, hasComparableTemplate: true, hasAnyTemplate: true },
      "PRESENT",
    ],
    [
      "UNCERTAIN",
      { aggregate: { advisoryResult: "NEEDS_REVIEW", bestSimilarity: 0.5, wasAmbiguous: false, bestFaceId: "1:0" }, recognitionRan: true, hasComparableTemplate: true, hasAnyTemplate: true },
      "NEEDS_REVIEW",
    ],
    [
      "UNMATCHED",
      { aggregate: undefined, recognitionRan: true, hasComparableTemplate: true, hasAnyTemplate: true },
      "ABSENT",
    ],
    [
      "NO_ENROLLED_FACE",
      { aggregate: undefined, recognitionRan: true, hasComparableTemplate: false, hasAnyTemplate: false },
      "NOT_EVALUATED",
    ],
    [
      "NO_FACE_DETECTED",
      { aggregate: undefined, recognitionRan: true, hasComparableTemplate: true, hasAnyTemplate: true, noFacesDetected: true },
      "NOT_EVALUATED",
    ],
    [
      "SERVICE_UNAVAILABLE",
      { aggregate: undefined, recognitionRan: false, hasComparableTemplate: true, hasAnyTemplate: true },
      "NOT_EVALUATED",
    ],
    [
      "ERROR",
      { aggregate: undefined, recognitionRan: false, hasComparableTemplate: true, hasAnyTemplate: true, recognitionErrored: true },
      "NOT_EVALUATED",
    ],
  ];

  for (const [label, input, expectedAi] of cases) {
    const d = decideCandidate(input);
    assert.equal(d.finalResult, "NEEDS_REVIEW", `${label} must not decide the register`);
    assert.equal(d.aiResult, expectedAi, `${label} evidence`);
    assert.notEqual(d.finalResult, "ABSENT", `${label} must never mean absent`);
    assert.notEqual(d.finalResult, "PRESENT", `${label} must never mean present`);
  }
});

test("a detect-only run neither marks nor rules out anybody", () => {
  // Identification not approved: faces were counted, nobody was compared. The
  // absence of an aggregate must not read as "compared and not there".
  const d = decideCandidate({
    aggregate: undefined,
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
    identificationUnavailable: true,
  });
  assert.equal(d.aiResult, "NOT_EVALUATED");
  assert.equal(d.finalResult, "NEEDS_REVIEW");
  assert.equal(d.note.reason, "identification_unavailable");
  assert.equal(d.note.wasComparable, false);
  assert.equal(d.note.aiSuggestion, null);
});

test("only MATCHED carries a suggestion", () => {
  const matched = decideCandidate({
    aggregate: { advisoryResult: "PRESENT", bestSimilarity: 0.9, wasAmbiguous: false, bestFaceId: "1:0" },
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(matched.note.aiSuggestion, "PRESENT");

  for (const input of [
    { aggregate: undefined, recognitionRan: true, hasComparableTemplate: true, hasAnyTemplate: true },
    { aggregate: undefined, recognitionRan: false, hasComparableTemplate: true, hasAnyTemplate: true },
    { aggregate: { advisoryResult: "NEEDS_REVIEW", bestSimilarity: 0.5, wasAmbiguous: true, bestFaceId: "1:0" }, recognitionRan: true, hasComparableTemplate: true, hasAnyTemplate: true },
  ]) {
    assert.equal(decideCandidate(input).note.aiSuggestion, null);
  }
});

// ===========================================================================
// 3. Register generation
// ===========================================================================

test("every enrolled student gets exactly one row, and none is decided", async () => {
  const { store } = await seed();
  assert.equal(store.rows.size, 5);
  assert.ok(
    Array.from(store.rows.values()).every((r) => r.finalResult === "NEEDS_REVIEW"),
    "generation decides nothing",
  );
});

test("regenerating does not duplicate a student", async () => {
  const { store } = await seed();
  const second = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: runSummary({ perStudent: [suggestion("stu-001")] }) },
    store.deps,
  );
  assert.equal(second.created, 0);
  assert.equal(store.rows.size, 5);
});

test("an empty roster is refused rather than producing an empty register", async () => {
  const store = makeStore([]);
  await assert.rejects(
    () =>
      generateAttendanceCandidates(makeUser(), { sessionId: "sess-1", recognition: null }, store.deps),
    /empty_roster/,
  );
});

// ===========================================================================
// 4. Faculty actions and correction
// ===========================================================================

test("marking present records the actor and preserves the AI evidence", async () => {
  const { store } = await seed();
  await applyReviewDecision(
    makeUser({ userId: "user-teacher" }),
    { attendanceRecordId: store.recordIdFor("stu-004"), newResult: "PRESENT", reason: "Called the roll" },
    store.deps,
  );
  const row = store.rows.get("stu-004")!;
  assert.equal(row.finalResult, "PRESENT");
  assert.equal(row.isManuallyCorrected, true);
  assert.equal(row.aiResult, "ABSENT", "the machine's finding is untouched");

  assert.equal(store.corrections.length, 1);
  assert.equal(store.corrections[0].changedByUserId, "user-teacher");
  assert.equal(store.corrections[0].previousResult, "NEEDS_REVIEW");
  assert.equal(store.corrections[0].reason, "Called the roll");
});

test("correcting a suggestion to absent keeps both the suggestion and the decision", async () => {
  const { store } = await seed();
  await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor("stu-001"), newResult: "ABSENT", reason: "Left early" },
    store.deps,
  );
  const row = store.rows.get("stu-001")!;
  assert.equal(row.aiResult, "PRESENT", "the model still says it saw them");
  assert.equal(row.aiConfidence, 0.9, "and how sure it was");
  assert.equal(row.finalResult, "ABSENT", "the person disagreed, and the person wins");
  assert.equal(row.isManuallyCorrected, true);
});

test("a decision can be reversed, and every step is in the trail", async () => {
  const { store } = await seed();
  const id = store.recordIdFor("stu-004");
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "PRESENT" }, store.deps);
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "ABSENT" }, store.deps);
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "PRESENT" }, store.deps);

  assert.equal(store.rows.get("stu-004")!.finalResult, "PRESENT");
  assert.deepEqual(
    store.corrections.map((c) => [c.previousResult, c.newResult]),
    [
      ["NEEDS_REVIEW", "PRESENT"],
      ["PRESENT", "ABSENT"],
      ["ABSENT", "PRESENT"],
    ],
  );
});

// ===========================================================================
// 5. Idempotency and concurrency
// ===========================================================================

test("double-clicking the same decision writes one correction, not two", async () => {
  const { store } = await seed();
  const id = store.recordIdFor("stu-004");
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "PRESENT" }, store.deps);
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "PRESENT" }, store.deps);
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "PRESENT" }, store.deps);
  assert.equal(store.corrections.length, 1, "a non-change is not an audit event");
});

test("two teachers pressing Confirm at once close the register once", async () => {
  const { store } = await seed();
  await resolveBlockers(store);
  const results = await Promise.allSettled([
    confirmAttendance(makeUser({ userId: "user-a" }), "sess-1", store.deps),
    confirmAttendance(makeUser({ userId: "user-b" }), "sess-1", store.deps),
  ]);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(store.status, "FINALIZED");
});

test("confirming an already finalized register is refused", async () => {
  const { store } = await seed();
  await resolveBlockers(store);
  await confirmAttendance(makeUser(), "sess-1", store.deps);
  await assert.rejects(() => confirmAttendance(makeUser(), "sess-1", store.deps), /invalid_transition/);
});

// ===========================================================================
// 6. Finalization
// ===========================================================================

test("finalization is blocked while an undecided row remains", async () => {
  const { store } = await seed();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.canFinalize, false);
  assert.equal(board.awaitingDecision, 2);
  await assert.rejects(() => confirmAttendance(makeUser(), "sess-1", store.deps), /unresolved/);
});

test("confirming converts every suggestion into a recorded faculty decision", async () => {
  const { store } = await seed();
  await resolveBlockers(store);
  const before = store.corrections.length;
  await confirmAttendance(makeUser({ userId: "user-head" }), "sess-1", store.deps);

  const added = store.corrections.slice(before);
  assert.equal(added.length, 3, "one per suggestion");
  assert.ok(added.every((c) => c.newResult === "PRESENT"));
  assert.ok(added.every((c) => c.changedByUserId === "user-head"));
  assert.equal(store.rows.get("stu-001")!.finalResult, "PRESENT");
});

test("a register with no suggestions at all can still be confirmed once decided", async () => {
  // The recognition-outage path: every row resolved by hand.
  const students = roster(3);
  const store = makeStore(students);
  await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: null },
    store.deps,
  );
  for (const s of students) {
    await applyReviewDecision(
      makeUser(),
      { attendanceRecordId: store.recordIdFor(s.studentId), newResult: "PRESENT" },
      store.deps,
    );
  }
  const confirmed = await confirmAttendance(makeUser(), "sess-1", store.deps);
  assert.equal(confirmed.counts.present, 3);
  assert.equal(store.status, "FINALIZED");
});

// ===========================================================================
// 7. Authorization
// ===========================================================================

test("a student cannot mark anybody present — including themselves", async () => {
  const { store } = await seed();
  const student = makeUser({ key: "STUDENT", permissions: STUDENT_PERMISSIONS, userId: "user-student" });
  await assert.rejects(
    () =>
      applyReviewDecision(
        student,
        { attendanceRecordId: store.recordIdFor("stu-001"), newResult: "PRESENT" },
        store.deps,
      ),
    ForbiddenError,
  );
});

test("a student cannot mark anybody absent, read a board, or finalize", async () => {
  const { store } = await seed();
  const student = makeUser({ key: "STUDENT", permissions: STUDENT_PERMISSIONS });
  await assert.rejects(
    () =>
      applyReviewDecision(
        student,
        { attendanceRecordId: store.recordIdFor("stu-001"), newResult: "ABSENT" },
        store.deps,
      ),
    ForbiddenError,
  );
  await assert.rejects(() => getAttendanceReviewBoard(student, "sess-1", store.deps), ForbiddenError);
  await assert.rejects(() => confirmAttendance(student, "sess-1", store.deps), ForbiddenError);
});

test("an operator may correct but may not close the register", async () => {
  const { store } = await seed();
  const operator = makeUser({ key: "ATTENDANCE_OPERATOR", permissions: OPERATOR_PERMISSIONS });
  // Correcting is allowed.
  await applyReviewDecision(
    operator,
    { attendanceRecordId: store.recordIdFor("stu-004"), newResult: "PRESENT" },
    store.deps,
  );
  assert.equal(store.rows.get("stu-004")!.finalResult, "PRESENT");
  // Finalizing is not.
  await assert.rejects(() => confirmAttendance(operator, "sess-1", store.deps), ForbiddenError);
});

test("another institution's faculty cannot touch this register", async () => {
  const { store } = await seed();
  const intruder = makeUser({ institutionId: "inst-B", userId: "user-other" });
  await assert.rejects(() => getAttendanceReviewBoard(intruder, "sess-1", store.deps), ForbiddenError);
  await assert.rejects(
    () =>
      applyReviewDecision(
        intruder,
        { attendanceRecordId: store.recordIdFor("stu-001"), newResult: "PRESENT" },
        store.deps,
      ),
    ForbiddenError,
  );
  await assert.rejects(() => confirmAttendance(intruder, "sess-1", store.deps), ForbiddenError);
});

test("a teacher not linked to the cohort is refused", async () => {
  const { store } = await seed();
  store.deps.requireCohortAccess = async () => {
    throw new ForbiddenError("not_cohort_faculty");
  };
  await assert.rejects(() => getAttendanceReviewBoard(makeUser(), "sess-1", store.deps), ForbiddenError);
});

test("a subject register demands the subject link before it may be written", async () => {
  const students = roster(2);
  const store = makeStore(students, "CAPTURING", { cohortSubjectId: "cs-1" });
  store.deps.requireCohortSubjectAccess = async () => {
    throw new ForbiddenError("not_subject_faculty");
  };
  await assert.rejects(
    () =>
      generateAttendanceCandidates(makeUser(), { sessionId: "sess-1", recognition: null }, store.deps),
    ForbiddenError,
  );
});

// ===========================================================================
// 8. School vs college semantics
// ===========================================================================

test("a school register is scoped to the cohort, with no subject", async () => {
  const { store } = await seed();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  assert.equal(board.session.cohortSubjectId, null);
  assert.equal(board.session.attendanceMode, "DAILY");
  assert.equal(board.session.rosterScope, "cohort");
});

test("a college register keeps its subject and uses the subject roster", async () => {
  const subjectRoster = roster(2);
  const store = makeStore(subjectRoster, "CAPTURING", { cohortSubjectId: "cs-1" });
  store.deps.listCohortSubjectRoster = async () => subjectRoster;
  store.deps.listCohortRoster = async () => roster(40); // the wider class
  const result = await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: null },
    store.deps,
  );
  assert.equal(result.rosterScope, "cohortSubject");
  assert.equal(result.counts.total, 2, "the subject's students, not the whole class");
});

// ===========================================================================
// 9. Privacy
// ===========================================================================

test("a review board carries no embedding and no image", async () => {
  const { store } = await seed();
  const board = await getAttendanceReviewBoard(makeUser(), "sess-1", store.deps);
  const wire = JSON.stringify(board);
  for (const forbidden of ["embedding", "imageBase64", "sourceImageUrl", "vector"]) {
    assert.equal(wire.includes(forbidden), false, `board leaked ${forbidden}`);
  }
});

test("stored provenance records where a match came from, never the vector", async () => {
  const { store } = await seed();
  const wire = JSON.stringify(store.metadata);
  assert.equal(wire.includes("embedding"), false);
  assert.ok(wire.includes("studentNotes"), "provenance is kept");
});

// ===========================================================================
// 10. Concurrency, measured against the real database first
//
// Both guards below exist because the audit ran the race against Postgres and
// watched it fail: three concurrent confirmations produced five correction
// rows for two students, and four produced four finalizations of one register.
// The final attendance was right in both cases; the audit trail was not, and
// an audit trail that records one decision three times is not one.
// ===========================================================================

test("a guarded correction that loses the race writes nothing", async () => {
  const { store } = await seed();
  const id = store.recordIdFor("stu-004");
  // First writer wins and the row moves to PRESENT.
  await applyReviewDecision(makeUser(), { attendanceRecordId: id, newResult: "PRESENT" }, store.deps);
  const after = store.corrections.length;

  // A second writer that still believes the row is unresolved must not land.
  const correct = store.deps.correctAttendanceRecord!;
  await correct({
    attendanceRecordId: id,
    newResult: "PRESENT",
    changedByUserId: "user-second",
    source: "FACULTY_REVIEW",
    onlyIfCurrentResultIn: ["NEEDS_REVIEW", "NOT_EVALUATED"],
  });
  assert.equal(store.corrections.length, after, "the stale write is a no-op");
});

test("an unguarded correction still writes, so the guard is opt-in", async () => {
  // The guard changes behaviour only where a caller asks for it; every
  // existing call site keeps its semantics.
  const { store } = await seed();
  const id = store.recordIdFor("stu-004");
  const before = store.corrections.length;
  await store.deps.correctAttendanceRecord!({
    attendanceRecordId: id,
    newResult: "ABSENT",
    changedByUserId: "user-x",
    source: "FACULTY_REVIEW",
  });
  assert.equal(store.corrections.length, before + 1);
});

test("confirming twice accepts each suggestion once", async () => {
  const { store } = await seed();
  await resolveBlockers(store);
  const before = store.corrections.length;
  await confirmAttendance(makeUser(), "sess-1", store.deps);
  const afterFirst = store.corrections.length;
  assert.equal(afterFirst - before, 3, "three suggestions accepted");

  // The register is closed now; a second confirmation is refused outright and
  // cannot re-accept anything.
  await assert.rejects(() => confirmAttendance(makeUser(), "sess-1", store.deps));
  assert.equal(store.corrections.length, afterFirst, "no second round of corrections");
});

test("every accepted suggestion carries exactly one correction", async () => {
  const { store } = await seed();
  await resolveBlockers(store);
  await confirmAttendance(makeUser(), "sess-1", store.deps);

  for (const studentId of ["stu-001", "stu-002", "stu-003"]) {
    const id = store.recordIdFor(studentId);
    const forRow = store.corrections.filter((c) => c.attendanceRecordId === id);
    assert.equal(forRow.length, 1, `${studentId} has one recorded decision`);
    assert.equal(forRow[0].newResult, "PRESENT");
  }
});

// ===========================================================================
// 11. Photographs that could not be used, and photographs added later
// ===========================================================================

function review(studentId: string, similarity: number, extra: Record<string, unknown> = {}) {
  return {
    ...suggestion(studentId, similarity),
    advisoryResult: "NEEDS_REVIEW" as const,
    matchStatus: "UNCERTAIN" as const,
    ...extra,
  };
}

function noteOf(store: ReturnType<typeof makeStore>, studentId: string) {
  const bucket = store.metadata.attendanceReview as {
    studentNotes: Record<string, { reason: string | null; observations?: Array<{ captureNumber: number }>; bestFaceId: string | null }>;
    captureImages: Array<{ sequenceNumber: number }>;
    recognition: Record<string, unknown>;
  };
  return { note: bucket.studentNotes[studentId], bucket };
}

test("a match demoted because the face was too small tells the reviewer so", () => {
  const decision = decideCandidate({
    aggregate: review("stu-001", 0.9, {
      downgrades: ["low_quality_face"],
      bestQualityFlags: ["face_too_small"],
    }),
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(decision.note.reason, "face_too_small");
  assert.equal(decision.finalResult, "NEEDS_REVIEW");
  assert.equal(decision.note.aiSuggestion, null, "a flagged face is never a present suggestion");
});

test("a confusion between students outranks a poor photo as the review reason", () => {
  const decision = decideCandidate({
    aggregate: review("stu-001", 0.7, {
      wasAmbiguous: true,
      downgrades: ["reassigned_face"],
      bestQualityFlags: ["blurred"],
    }),
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(decision.note.reason, "ambiguous_match");
});

test("a blurred face in the review band is explained as low quality, not low confidence", () => {
  const decision = decideCandidate({
    aggregate: review("stu-001", 0.5, { bestQualityFlags: ["blurred"] }),
    recognitionRan: true,
    hasComparableTemplate: true,
    hasAnyTemplate: true,
  });
  assert.equal(decision.note.reason, "low_quality");
});

test("faces too small to compare leave everyone unresolved for that reason, not as no match", async () => {
  const store = makeStore(roster(3));
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({
        detectedFacesTotal: 0,
        scoredFacesTotal: 0,
        rejectedFaces: { face_too_small: 3 },
        recommendRetake: true,
      }),
    },
    store.deps,
  );
  for (const row of store.rows.values()) {
    assert.equal(row.aiResult, "NOT_EVALUATED", "nobody was ruled out");
    assert.equal(row.finalResult, "NEEDS_REVIEW");
  }
  assert.equal(noteOf(store, "stu-001").note.reason, "face_too_small");
  assert.equal(noteOf(store, "stu-001").bucket.recognition.recommendRetake, true);
});

test("a photo with no faces at all is still reported as no face detected", async () => {
  const store = makeStore(roster(1));
  await generateAttendanceCandidates(
    makeUser(),
    { sessionId: "sess-1", recognition: runSummary({ detectedFacesTotal: 0, scoredFacesTotal: 0 }) },
    store.deps,
  );
  assert.equal(noteOf(store, "stu-001").note.reason, "no_face_detected");
});

test("an added photo can find a student the first photo missed", async () => {
  const { store } = await seed();
  assert.equal(store.rows.get("stu-004")!.aiResult, "ABSENT");
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({ detectedFacesTotal: 1, perStudent: [suggestion("stu-004", 0.8)] }),
      merge: true,
    },
    store.deps,
  );
  assert.equal(store.rows.get("stu-004")!.aiResult, "PRESENT");
  // Not being in the second photo does not undo the first.
  for (const id of ["stu-001", "stu-002", "stu-003"]) {
    assert.equal(store.rows.get(id)!.aiResult, "PRESENT", id);
  }
  assert.equal(store.rows.get("stu-005")!.aiResult, "ABSENT");
  assert.equal(store.rows.size, 5, "a merge adds evidence, not rows");
});

test("an added photo numbers its captures after the ones already taken", async () => {
  const { store } = await seed();
  const extra = suggestion("stu-004", 0.8);
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({
        detectedFacesTotal: 1,
        perFace: [{ imageSequenceNumber: 1, qualityScore: 0.7 }] as RecognitionRunSummary["perFace"],
        perStudent: [{ ...extra, observations: [{ captureNumber: 1, faceIndex: 0, similarity: 0.8, matchStatus: "MATCHED", detectedFaceId: "1:0" }] as typeof extra.observations }],
      }),
      merge: true,
    },
    store.deps,
  );
  const { note, bucket } = noteOf(store, "stu-004");
  // seed() recorded no capture images, so the added photo is capture 1 here;
  // run the merge again and the next photo must be capture 2.
  assert.equal(note.bestFaceId, "1:0");
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({
        detectedFacesTotal: 1,
        perFace: [{ imageSequenceNumber: 1, qualityScore: 0.7 }] as RecognitionRunSummary["perFace"],
        perStudent: [{ ...suggestion("stu-005", 0.9), bestFaceId: "1:0" }],
      }),
      merge: true,
    },
    store.deps,
  );
  const after = noteOf(store, "stu-005");
  assert.equal(after.note.bestFaceId, "2:0");
  assert.deepEqual(after.bucket.captureImages.map((c) => c.sequenceNumber), [1, 2]);
  assert.equal(after.bucket.recognition.rounds, 3);
  assert.ok(bucket);
});

test("a teacher's decision survives an added photo", async () => {
  const { store } = await seed();
  await applyReviewDecision(
    makeUser(),
    { attendanceRecordId: store.recordIdFor("stu-004"), newResult: "ABSENT" },
    store.deps,
  );
  await generateAttendanceCandidates(
    makeUser(),
    {
      sessionId: "sess-1",
      recognition: runSummary({ perStudent: [suggestion("stu-004", 0.95)] }),
      merge: true,
    },
    store.deps,
  );
  assert.equal(store.rows.get("stu-004")!.finalResult, "ABSENT");
  assert.equal(store.rows.get("stu-004")!.isManuallyCorrected, true);
});

test("a student two faces claimed stays in review even if a later photo is clear", () => {
  const previousRow = {
    id: "rec-a", sessionId: "sess-1", studentId: "stu-a",
    aiResult: "NEEDS_REVIEW", aiConfidence: 0.9, finalResult: "NEEDS_REVIEW", isManuallyCorrected: false,
  } as AttendanceRecordRow;
  const previousNote = { reason: "duplicate_in_capture" as const, wasAmbiguous: true, wasComparable: true, bestFaceId: "1:0" };
  const next = {
    row: { institutionId: "inst-A", sessionId: "sess-1", studentId: "stu-a", aiResult: "PRESENT" as const, aiConfidence: 0.95, matchedEmbeddingId: "emb-a", finalResult: "NEEDS_REVIEW" as const },
    note: { reason: null, aiSuggestion: "PRESENT" as const, wasAmbiguous: false, wasComparable: true, bestFaceId: "1:0" },
  };
  const merged = mergeRoundDecision(previousRow, previousNote, next, 1);
  assert.equal(merged.write, null, "the confusion is kept");
  assert.equal(merged.note.reason, "duplicate_in_capture");
  // And the other way round: a clear first photo, a confused second.
  const flipped = mergeRoundDecision(
    { ...previousRow, aiResult: "PRESENT" },
    { reason: null, aiSuggestion: "PRESENT", wasAmbiguous: false, wasComparable: true, bestFaceId: "1:0" },
    { row: { ...next.row, aiResult: "NEEDS_REVIEW" }, note: { ...previousNote, bestFaceId: "1:2" } },
    1,
  );
  assert.equal(flipped.write?.aiResult, "NEEDS_REVIEW");
  assert.equal(flipped.note.reason, "duplicate_in_capture");
  assert.equal(flipped.note.bestFaceId, "2:2");
});

test("an added photo from a different model build is refused, not blended in", async () => {
  const { store } = await seed();
  await assert.rejects(
    generateAttendanceCandidates(
      makeUser(),
      {
        sessionId: "sess-1",
        recognition: runSummary({ modelVersion: "9.9.9", perStudent: [suggestion("stu-004")] }),
        merge: true,
      },
      store.deps,
    ),
    /merge_model_mismatch/,
  );
  assert.equal(store.rows.get("stu-004")!.aiResult, "ABSENT", "nothing was written");
});
