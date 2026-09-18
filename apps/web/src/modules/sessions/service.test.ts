import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionSessionStatus,
  createAttendanceSessionForRequest,
  finalizeAttendanceSession,
} from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { AttendanceResult } from "../attendance/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { CohortSubject } from "../subjects/types.ts";
import type { AttendanceSession } from "./types.ts";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "FACULTY",
        name: "Faculty",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const SCHOOL = { id: "inst-A", type: "SCHOOL", settings: {} } as unknown as Institution;
const COLLEGE = { id: "inst-A", type: "COLLEGE", settings: {} } as unknown as Institution;

test("session state transitions enforce the pipeline order", () => {
  assert.equal(canTransitionSessionStatus("OPEN", "CAPTURING"), true);
  assert.equal(canTransitionSessionStatus("OPEN", "FINALIZED"), false);
  assert.equal(canTransitionSessionStatus("FINALIZED", "OPEN"), false);
});

test("DAILY mode rejects a session that carries a cohortSubjectId", async () => {
  const teacher = makeUser({
    roleKey: "CLASS_TEACHER",
    permissions: ["attendanceSession.create"],
  });
  let created = false;
  await assert.rejects(
    () =>
      createAttendanceSessionForRequest(
        teacher,
        { cohortId: "coh-1", sessionDate: new Date("2026-09-15"), cohortSubjectId: "cs-1" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getInstitutionById: async () => SCHOOL,
          findExistingDailySession: async () => null,
          requireCohortAccess: async () => {},
          createSession: async () => {
            created = true;
            return {} as AttendanceSession;
          },
        },
      ),
    /daily_mode_forbids_subject/,
  );
  assert.equal(created, false);
});

test("DAILY mode enforces one session per cohort per date", async () => {
  const teacher = makeUser({
    roleKey: "CLASS_TEACHER",
    permissions: ["attendanceSession.create"],
  });
  await assert.rejects(
    () =>
      createAttendanceSessionForRequest(
        teacher,
        { cohortId: "coh-1", sessionDate: new Date("2026-09-15") },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getInstitutionById: async () => SCHOOL,
          findExistingDailySession: async () =>
            ({ id: "existing" } as AttendanceSession),
          requireCohortAccess: async () => {},
          createSession: async () => ({} as AttendanceSession),
        },
      ),
    /daily_session_already_exists/,
  );
});

test("SUBJECT_WISE mode requires a cohortSubjectId", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.create"] });
  await assert.rejects(
    () =>
      createAttendanceSessionForRequest(
        faculty,
        { cohortId: "coh-1", sessionDate: new Date("2026-09-15") },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getInstitutionById: async () => COLLEGE,
          getCohortSubjectById: async () => null,
          requireCohortSubjectAccess: async () => {},
          createSession: async () => ({} as AttendanceSession),
        },
      ),
    /subject_wise_mode_requires_subject/,
  );
});

// A subject session must reference a CohortSubject that actually belongs to
// the cohort being taken. Otherwise a faculty could point their DBMS session
// at some other cohort's roster and take attendance for foreign students.
test("SUBJECT_WISE rejects a subject that belongs to a different cohort", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.create"] });
  await assert.rejects(
    () =>
      createAttendanceSessionForRequest(
        faculty,
        { cohortId: "coh-1", sessionDate: new Date("2026-09-15"), cohortSubjectId: "cs-other" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getInstitutionById: async () => COLLEGE,
          getCohortSubjectById: async () => ({ id: "cs-other", cohortId: "coh-2" } as CohortSubject),
          requireCohortSubjectAccess: async () => {},
          createSession: async () => ({} as AttendanceSession),
        },
      ),
    /cohort_subject_mismatch/,
  );
});

