import { prisma } from "@/lib/prisma";
import type { AcademicSession, AcademicSessionSummary } from "./types";

/**
 * Academic years, one institution at a time.
 *
 * Every function that can reach a single row takes the institution id as well
 * as the row id and filters on both, so an id lifted from another tenant's URL
 * matches nothing rather than matching a row. The unscoped
 * `getAcademicSessionById` below is the one exception and is kept only because
 * the pre-existing service path uses it and re-checks the institution itself.
 */

export function getAcademicSessionById(id: string): Promise<AcademicSession | null> {
  return prisma.academicSession.findUnique({ where: { id } });
}

export async function getAcademicSessionForInstitution(
  institutionId: string,
  id: string,
): Promise<AcademicSession | null> {
  const [session] = await prisma.academicSession.findMany({
    where: { id, institutionId },
    take: 1,
  });
  return session ?? null;
}

export function listAcademicSessionsByInstitution(institutionId: string): Promise<AcademicSession[]> {
  return prisma.academicSession.findMany({
    where: { institutionId },
    orderBy: [{ isActive: "desc" }, { startDate: "desc" }],
  });
}

/**
 * The list the sessions page renders: every year, current one first, each with
 * the number of classes hanging off it.
 *
 * The count comes back in the same query rather than in a second pass, because
 * a page that shows ten years must not issue eleven queries to do it.
 */
export async function listAcademicSessionSummaries(
  institutionId: string,
): Promise<AcademicSessionSummary[]> {
  const rows = await prisma.academicSession.findMany({
    where: { institutionId },
    orderBy: [{ isCurrent: "desc" }, { isActive: "desc" }, { startDate: "desc" }],
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      isActive: true,
      isCurrent: true,
      _count: { select: { cohorts: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    isActive: row.isActive,
    isCurrent: row.isCurrent,
    cohortCount: row._count.cohorts,
  }));
}

/** The year this institution is in, or null if nobody has chosen one. */
export function getCurrentAcademicSession(institutionId: string): Promise<AcademicSession | null> {
  return prisma.academicSession.findFirst({
    where: { institutionId, isCurrent: true, isActive: true },
  });
}

/** Used to refuse a duplicate name with a sentence naming the clash. */
export function findAcademicSessionByName(
  institutionId: string,
  name: string,
): Promise<AcademicSession | null> {
  return prisma.academicSession.findFirst({ where: { institutionId, name } });
}

export interface CreateAcademicSessionData {
  institutionId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

export function createAcademicSession(data: CreateAcademicSessionData): Promise<AcademicSession> {
  return prisma.academicSession.create({ data });
}

export interface UpdateAcademicSessionData {
  name?: string;
  startDate?: Date;
  endDate?: Date;
  isActive?: boolean;
  isCurrent?: boolean;
}

export function updateAcademicSession(id: string, data: UpdateAcademicSessionData): Promise<AcademicSession> {
  return prisma.academicSession.update({ where: { id }, data });
}

/**
 * Scoped update. Returns the number of rows changed, which is 0 when the id
 * belongs to another institution — the caller turns that into "does not
 * exist" rather than "forbidden", so this is not an oracle for guessing
 * another tenant's ids.
 */
export async function updateAcademicSessionForInstitution(
  institutionId: string,
  id: string,
  data: UpdateAcademicSessionData,
): Promise<number> {
  const result = await prisma.academicSession.updateMany({
    where: { id, institutionId },
    data,
  });
  return result.count;
}

/**
 * Makes one year the current one and takes that status from every other year
 * in the same institution.
 *
 * In a transaction because the intermediate state — two current years, or
 * none — is one that every enrollment default and every report would read as
 * fact.
 *
 * The target is confirmed to be this institution's *before* anything is
 * cleared. Doing it the other way round would mean an id lifted from another
 * tenant's URL left this institution with no current year at all: the clear
 * would succeed and the set would match nothing. Every statement is scoped to
 * the institution, so nothing here can touch another tenant's rows either.
 *
 * Returns the ids that stopped being current, so the audit row can name them.
 */
export async function setCurrentAcademicSession(
  institutionId: string,
  id: string,
): Promise<{ changed: boolean; unset: string[] }> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.academicSession.findFirst({
      where: { id, institutionId },
      select: { id: true },
    });
    if (!target) return { changed: false, unset: [] };

    const previous = await tx.academicSession.findMany({
      where: { institutionId, isCurrent: true, NOT: { id } },
      select: { id: true },
    });

    if (previous.length > 0) {
      await tx.academicSession.updateMany({
        where: { institutionId, isCurrent: true, NOT: { id } },
        data: { isCurrent: false },
      });
    }

    await tx.academicSession.updateMany({
      where: { id, institutionId },
      // Making a year current un-archives it. The alternative is a year that
      // is both "the year we are in" and "archived", which is not a state
      // anybody can act on.
      data: { isCurrent: true, isActive: true },
    });

    return { changed: true, unset: previous.map((row) => row.id) };
  });
}
