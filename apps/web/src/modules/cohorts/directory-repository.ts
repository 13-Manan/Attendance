import { prisma } from "@/lib/prisma";
import {
  buildCohortWhere,
  clampCohortPage,
  cohortOrderBy,
  cohortPageCount,
  cohortPageSkip,
  COHORT_PAGE_SIZE,
  type CohortFilters,
} from "./directory-filters";
import type {
  CohortDetail,
  CohortListRow,
  CohortPage,
  CohortSubjectRow,
  CohortTeacher,
  SessionChoice,
  StaffChoice,
  SubjectChoice,
  UnitChoice,
} from "./directory-types";
import type { AcademicUnitKind, CohortFacultyRole, EnrollmentStatus } from "@prisma/client";

/**
 * Reads for the class list.
 *
 * Every function takes a required `institutionId` and puts it in the `where`,
 * including the ones that also take a cohort id. That is not belt-and-braces:
 * `Cohort.id` is a cuid an administrator can read off a URL, and a lookup by id
 * alone would return another tenant's class — with its roster — for the page to
 * render. The existing `getCohortById` in `repository.ts` belongs to the
 * attendance path, where the caller checks the institution itself; it is
 * deliberately not reached for here.
 *
 * There are no writes in this file. Cohorts are created and renamed by
 * `service.ts`, teachers are attached there and detached by
 * `modules/faculty/directory-service.ts`, and subjects are attached by
 * `modules/subjects/service.ts`. Each of those writes its own audit row; a
 * second writer here would let a class change without one.
 */

const LIST_SELECT = {
  id: true,
  name: true,
  termLabel: true,
  createdAt: true,
  academicUnitId: true,
  academicSessionId: true,
  academicUnit: {
    select: {
      name: true,
      kind: true,
      code: true,
      campus: { select: { name: true } },
    },
  },
  academicSession: {
    select: { name: true, isCurrent: true, startDate: true },
  },
  facultyLinks: {
    select: {
      id: true,
      role: true,
      user: { select: { id: true, name: true, email: true, status: true } },
    },
  },
  _count: { select: { subjects: true } },
} as const;

type ListRow = {
  id: string;
  name: string;
  termLabel: string | null;
  createdAt: Date;
  academicUnitId: string;
  academicSessionId: string;
  academicUnit: {
    name: string;
    kind: AcademicUnitKind;
    code: string | null;
    campus: { name: string } | null;
  };
  academicSession: { name: string; isCurrent: boolean; startDate: Date };
  facultyLinks: Array<{
    id: string;
    role: CohortFacultyRole;
    user: { id: string; name: string; email: string; status: string };
  }>;
  _count: { subjects: number };
};

/**
 * Class teachers before additional ones, then by name.
 *
 * The first line of the cell is the person whose class it is, which is the one
 * fact somebody scanning the list is looking for.
 */
