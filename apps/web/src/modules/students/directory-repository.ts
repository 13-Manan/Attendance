import { prisma } from "@/lib/prisma";
import {
  buildStudentWhere,
  clampStudentPage,
  studentOrderBy,
  studentPageCount,
  studentPageSkip,
  STUDENT_PAGE_SIZE,
  type StudentFilters,
} from "./directory-filters";
import type {
  CampusChoice,
  CohortChoice,
  StudentClassLink,
  StudentDetail,
  StudentListRow,
  StudentPage,
  StudentStatus,
} from "./directory-types";

/**
 * Reads for the student directory.
 *
 * Every function takes a required `institutionId` and puts it in the `where`,
 * including the ones that also take a student id. That is not belt-and-braces:
 * `Student.id` is a cuid an administrator can read off a URL, and a lookup by
 * id alone would happily return another tenant's child for the page to render.
 * There is deliberately no `getStudentById(id)` added here to reach for by
 * mistake — the existing one in `repository.ts` belongs to the attendance path,
 * where the caller checks the institution itself.
 *
 * There are no writes in this file. Students are created and updated by
 * `service.ts`, which is the single write path for the table and the only place
 * the audit row and the webhook are emitted from; adding a second one here
 * would let a record change without either.
 */

const CLASS_SELECT = {
  id: true,
  status: true,
  enrolledAt: true,
  unenrolledAt: true,
  cohort: {
    select: {
      id: true,
      name: true,
      termLabel: true,
      academicSession: { select: { id: true, name: true, isCurrent: true } },
    },
  },
} as const;

type ClassRow = {
  id: string;
  status: StudentStatus;
  enrolledAt: Date;
  unenrolledAt: Date | null;
  cohort: {
    id: string;
    name: string;
    termLabel: string | null;
    academicSession: { id: string; name: string; isCurrent: boolean };
  };
};

function toClassLink(row: ClassRow): StudentClassLink {
  return {
    enrollmentId: row.id,
    cohortId: row.cohort.id,
    cohortName: row.cohort.name,
    termLabel: row.cohort.termLabel,
    academicSessionId: row.cohort.academicSession.id,
    academicSessionName: row.cohort.academicSession.name,
    academicSessionIsCurrent: row.cohort.academicSession.isCurrent,
    status: row.status,
    enrolledAt: row.enrolledAt,
    unenrolledAt: row.unenrolledAt,
  };
}

const LIST_SELECT = {
  id: true,
  studentCode: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  admissionNumber: true,
  admissionDate: true,
  status: true,
  campusId: true,
  campus: { select: { name: true } },
  enrollments: {
    where: { status: "ACTIVE" as const },
    select: CLASS_SELECT,
    orderBy: { enrolledAt: "desc" as const },
  },
} as const;

type ListRow = {
  id: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  admissionNumber: string | null;
  admissionDate: Date | null;
  status: StudentStatus;
  campusId: string | null;
  campus: { name: string } | null;
  enrollments: ClassRow[];
};

function toListRow(row: ListRow): StudentListRow {
  return {
    id: row.id,
    studentCode: row.studentCode,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    admissionNumber: row.admissionNumber,
    admissionDate: row.admissionDate,
    status: row.status,
    campusId: row.campusId,
    campusName: row.campus?.name ?? null,
    classes: row.enrollments.map(toClassLink),
  };
}

/**
 * One page of the directory, plus the two totals the page needs to explain
 * itself.
 *
 * Three queries, not one: the filtered count, the unfiltered tally by status,
 * and the rows. The tally is what lets the page tell "this institution has no
 * students yet" apart from "nothing matched your search" — two states that
 * produce the same empty table and need opposite words underneath it.
 *
 * The count runs before the rows because the page has to be clamped against it:
 * asking for page 7 of a list that now has two happens every time somebody
 * narrows a filter without clearing the page, and honouring it would show an
 * empty table under a heading that says there are forty results.
 *
 * `scope.cohortId` narrows the tally — not the rows, which the filters decide
 * — to the students currently placed in one class group, for a directory that
 * lists a single section and should say "33 students, 32 on roll" about that
 * section rather than about the whole institution.
 */
