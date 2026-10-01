import { prisma } from "@/lib/prisma";
import type { SessionStatus } from "@/modules/sessions/types";
import type { AcademicYearFlags } from "./policy";

/**
 * Reads for the Today card. Every one is scoped to the institution in the
 * query itself, and the user id always comes from the server session — there
 * is no argument here a browser could fill in.
 */

export interface TeachingLinkRow {
  cohortId: string;
  role: "PRIMARY" | "ASSISTANT";
  cohort: {
    id: string;
    name: string;
    termLabel: string | null;
    institutionId: string;
    academicSession: AcademicYearFlags;
  };
}

/** The classes a teacher is linked to as faculty — the link capture itself requires. */
export function listTeachingLinks(userId: string, institutionId: string): Promise<TeachingLinkRow[]> {
  return prisma.cohortFaculty.findMany({
    where: { userId, cohort: { institutionId } },
    select: {
      cohortId: true,
      role: true,
      cohort: {
        select: {
          id: true,
          name: true,
          termLabel: true,
          institutionId: true,
          academicSession: { select: { isActive: true, isCurrent: true } },
        },
      },
    },
  });
}

/** Whether the institution has marked an academic year as the current one. */
export async function institutionHasCurrentYear(institutionId: string): Promise<boolean> {
  const count = await prisma.academicSession.count({
    where: { institutionId, isCurrent: true, isActive: true },
  });
  return count > 0;
}

export interface TaughtSubjectRow {
  id: string;
  cohortId: string;
  subject: { name: string; code: string };
}

/**
 * The subjects a teacher is the assigned faculty for, within classes they are
 * also linked to — the two links a college register needs to be started and
 * captured.
 */
export function listTaughtSubjects(
  userId: string,
  institutionId: string,
  cohortIds: string[],
): Promise<TaughtSubjectRow[]> {
  if (cohortIds.length === 0) return Promise.resolve([]);
  return prisma.cohortSubject.findMany({
    where: { facultyId: userId, cohortId: { in: cohortIds }, cohort: { institutionId } },
    select: { id: true, cohortId: true, subject: { select: { name: true, code: true } } },
  });
}

/** Active enrollments per class — the number Start reports as "enrolled". */
export async function countActiveStudents(cohortIds: string[]): Promise<Map<string, number>> {
  if (cohortIds.length === 0) return new Map();
  const rows = await prisma.enrollment.groupBy({
    by: ["cohortId"],
    where: { cohortId: { in: cohortIds }, status: "ACTIVE" },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.cohortId, row._count._all]));
}

export interface TodaySessionRow {
  id: string;
  cohortId: string;
  cohortSubjectId: string | null;
  status: SessionStatus;
  startedAt: Date;
}

/**
 * Registers opened in the window and not discarded — the same test
 * `findExistingDailySession` applies when Start decides whether to resume.
 * Newest first, so a stray duplicate never hides the live one.
 */
export function listSessionsBetween(
  institutionId: string,
  cohortIds: string[],
  start: Date,
  end: Date,
): Promise<TodaySessionRow[]> {
  if (cohortIds.length === 0) return Promise.resolve([]);
  return prisma.attendanceSession.findMany({
    where: {
      institutionId,
      cohortId: { in: cohortIds },
      sessionDate: { gte: start, lt: end },
      status: { not: "CANCELLED" },
    },
    select: { id: true, cohortId: true, cohortSubjectId: true, status: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
}