test("cross-institution attendance-session creation is denied", async () => {
  const teacher = makeUser({
    institutionId: "inst-A",
    permissions: ["attendanceSession.create"],
  });
  await assert.rejects(
    () =>
      createAttendanceSessionForRequest(
        teacher,
        { cohortId: "coh-B", sessionDate: new Date("2026-09-15") },
        {
          getCohortById: async () => ({ id: "coh-B", institutionId: "inst-B" } as Cohort),
          getInstitutionById: async () => ({ ...SCHOOL, id: "inst-B" } as Institution),
          findExistingDailySession: async () => null,
          requireCohortAccess: async () => {},
          createSession: async () => ({} as AttendanceSession),
        },
      ),
    ForbiddenError,
  );
});

test("SUBJECT_WISE session ownership: not-subject-faculty is denied before write", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.create"] });
  let created = false;
  await assert.rejects(
    () =>
      createAttendanceSessionForRequest(
        faculty,
        { cohortId: "coh-1", sessionDate: new Date("2026-09-15"), cohortSubjectId: "cs-1" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getInstitutionById: async () => COLLEGE,
          getCohortSubjectById: async () => ({ id: "cs-1", cohortId: "coh-1" } as CohortSubject),
          requireCohortSubjectAccess: async () => {
            throw new ForbiddenError("not_subject_faculty");
          },
          createSession: async () => {
            created = true;
            return {} as AttendanceSession;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(created, false);
});

// ---------------------------------------------------------------------------
// Phase 6 — finalization guard
// ---------------------------------------------------------------------------

const REVIEW_SESSION = {
  id: "sess-1",
  institutionId: "inst-A",
  cohortId: "coh-1",
  status: "REVIEW",
} as unknown as AttendanceSession;

function finalizeDeps(
  records: Array<{ finalResult: string }>,
  onFinalize?: () => void,
): Parameters<typeof finalizeAttendanceSession>[2] {
  return {
    getSessionById: async () => REVIEW_SESSION,
    requireCohortAccess: async () => {},
    listAttendanceRecords: async () =>
      records as Array<{ finalResult: AttendanceResult }>,
    finalizeInDatabase: async () => {
      onFinalize?.();
      return { ...REVIEW_SESSION, status: "FINALIZED" } as AttendanceSession;
    },
  };
}

test("finalization refuses a register that still contains NEEDS_REVIEW", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.finalize"] });
  let finalized = false;
  await assert.rejects(
    () =>
      finalizeAttendanceSession(
        faculty,
        "sess-1",
        finalizeDeps(
          [
            { finalResult: "PRESENT" },
            { finalResult: "ABSENT" },
            { finalResult: "NEEDS_REVIEW" },
          ],
          () => {
            finalized = true;
          },
        ),
      ),
    /unresolved_review_states:1/,
  );
  // The important half of the assertion: an unresolved row did not quietly
  // become a recorded result.
  assert.equal(finalized, false);
});

test("finalization refuses NOT_EVALUATED rows too", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.finalize"] });
  await assert.rejects(
    () =>
      finalizeAttendanceSession(
        faculty,
        "sess-1",
        finalizeDeps([{ finalResult: "PRESENT" }, { finalResult: "NOT_EVALUATED" }]),
      ),
    /unresolved_review_states:1/,
  );
});

test("finalization refuses an empty register", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.finalize"] });
  await assert.rejects(
    () => finalizeAttendanceSession(faculty, "sess-1", finalizeDeps([])),
    /no_attendance_records/,
  );
});

test("finalization succeeds once every row is present or absent", async () => {
  const faculty = makeUser({ permissions: ["attendanceSession.finalize"] });
  let finalized = false;
  const result = await finalizeAttendanceSession(
    faculty,
    "sess-1",
    finalizeDeps(
      [{ finalResult: "PRESENT" }, { finalResult: "ABSENT" }, { finalResult: "PRESENT" }],
      () => {
        finalized = true;
      },
    ),
  );
  assert.equal(finalized, true);
  assert.equal(result.status, "FINALIZED");
});

test("finalization requires the attendanceSession.finalize permission", async () => {
  const operator = makeUser({
    roleKey: "ATTENDANCE_OPERATOR",
    permissions: ["attendanceSession.capture"],
  });
  await assert.rejects(
    () =>
      finalizeAttendanceSession(operator, "sess-1", finalizeDeps([{ finalResult: "PRESENT" }])),
    ForbiddenError,
  );
});
