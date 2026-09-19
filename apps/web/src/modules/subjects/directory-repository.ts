import { prisma } from "@/lib/prisma";
import type { SubjectPage, SubjectRow } from "./directory-types";
import {
  buildSubjectWhere,
  clampSubjectPage,
  subjectOrderBy,
  subjectPageCount,
  subjectPageSkip,
  SUBJECT_PAGE_SIZE,
  type SubjectFilters,
} from "./directory-filters";

/**
 * Reads for the subject screens.
 *
 * Every function takes a required `institutionId` and puts it in the `where`,
 * including the one that also takes a subject id. `Subject.id` is a cuid an
 * administrator can read off a URL, and a lookup by id alone would return
 * another tenant's subject for the page to render and the form to edit. The
 * existing `getSubjectById` in `repository.ts` belongs to the service layer,
 * where the caller checks the institution itself; it is deliberately not
 * reached for here.
 *
 * There are no writes in this file. Subjects are created and renamed by
 * `service.ts`, which enforces the college-only rule and writes the audit row;
 * a second writer here would let a subject change without one.
 */

const SELECT = {
  id: true,
  code: true,
  name: true,
  createdAt: true,
  _count: { select: { cohortLinks: true } },
} as const;

type Row = {
  id: string;
  code: string;
  name: string;
  createdAt: Date;
  _count: { cohortLinks: number };
};

function toRow(row: Row): SubjectRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt,
    cohortCount: row._count.cohortLinks,
  };
}

/**
 * One page of subjects, narrowed in SQL.
 *
 * The count runs against the same `where` as the rows, so "showing 25 of 214"
 * is 214 of the search rather than 214 of the institution. The two extra counts
 * are what an empty page needs to explain itself: whether the search found
 * nothing or the college has nothing, and how many subjects no class offers.
 */
export async function searchSubjects(
  institutionId: string,
  filters: SubjectFilters,
): Promise<SubjectPage> {
  const where = buildSubjectWhere(institutionId, filters);

  const [total, totalAll, unusedAll] = await Promise.all([
    prisma.subject.count({ where }),
    prisma.subject.count({ where: { institutionId } }),
    prisma.subject.count({ where: { institutionId, cohortLinks: { none: {} } } }),
  ]);

  const page = clampSubjectPage(filters.page, total);
  const rows = (await prisma.subject.findMany({
    where,
    select: SELECT,
    orderBy: subjectOrderBy(filters.sort),
    skip: subjectPageSkip(page),
    take: SUBJECT_PAGE_SIZE,
  })) as Row[];

  return {
    rows: rows.map(toRow),
    total,
    totalAll,
    unusedAll,
    page,
    pageCount: subjectPageCount(total),
    pageSize: SUBJECT_PAGE_SIZE,
  };
}

/**
 * The subject already using a code, if there is one.
 *
 * The database's `@@unique([institutionId, code])` is what actually enforces
 * this; the lookup exists so the refusal can name the subject that has the code
 * rather than report a constraint. Scoped, because two colleges both having
 * PHY301 is normal.
 */
export async function findSubjectByCode(
  institutionId: string,
  code: string,
): Promise<SubjectRow | null> {
  const row = (await prisma.subject.findFirst({
    where: { institutionId, code },
    select: SELECT,
  })) as Row | null;
  return row ? toRow(row) : null;
}

/** One subject. Null if it is not ours. */
export async function getSubjectForInstitution(
  institutionId: string,
  id: string,
): Promise<SubjectRow | null> {
  const row = (await prisma.subject.findFirst({
    where: { id, institutionId },
    select: SELECT,
  })) as Row | null;
  return row ? toRow(row) : null;
}