function toTeachers(links: ListRow["facultyLinks"]): CohortTeacher[] {
  return links
    .map((link) => ({
      linkId: link.id,
      userId: link.user.id,
      name: link.user.name,
      email: link.user.email,
      accountStatus: link.user.status,
      role: link.role,
    }))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "PRIMARY" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function toListRow(row: ListRow, studentCount: number): CohortListRow {
  return {
    id: row.id,
    name: row.name,
    termLabel: row.termLabel,
    createdAt: row.createdAt,
    academicUnitId: row.academicUnitId,
    academicUnitName: row.academicUnit.name,
    academicUnitKind: row.academicUnit.kind,
    academicUnitCode: row.academicUnit.code,
    campusName: row.academicUnit.campus?.name ?? null,
    academicSessionId: row.academicSessionId,
    academicSessionName: row.academicSession.name,
    academicSessionIsCurrent: row.academicSession.isCurrent,
    academicSessionStartDate: row.academicSession.startDate,
    studentCount,
    teachers: toTeachers(row.facultyLinks),
    subjectCount: row._count.subjects,
  };
}

/**
 * How many students are on roll in each of these classes.
 *
 * A separate grouped count rather than `_count: { enrollments: true }`, because
 * that would count every enrollment ever made — including the students who
 * moved out of the class — and a class of nineteen would show thirty-one.
 * Scoped by institution as well as by the ids, so it cannot be widened by an id
 * that came from somewhere else.
 */
async function countStudents(
  institutionId: string,
  cohortIds: string[],
): Promise<Map<string, number>> {
  if (cohortIds.length === 0) return new Map();
  const groups = await prisma.enrollment.groupBy({
    by: ["cohortId"],
    where: { institutionId, cohortId: { in: cohortIds }, status: "ACTIVE" },
    _count: { _all: true },
  });
  return new Map(groups.map((group) => [group.cohortId, group._count._all]));
}

/**
 * One page of the list, plus the two totals the page needs to explain itself.
 *
 * The unfiltered totals are what let the page tell "this institution has no
 * classes yet" apart from "nothing matched your search" — two states that
 * produce the same empty table and need opposite words underneath it.
 *
 * The count runs before the rows because the page has to be clamped against it.
 */
export async function searchCohorts(
  institutionId: string,
  filters: CohortFilters,
  pageSize: number = COHORT_PAGE_SIZE,
): Promise<CohortPage> {
  const where = buildCohortWhere(institutionId, filters);

  const [total, totalAll, currentYearAll] = await Promise.all([
    prisma.cohort.count({ where }),
    prisma.cohort.count({ where: { institutionId } }),
    prisma.cohort.count({ where: { institutionId, academicSession: { isCurrent: true } } }),
  ]);

  const page = clampCohortPage(filters.page, total, pageSize);
  const rows = (await prisma.cohort.findMany({
    where,
    select: LIST_SELECT,
    orderBy: cohortOrderBy(filters.sort),
    skip: cohortPageSkip(page, pageSize),
    take: pageSize,
  })) as ListRow[];

  const counts = await countStudents(
    institutionId,
    rows.map((row) => row.id),
  );

  return {
    rows: rows.map((row) => toListRow(row, counts.get(row.id) ?? 0)),
    total,
    totalAll,
    currentYearAll,
    page,
    pageCount: cohortPageCount(total, pageSize),
    pageSize,
  };
}

/** One class, with its roster and its subjects. Null if it is not ours. */
export async function getCohortForInstitution(
  institutionId: string,
  id: string,
): Promise<CohortDetail | null> {
  const row = (await prisma.cohort.findFirst({
    where: { id, institutionId },
    select: LIST_SELECT,
  })) as ListRow | null;

  if (!row) return null;

  const [roster, pastRosterCount, subjects, attendanceSessionCount] = await Promise.all([
    prisma.enrollment.findMany({
      where: { institutionId, cohortId: id, status: "ACTIVE" },
      select: {
        id: true,
        status: true,
        student: {
          select: { id: true, studentCode: true, firstName: true, lastName: true },
        },
      },
      orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
      take: 500,
    }),
    prisma.enrollment.count({
      where: { institutionId, cohortId: id, status: { not: "ACTIVE" } },
    }),
    prisma.cohortSubject.findMany({
      where: { cohortId: id, cohort: { institutionId } },
      select: {
        id: true,
        subject: { select: { id: true, code: true, name: true } },
        faculty: { select: { id: true, name: true } },
      },
      orderBy: { subject: { code: "asc" } },
      take: 200,
    }),
    prisma.attendanceSession.count({ where: { institutionId, cohortId: id } }),
  ]);

  const subjectRows: CohortSubjectRow[] = subjects.map((offering) => ({
    cohortSubjectId: offering.id,
    subjectId: offering.subject.id,
    code: offering.subject.code,
    name: offering.subject.name,
    facultyId: offering.faculty?.id ?? null,
    facultyName: offering.faculty?.name ?? null,
  }));

  return {
    ...toListRow(row, roster.length),
    roster: roster.map((entry) => ({
      enrollmentId: entry.id,
      studentId: entry.student.id,
      studentCode: entry.student.studentCode,
      firstName: entry.student.firstName,
      lastName: entry.student.lastName,
      status: entry.status as EnrollmentStatus,
    })),
    pastRosterCount,
    subjects: subjectRows,
    attendanceSessionCount,
  };
}

/**
 * The places in the structure a class can sit.
 *
 * Every unit, not only the leaves: a school with no sections puts its classes
 * straight on the GRADE, and a college puts a section under a SEMESTER. Which
 * kinds exist at all is the institution type's business, enforced when the unit
 * itself is created.
 */
export async function listUnitChoices(institutionId: string): Promise<UnitChoice[]> {
  const rows = await prisma.academicUnit.findMany({
    where: { institutionId },
    select: {
      id: true,
      name: true,
      kind: true,
      code: true,
      campus: { select: { name: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: 1000,
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    code: row.code,
    campusName: row.campus?.name ?? null,
  }));
}

/**
 * The academic years a class can belong to.
 *
 * The current year first, because that is the one a new class almost always
 * belongs to — a dropdown that opens on last year is how a class ends up in a
 * year nobody is taking registers for.
 */
export async function listSessionChoices(institutionId: string): Promise<SessionChoice[]> {
  const rows = await prisma.academicSession.findMany({
    where: { institutionId },
    select: { id: true, name: true, isCurrent: true, isActive: true, startDate: true },
    orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isCurrent: row.isCurrent,
    isActive: row.isActive,
  }));
}

/**
 * Who can be put in front of a class.
 *
 * Active accounts only, and read here rather than through
 * `modules/faculty/directory-service.ts` because that gates on
 * `institution.read` — which somebody who may only manage classes does not
 * necessarily hold. The tenancy scope is the same: the institution from the
 * session, in the `where`. A stopped account is left out on purpose; the
 * service that actually writes the assignment refuses one too.
 */
export async function listStaffChoices(institutionId: string): Promise<StaffChoice[]> {
  const rows = await prisma.user.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }],
    take: 500,
  });
  return rows;
}

/** The subjects that can be offered to a class. College institutions only. */
export async function listSubjectChoices(institutionId: string): Promise<SubjectChoice[]> {
  const rows = await prisma.subject.findMany({
    where: { institutionId },
    select: { id: true, code: true, name: true },
    orderBy: [{ code: "asc" }],
    take: 1000,
  });
  return rows;
}
