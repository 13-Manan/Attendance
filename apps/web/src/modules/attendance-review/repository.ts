import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AttendanceResult } from "@/modules/attendance/types";
import type { SessionStatus } from "@/modules/sessions/types";
import type { AttendanceRosterStudent } from "./types";

/**
 * Roster loading — the "do not lose them" boundary.
 *
 * Attendance is generated from the *enrolled roster*, never from the face
 * templates that happen to exist. A student with no enrolled face template,
 * or one enrolled under a superseded model build, is still a student in the
 * room: they get an attendance row and land in Absent/Needs Review, where a
 * human decides. Deriving the roster from `FaceEmbedding` instead would make
 * an un-enrolled student invisible rather than absent.
 */

const ROSTER_SELECT = {
  id: true,
  studentCode: true,
  firstName: true,
  lastName: true,
} as const;

function toRoster(rows: Array<{ id: string; studentCode: string; firstName: string; lastName: string }>): AttendanceRosterStudent[] {
  return rows.map((r) => ({
    studentId: r.id,
    studentCode: r.studentCode,
    firstName: r.firstName,
    lastName: r.lastName,
  }));
}

/** School/DAILY roster: everyone with an ACTIVE enrollment in the cohort. */
export async function listCohortRoster(cohortId: string): Promise<AttendanceRosterStudent[]> {
  const rows = await prisma.student.findMany({
    where: { enrollments: { some: { cohortId, status: "ACTIVE" } } },
    select: ROSTER_SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return toRoster(rows);
}

/**
 * College/SUBJECT_WISE roster: students enrolled in this specific subject.
 * The ACTIVE cohort enrollment is required as well, so a student who left
 * the class but whose elective row was never cleaned up does not reappear
 * on a register.
 */
export async function listCohortSubjectRoster(
  cohortSubjectId: string,
): Promise<AttendanceRosterStudent[]> {
  const cohortSubject = await prisma.cohortSubject.findUnique({
    where: { id: cohortSubjectId },
    select: { cohortId: true },
  });
  if (!cohortSubject) return [];
  const rows = await prisma.student.findMany({
    where: {
      subjectEnrollments: { some: { cohortSubjectId } },
      enrollments: { some: { cohortId: cohortSubject.cohortId, status: "ACTIVE" } },
    },
    select: ROSTER_SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return toRoster(rows);
}

/**
 * Which of these students have a face template the running model could
 * actually compare. Used to tell "we compared you and found nothing" apart
 * from "we never had anything to compare you against" — two very different
 * things to tell a student who was marked absent.
 */
export async function listStudentIdsWithComparableTemplates(
  studentIds: string[],
  model?: { modelName: string; modelVersion: string },
): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const rows = await prisma.faceEmbedding.findMany({
    where: {
      studentId: { in: studentIds },
      isActive: true,
      ...(model ? { modelName: model.modelName, modelVersion: model.modelVersion } : {}),
    },
    select: { studentId: true },
    distinct: ["studentId"],
  });
  return rows.map((r) => r.studentId);
}

/** Any active template at all, regardless of model build. */
export async function listStudentIdsWithAnyTemplate(studentIds: string[]): Promise<string[]> {
  return listStudentIdsWithComparableTemplates(studentIds);
}

export interface AttendanceRecordRow {
  id: string;
  sessionId: string;
  studentId: string;
  aiResult: AttendanceResult;
  aiConfidence: number | null;
  finalResult: AttendanceResult;
  isManuallyCorrected: boolean;
}

export async function listAttendanceRecordRowsForSession(
  sessionId: string,
): Promise<AttendanceRecordRow[]> {
  return prisma.attendanceRecord.findMany({
    where: { sessionId },
    select: {
      id: true,
      sessionId: true,
      studentId: true,
      aiResult: true,
      aiConfidence: true,
      finalResult: true,
      isManuallyCorrected: true,
    },
  });
}

export interface AttendanceCandidateRow {
  institutionId: string;
  sessionId: string;
  studentId: string;
  aiResult: AttendanceResult;
  aiConfidence: number | null;
  finalResult: AttendanceResult;
}

/**
 * Writes one AttendanceRecord per roster student, then refreshes the AI
 * advisory on rows a human has not touched.
 *
 * Two rules encoded here:
 *
 *  - `skipDuplicates` makes generation idempotent. Reprocessing after a
 *    retake, or two faculty devices submitting at once, must not violate
 *    `@@unique([sessionId, studentId])` or duplicate a student.
 *  - The refresh pass deliberately excludes `isManuallyCorrected` rows. A
 *    faculty decision outranks any later AI run; re-running recognition
 *    must never quietly undo a correction a human already made.
 */
export async function upsertAttendanceCandidates(
  rows: AttendanceCandidateRow[],
): Promise<{ created: number; refreshed: number }> {
  if (rows.length === 0) return { created: 0, refreshed: 0 };

  const sessionId = rows[0].sessionId;

  return prisma.$transaction(async (tx) => {
    // Snapshot which students already had a row BEFORE inserting, so the
    // refresh pass below can be restricted to genuinely pre-existing rows.
    const existing = await tx.attendanceRecord.findMany({
      where: { sessionId, studentId: { in: rows.map((r) => r.studentId) } },
      select: { studentId: true },
    });
    const existingIds = new Set(existing.map((e) => e.studentId));

    const insert = await tx.attendanceRecord.createMany({
      data: rows
        .filter((r) => !existingIds.has(r.studentId))
        .map((r) => ({
          institutionId: r.institutionId,
          sessionId: r.sessionId,
          studentId: r.studentId,
          aiResult: r.aiResult,
          aiConfidence: r.aiConfidence,
          finalResult: r.finalResult,
        })),
      // Belt and braces against a concurrent generation for the same
      // session: the unique index is the real guard, this keeps it quiet.
      skipDuplicates: true,
    });

    let refreshed = 0;
    for (const r of rows) {
      if (!existingIds.has(r.studentId)) continue;
      const res = await tx.attendanceRecord.updateMany({
        where: { sessionId, studentId: r.studentId, isManuallyCorrected: false },
        data: {
          aiResult: r.aiResult,
          aiConfidence: r.aiConfidence,
          finalResult: r.finalResult,
        },
      });
      refreshed += res.count;
    }

    return { created: insert.count, refreshed };
  });
}

/** Shape of `getSessionDetailRow`. Written out rather than inferred so a
 * test can build one without importing the Prisma client. */
export interface SessionDetailRow {
  id: string;
  institutionId: string;
  cohortId: string;
  cohortSubjectId: string | null;
  facultyId: string;
  sessionDate: Date;
  startedAt: Date;
  endedAt: Date | null;
  status: SessionStatus;
  metadata: unknown;
  // No `institution` here: `AttendanceSession` carries `institutionId` as a
  // plain column with no relation field, so the name is resolved separately
  // by the service (which already loads the institution to decide the
  // attendance mode).
  faculty: { name: string } | null;
  cohort: {
    name: string;
    termLabel: string | null;
    academicSessionId: string;
    academicSession: { name: string } | null;
  } | null;
  cohortSubject: { subject: { name: string; code: string } | null } | null;
}

/** Full session context for the review header, in one round trip. */
export function getSessionDetailRow(sessionId: string): Promise<SessionDetailRow | null> {
  return prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      institutionId: true,
      cohortId: true,
      cohortSubjectId: true,
      facultyId: true,
      sessionDate: true,
      startedAt: true,
      endedAt: true,
      status: true,
      metadata: true,
      faculty: { select: { name: true } },
      cohort: {
        select: {
          name: true,
          termLabel: true,
          academicSessionId: true,
          academicSession: { select: { name: true } },
        },
      },
      cohortSubject: { select: { subject: { select: { name: true, code: true } } } },
    },
  });
}

