import { prisma } from "@/lib/prisma";
import type { Campus, CampusSummary } from "./types";

/**
 * Every function here takes a required `institutionId` and puts it in the
 * `where`, including the ones that also take a campus id.
 *
 * That is not belt-and-braces. `Campus.id` is a cuid an administrator can read
 * off a URL, and a lookup by id alone would happily return another tenant's
 * campus for the service to then mutate. There is deliberately no
 * `getCampusById(id)` in this file to reach for by mistake — the same shape
 * `modules/institutions/repository.ts` uses for its counts.
 */

export function listCampuses(institutionId: string): Promise<Campus[]> {
  return prisma.campus.findMany({
    where: { institutionId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
}

export function getCampus(institutionId: string, id: string): Promise<Campus | null> {
  return prisma.campus.findFirst({ where: { id, institutionId } });
}

export function findCampusByCode(institutionId: string, code: string): Promise<Campus | null> {
  return prisma.campus.findFirst({ where: { institutionId, code } });
}

/**
 * The list plus, for each row, what is attached to it.
 *
 * One grouped count per related table rather than a per-row query: an
 * institution with a dozen campuses would otherwise cost thirty-seven round
 * trips to render one page. Rows with nothing attached are absent from a
 * `groupBy` result, so the maps below are read with a `?? 0` default — a
 * missing group means zero, not unknown.
 */
export async function listCampusSummaries(institutionId: string): Promise<CampusSummary[]> {
  const [campuses, students, staff, units] = await Promise.all([
    listCampuses(institutionId),
    prisma.student.groupBy({
      by: ["campusId"],
      where: { institutionId, campusId: { not: null } },
      _count: { _all: true },
    }),
    prisma.user.groupBy({
      by: ["campusId"],
      where: { institutionId, campusId: { not: null } },
      _count: { _all: true },
    }),
    prisma.academicUnit.groupBy({
      by: ["campusId"],
      where: { institutionId, campusId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const tally = (rows: Array<{ campusId: string | null; _count: { _all: number } }>) =>
    new Map(rows.map((row) => [row.campusId ?? "", row._count._all]));

  const studentsBy = tally(students);
  const staffBy = tally(staff);
  const unitsBy = tally(units);

  return campuses.map((campus) => ({
    id: campus.id,
    name: campus.name,
    code: campus.code,
    address: campus.address,
    isActive: campus.isActive,
    createdAt: campus.createdAt,
    studentCount: studentsBy.get(campus.id) ?? 0,
    staffCount: staffBy.get(campus.id) ?? 0,
    academicUnitCount: unitsBy.get(campus.id) ?? 0,
  }));
}

export interface CreateCampusData {
  institutionId: string;
  name: string;
  code: string;
  address: string | null;
}

export function createCampus(data: CreateCampusData): Promise<Campus> {
  return prisma.campus.create({ data });
}

export interface UpdateCampusData {
  name?: string;
  code?: string;
  address?: string | null;
  isActive?: boolean;
}

/**
 * Scoped by institution in the `where`, which is why this is `updateMany` and
 * not `update`: `update` requires a unique selector, and `id` alone is one —
 * which would make the institution check decorative. `updateMany` accepts the
 * compound filter and reports how many rows it touched, so a mismatched tenant
 * updates nothing and the service can tell.
 */
export async function updateCampus(
  institutionId: string,
  id: string,
  data: UpdateCampusData,
): Promise<Campus | null> {
  const result = await prisma.campus.updateMany({ where: { id, institutionId }, data });
  if (result.count === 0) return null;
  return getCampus(institutionId, id);
}
