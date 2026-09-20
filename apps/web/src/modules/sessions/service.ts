import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import {
  requireCohortAccess,
  requireCohortSubjectAccess,
} from "@/modules/authorization/cohort-access";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getCohortById } from "@/modules/cohorts/repository";
import { getCohortSubjectById } from "@/modules/subjects/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import { getInstitutionById } from "@/modules/institutions/repository";
import type { Cohort } from "@/modules/cohorts/types";
import type { CohortSubject } from "@/modules/subjects/types";
import type { Institution } from "@/modules/institutions/types";
import {
  createSession as createSessionRepo,
  findExistingDailySession as findExistingDailySessionRepo,
  getSessionById,
} from "./repository";
import type { AttendanceResult } from "@/modules/attendance/types";
import type { AttendanceSession, SessionStatus } from "./types";

// Attendance session lifecycle (see ARCHITECTURE.md pipeline diagram):
// OPEN -> CAPTURING -> PROCESSING -> REVIEW -> FINALIZED, cancellable from
// any non-terminal state. Enforced here so no caller can skip review.
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  OPEN: ["CAPTURING", "CANCELLED"],
  CAPTURING: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["REVIEW", "CANCELLED"],
  REVIEW: ["FINALIZED", "CANCELLED"],
  FINALIZED: [],
  CANCELLED: [],
};

export function canTransitionSessionStatus(
  current: SessionStatus,
  next: SessionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[current].includes(next);
}

export interface FinalizeAttendanceSessionDeps {
  getSessionById?: (id: string) => Promise<AttendanceSession | null>;
  requireCohortAccess?: (user: SessionUser, cohortId: string) => Promise<void>;
  /** The session's attendance register. Injected so the unresolved-state
   * guard below is unit-testable without a database. */
  listAttendanceRecords?: (
    sessionId: string,
  ) => Promise<Array<{ finalResult: AttendanceResult }>>;
  finalizeInDatabase?: (
    sessionId: string,
    actor: SessionUser,
    session: AttendanceSession,
    finalizedAt: Date,
  ) => Promise<AttendanceSession>;
  now?: () => Date;
}

/**
 * Moves a session to FINALIZED. Requires attendanceSession.finalize plus
 * cohort ownership (or an admin cohort.manage bypass) — the same
 * "resource-ownership on top of a role permission" pattern used by
 * correctAttendanceRecord's caller. Always pairs the status change with an
 * "attendance.finalized" audit row in the same transaction.
 *
 * **Unresolved states block finalization.** A register containing any
 * NEEDS_REVIEW or NOT_EVALUATED row cannot be closed: finalizing would turn
 * "the system was not sure" into a recorded attendance result that nobody
 * decided. This check lives here, not in the UI, so every finalization path
 * — review screen, future admin tool, future API — hits it.
 *
 * An empty register is also refused. A session with no attendance rows has
 * not had candidates generated; finalizing it would record a class in which
 * nobody was present and nobody was absent.
 */
export async function finalizeAttendanceSession(
  actor: SessionUser,
  sessionId: string,
  deps: FinalizeAttendanceSessionDeps = {},
): Promise<AttendanceSession> {
  requirePermission(actor, "attendanceSession.finalize");

  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(sessionId);
  if (!session) throw new Error("session_not_found");

  requireSameInstitution(actor, session.institutionId);
  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, session.cohortId);

  if (!canTransitionSessionStatus(session.status, "FINALIZED")) {
    throw new Error(`invalid_transition:${session.status}->FINALIZED`);
  }

  const listRecords =
    deps.listAttendanceRecords ??
    (async (id: string) =>
      prisma.attendanceRecord.findMany({
        where: { sessionId: id },
        select: { finalResult: true },
      }));
  const records = await listRecords(sessionId);
  if (records.length === 0) throw new Error("no_attendance_records");
  const unresolved = records.filter(
    (r) => r.finalResult === "NEEDS_REVIEW" || r.finalResult === "NOT_EVALUATED",
  ).length;
  if (unresolved > 0) throw new Error(`unresolved_review_states:${unresolved}`);

  const finalizedAt = (deps.now ?? (() => new Date()))();
  if (deps.finalizeInDatabase) {
    return deps.finalizeInDatabase(sessionId, actor, session, finalizedAt);
  }

  return prisma.$transaction(async (tx) => {
    // Compare-and-set on the status the caller validated, not a bare update.
    //
    // `canTransitionSessionStatus` above checked a status read in an earlier
    // statement, so two callers finalizing at once both passed it and both
    // wrote — producing two FINALIZED updates, two audit rows and two
    // outbound `attendance.finalized` webhooks for one event. Measured: three
    // concurrent confirmations, three finalizations. Carrying the expected
    // status into the UPDATE's own WHERE clause makes exactly one win, which
    // is the same technique `repository.ts#transitionSessionStatus` already
    // uses for every other transition.
    const claimed = await tx.attendanceSession.updateMany({
      where: { id: sessionId, status: session.status },
      data: { status: "FINALIZED", endedAt: finalizedAt },
    });
    if (claimed.count === 0) {
      throw new Error("session_status_conflict");
    }
    const updated = await tx.attendanceSession.findUniqueOrThrow({
      where: { id: sessionId },
    });

    await recordAuditLog(
      {
        action: "attendance.finalized",
        entityType: "AttendanceSession",
        entityId: sessionId,
        institutionId: session.institutionId,
        actorUserId: actor.userId,
        beforeJson: { status: session.status },
        // The tamper-evident record of who closed this register and when.
        // `AttendanceSession` has no finalizedBy/finalizedAt columns, so the
        // review UI reads a mirrored copy from the session's metadata; this
        // audit row is the authoritative one. See
        // modules/attendance-review/service.ts#ATTENDANCE_METADATA_KEY.
        afterJson: {
          status: "FINALIZED",
          finalizedByUserId: actor.userId,
          finalizedAt: finalizedAt.toISOString(),
        },
      },
      tx,
    );

    return updated;
  });
}