/**
 * Recent sessions for a class, so a faculty member can get back to a review
 * board they left — including a finalized one, which is the entry point for
 * the authorized post-finalization correction workflow.
 */
export function listRecentSessionsForCohort(cohortId: string, take = 15) {
  return prisma.attendanceSession.findMany({
    where: { cohortId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      sessionDate: true,
      startedAt: true,
      status: true,
      cohortSubject: { select: { subject: { select: { name: true, code: true } } } },
      _count: { select: { attendanceRecords: true } },
    },
    orderBy: [{ sessionDate: "desc" }, { startedAt: "desc" }],
    take,
  });
}

export function getUserNameById(userId: string): Promise<string | null> {
  return prisma.user
    .findUnique({ where: { id: userId }, select: { name: true } })
    .then((u) => u?.name ?? null);
}

/** Merges a patch into `AttendanceSession.metadata` without clobbering keys
 * written by other phases. */
export async function mergeSessionMetadata(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: { metadata: true },
  });
  const current =
    row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  await prisma.attendanceSession.update({
    where: { id: sessionId },
    data: { metadata: { ...current, ...patch } as Prisma.InputJsonValue },
  });
}

/** Finalized sessions a student can see, newest first. */
export function listFinalizedAttendanceForStudent(studentId: string, take = 60) {
  return prisma.attendanceRecord.findMany({
    where: { studentId, session: { status: "FINALIZED" } },
    select: {
      id: true,
      finalResult: true,
      isManuallyCorrected: true,
      session: {
        select: {
          id: true,
          sessionDate: true,
          endedAt: true,
          cohort: { select: { name: true } },
          cohortSubject: { select: { subject: { select: { name: true, code: true } } } },
        },
      },
    },
    orderBy: { session: { sessionDate: "desc" } },
    take,
  });
}

export function getStudentByUserId(userId: string) {
  return prisma.student.findUnique({
    where: { userId },
    select: { id: true, institutionId: true, firstName: true, lastName: true, studentCode: true },
  });
}

export function isStudentEnrolledInCohort(studentId: string, cohortId: string): Promise<boolean> {
  return prisma.enrollment
    .findUnique({
      where: { studentId_cohortId: { studentId, cohortId } },
      select: { status: true },
    })
    .then((e) => e?.status === "ACTIVE");
}
