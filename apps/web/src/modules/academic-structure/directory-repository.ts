import { prisma } from "@/lib/prisma";
import type { AcademicUnitKind } from "@prisma/client";
import type { UnitCampusChoice, UnitRow } from "./directory-types";

/**
 * Reads for the structure screens.
 *
 * Every function takes a required `institutionId` and puts it in the `where`,
 * including the one that also takes a unit id. `AcademicUnit.id` is a cuid an
 * administrator can read off a URL, and a lookup by id alone would return
 * another tenant's department for the page to render and the form to edit. The
 * existing `getAcademicUnitById` in `repository.ts` belongs to the service
 * layer, where the caller checks the institution itself; it is deliberately not
 * reached for here.
 *
 * There are no writes in this file. Units are created and renamed by
 * `service.ts`, which enforces the institution-type rule and writes the audit
 * row; a second writer here would let the structure change without one.
 */

const SELECT = {
  id: true,
  name: true,
  kind: true,
  code: true,
  sortOrder: true,
  createdAt: true,
  parentId: true,
  parent: { select: { name: true } },
  campusId: true,
  campus: { select: { name: true } },
  _count: { select: { cohorts: true, children: true, facultyMembers: true } },
} as const;

type Row = {
  id: string;
  name: string;
  kind: AcademicUnitKind;
  code: string | null;
  sortOrder: number;
  createdAt: Date;
  parentId: string | null;
  parent: { name: string } | null;
  campusId: string | null;
  campus: { name: string } | null;
  _count: { cohorts: number; children: number; facultyMembers: number };
};

function toRow(row: Row): UnitRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    code: row.code,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    parentId: row.parentId,
    parentName: row.parent?.name ?? null,
    campusId: row.campusId,
    campusName: row.campus?.name ?? null,
    cohortCount: row._count.cohorts,
    childCount: row._count.children,
    facultyCount: row._count.facultyMembers,
  };
}

/**
 * Every unit in the institution, flat.
 *
 * Read whole rather than paginated, and that is deliberate: this list is a
 * tree, and a tree cannot be cut at row 25 without orphaning what follows. The
 * ceiling is the number of departments and semesters an institution actually
 * has — hundreds, not the hundreds of thousands the class list can reach.
 */
export async function listUnitRows(institutionId: string): Promise<UnitRow[]> {
  const rows = (await prisma.academicUnit.findMany({
    where: { institutionId },
    select: SELECT,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: 2000,
  })) as Row[];
  return rows.map(toRow);
}

/** One unit. Null if it is not ours. */
export async function getUnitForInstitution(
  institutionId: string,
  id: string,
): Promise<UnitRow | null> {
  const row = (await prisma.academicUnit.findFirst({
    where: { id, institutionId },
    select: SELECT,
  })) as Row | null;
  return row ? toRow(row) : null;
}

/**
 * The campuses a unit can be placed at.
 *
 * Closed campuses are included: a grade at a campus that closed last year is
 * still where the attendance was taken, and the form has to be able to show
 * what the unit already says. Whether a closed one should be offered for a new
 * unit is the form's business — it marks them.
 */
export async function listCampusChoicesForUnits(
  institutionId: string,
): Promise<UnitCampusChoice[]> {
  return prisma.campus.findMany({
    where: { institutionId },
    select: { id: true, name: true, code: true, isActive: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    take: 500,
  });
}