export async function searchStudents(
  institutionId: string,
  filters: StudentFilters,
  pageSize: number = STUDENT_PAGE_SIZE,
  scope: { cohortId?: string } = {},
): Promise<StudentPage> {
  const where = buildStudentWhere(institutionId, filters);
  const tallyWhere = scope.cohortId
    ? { institutionId, enrollments: { some: { cohortId: scope.cohortId, status: "ACTIVE" as const } } }
    : { institutionId };

  const [total, tally] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.groupBy({
      by: ["status"],
      where: tallyWhere,
      _count: { _all: true },
    }),
  ]);

  const totalAll = tally.reduce((sum, group) => sum + group._count._all, 0);
  const activeAll = tally.find((group) => group.status === "ACTIVE")?._count._all ?? 0;

  const page = clampStudentPage(filters.page, total, pageSize);
  const rows = (await prisma.student.findMany({
    where,
    select: LIST_SELECT,
    orderBy: studentOrderBy(filters.sort),
    skip: studentPageSkip(page, pageSize),
    take: pageSize,
  })) as ListRow[];

  return {
    rows: rows.map(toListRow),
    total,
    totalAll,
    activeAll,
    page,
    pageCount: studentPageCount(total, pageSize),
    pageSize,
  };
}

/** One student, with every placement they have ever had. Null if not ours. */
export async function getStudentForInstitution(
  institutionId: string,
  id: string,
): Promise<StudentDetail | null> {
  const row = (await prisma.student.findFirst({
    where: { id, institutionId },
    select: { ...LIST_SELECT, createdAt: true, updatedAt: true },
  })) as (ListRow & { createdAt: Date; updatedAt: Date }) | null;

  if (!row) return null;

  // The selection above carries only the current placements, because that is
  // what a list row shows. The history is a second query rather than a second
  // selection of the same relation, which Prisma cannot express. The face
  // tally is a count and never an embedding — nothing on this path reads a
  // face vector.
  const [history, faceSamples] = await Promise.all([
    prisma.enrollment.findMany({
      where: { studentId: id, institutionId },
      select: CLASS_SELECT,
      orderBy: { enrolledAt: "desc" },
    }),
    prisma.faceEmbedding.groupBy({
      by: ["isActive"],
      where: { studentId: id, institutionId },
      _count: { _all: true },
    }),
  ]);

  const faceSampleCount = faceSamples.reduce((sum, group) => sum + group._count._all, 0);
  const activeFaceSampleCount =
    faceSamples.find((group) => group.isActive)?._count._all ?? 0;

  return {
    ...toListRow(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    allClasses: (history as ClassRow[]).map(toClassLink),
    faceSampleCount,
    activeFaceSampleCount,
  };
}

/** The other student holding this code, if there is one. Institution-scoped. */
export function findStudentByCode(
  institutionId: string,
  studentCode: string,
): Promise<{ id: string; firstName: string; lastName: string } | null> {
  return prisma.student.findFirst({
    where: { institutionId, studentCode },
    select: { id: true, firstName: true, lastName: true },
  });
}

/**
 * The classes a student can be placed in.
 *
 * Ordered with the current academic year first, because that is the one a
 * placement almost always belongs to — and a dropdown that opens on last
 * year's sections is how a child ends up on a register nobody reads.
 */
export async function listCohortChoices(institutionId: string): Promise<CohortChoice[]> {
  const rows = await prisma.cohort.findMany({
    where: { institutionId },
    select: {
      id: true,
      name: true,
      termLabel: true,
      academicSession: { select: { id: true, name: true, isCurrent: true, startDate: true } },
    },
    orderBy: [{ academicSession: { startDate: "desc" } }, { name: "asc" }],
    take: 500,
  });

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      termLabel: row.termLabel,
      academicSessionId: row.academicSession.id,
      academicSessionName: row.academicSession.name,
      academicSessionIsCurrent: row.academicSession.isCurrent,
    }))
    .sort((a, b) => {
      if (a.academicSessionIsCurrent !== b.academicSessionIsCurrent) {
        return a.academicSessionIsCurrent ? -1 : 1;
      }
      return 0;
    });
}

/**
 * The campuses a student can belong to.
 *
 * Read here rather than through `modules/campuses/service.ts` because that
 * service gates on `institution.read`, which a clerk who may only admit
 * students does not necessarily hold. The tenancy scope is the same — the
 * institution from the session, in the `where` — and the shape is three
 * columns of a dropdown, not the campus administration screen.
 */
export async function listCampusChoices(institutionId: string): Promise<CampusChoice[]> {
  const rows = await prisma.campus.findMany({
    where: { institutionId },
    select: { id: true, name: true, code: true, isActive: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    take: 200,
  });
  return rows;
}

/** Does this cohort belong to this institution? Checked before a placement. */
export function findCohortForInstitution(
  institutionId: string,
  cohortId: string,
): Promise<{ id: string; name: string } | null> {
  return prisma.cohort.findFirst({
    where: { id: cohortId, institutionId },
    select: { id: true, name: true },
  });
}

/** Does this campus belong to this institution? Checked before it is stored. */
export function findCampusForInstitution(
  institutionId: string,
  campusId: string,
): Promise<{ id: string; name: string; isActive: boolean } | null> {
  return prisma.campus.findFirst({
    where: { id: campusId, institutionId },
    select: { id: true, name: true, isActive: true },
  });
}