export interface CreateAttendanceSessionInput {
  cohortId: string;
  sessionDate: Date;
  /**
   * Required for a SUBJECT_WISE (college) session; must be null/omitted for
   * a DAILY (school) session. The service enforces this from
   * Institution.settings.attendanceMode — not from the caller's claim — so a
   * school admin cannot smuggle a subject session in by passing this field.
   */
  cohortSubjectId?: string | null;
}

export interface CreateAttendanceSessionDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  getCohortSubjectById?: (id: string) => Promise<CohortSubject | null>;
  findExistingDailySession?: (cohortId: string, sessionDate: Date) => Promise<AttendanceSession | null>;
  createSession?: (input: {
    institutionId: string;
    cohortId: string;
    facultyId: string;
    sessionDate: Date;
    cohortSubjectId?: string | null;
  }) => Promise<AttendanceSession>;
  requireCohortAccess?: (user: SessionUser, cohortId: string) => Promise<void>;
  requireCohortSubjectAccess?: (user: SessionUser, cohortSubjectId: string) => Promise<void>;
}

/**
 * The unified attendance-engine entry point (ARCHITECTURE.md's "one attendance
 * engine, branching on configuration, never two parallel models"). Which
 * workflow runs is decided by:
 *
 *   Institution.settings.attendanceMode
 *     - DAILY        → school-style: one session per cohort per day,
 *                      cohortSubjectId must be null
 *     - SUBJECT_WISE → college-style: cohortSubjectId is required and must
 *                      belong to the same cohort
 *
 * Ownership: caller must be linked as faculty of the cohort (or its subject,
 * for subject-wise sessions), OR hold cohort.manage. Every branch feeds the
 * same AttendanceSession/AttendanceRecord/AttendanceCorrection tables so
 * downstream audit + face-search behavior is identical for both.
 */
export async function createAttendanceSessionForRequest(
  actor: SessionUser,
  input: CreateAttendanceSessionInput,
  deps: CreateAttendanceSessionDeps = {},
): Promise<AttendanceSession> {
  requirePermission(actor, "attendanceSession.create");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(input.cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const getInstitution = deps.getInstitutionById ?? getInstitutionById;
  const institution = await getInstitution(cohort.institutionId);
  if (!institution) throw new Error("institution_not_found");

  const mode = resolveAttendanceMode(institution);

  // Config-driven workflow branching. Never trust the caller's cohortSubjectId
  // alone — the attendanceMode is the authoritative source of truth.
  if (mode === "DAILY") {
    if (input.cohortSubjectId) {
      throw new Error("daily_mode_forbids_subject");
    }
    // "generally one daily/class attendance session" — enforce
    // one-per-cohort-per-date so the class teacher cannot double-take.
    const existsFn = deps.findExistingDailySession ?? findExistingDailySessionRepo;
    const existing = await existsFn(input.cohortId, input.sessionDate);
    if (existing) throw new Error("daily_session_already_exists");

    const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
    await checkAccess(actor, input.cohortId);
  } else {
    if (!input.cohortSubjectId) {
      throw new Error("subject_wise_mode_requires_subject");
    }
    const getCS = deps.getCohortSubjectById ?? getCohortSubjectById;
    const cs = await getCS(input.cohortSubjectId);
    if (!cs) throw new Error("cohort_subject_not_found");
    if (cs.cohortId !== input.cohortId) {
      // The subject exists but belongs to a different cohort — this would
      // let a college faculty smuggle another cohort's roster into their
      // subject session. Reject before writing.
      throw new Error("cohort_subject_mismatch");
    }
    const checkSubjectAccess = deps.requireCohortSubjectAccess ?? requireCohortSubjectAccess;
    await checkSubjectAccess(actor, input.cohortSubjectId);
  }

  const createFn = deps.createSession ?? createSessionRepo;
  const created = await createFn({
    institutionId: cohort.institutionId,
    cohortId: input.cohortId,
    facultyId: actor.userId,
    sessionDate: input.sessionDate,
    cohortSubjectId: mode === "SUBJECT_WISE" ? input.cohortSubjectId ?? null : null,
  });

  await recordAuditLog({
    action: "attendance_session.created",
    entityType: "AttendanceSession",
    entityId: created.id,
    institutionId: cohort.institutionId,
    actorUserId: actor.userId,
    afterJson: created,
  });
  return created;
}
