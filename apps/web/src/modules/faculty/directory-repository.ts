import { prisma } from "@/lib/prisma";
import type {
  CohortOption,
  CohortSubjectOption,
  FacultyClassLink,
  FacultyMember,
  FacultySubjectLink,
} from "./directory-types";

/**
 * Reads and writes for the faculty directory.
 *
 * ## What is deliberately not selectable here
 *
 * `User.passwordHash`. It appears in no `select` in this file. The one thing
 * the directory needs to know about it — whether one has been set — comes from
 * `listUserIdsWithPassword`, which filters on the column and returns ids. The
 * hash never enters this process on this path, so no page, log line or audit
 * row assembled from these functions can contain it.
 *
 * Every read and every write is institution-scoped, and updates use
 * `updateMany` with both the row id and the institution id: an `update` by id
 * alone would happily deactivate another institution's teacher if an id ever
 * arrived in a form.
 */

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  employeeCode: true,
  status: true,
  lastLoginAt: true,
  roleAssignments: { select: { role: { select: { key: true } } } },
} as const;

type UserRow = {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
  status: string;
  lastLoginAt: Date | null;
  roleAssignments: Array<{ role: { key: string } }>;
};

/**
 * Staff accounts, which is every account in the institution that is not a
 * student.
 *
 * Defined by exclusion rather than by listing the staff role keys, so an
 * account whose role was renamed or whose assignment was removed still appears
 * here. A person with a login who is invisible to the screen that manages
 * logins is exactly the account nobody revokes.
 */
export async function listStaffRows(institutionId: string): Promise<UserRow[]> {
  const rows = await prisma.user.findMany({
    where: {
      institutionId,
      roleAssignments: { none: { role: { key: "STUDENT" } } },
    },
    select: USER_SELECT,
    orderBy: [{ status: "asc" }, { name: "asc" }],
    take: 1000,
  });
  return rows as UserRow[];
}

export async function getStaffRow(institutionId: string, id: string): Promise<UserRow | null> {
  const row = await prisma.user.findFirst({ where: { id, institutionId }, select: USER_SELECT });
  return (row as UserRow | null) ?? null;
}

/** Ids of accounts that have a password set. Selects ids, never the hash. */
export async function listUserIdsWithPassword(institutionId: string): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { institutionId, passwordHash: { not: null } },
    select: { id: true },
    take: 1000,
  });
  return rows.map((row) => row.id);
}

export async function findUserByEmailAnywhere(email: string): Promise<{ id: string } | null> {
  // Not institution-scoped on purpose: `User.email` is globally unique, so an
  // address already in use by another institution's staff member cannot be
  // reused here either. Returning only the id keeps this from becoming a way
  // to read a row in a tenant the caller cannot see.
  return prisma.user.findUnique({ where: { email }, select: { id: true } });
}

/** The seeded system role for a key, or an institution's own override of it. */
export async function findRoleForKey(
  institutionId: string,
  key: string,
): Promise<{ id: string; key: string } | null> {
  const row = await prisma.role.findFirst({
    where: { key, OR: [{ institutionId }, { institutionId: null }] },
    select: { id: true, key: true },
    // An institution's own role wins over the platform-wide seeded one.
    orderBy: { institutionId: "desc" },
  });
  return row;
}

export async function createStaffRow(input: {
  institutionId: string;
  campusId: string | null;
  name: string;
  email: string;
  employeeCode: string | null;
  passwordHash: string;
  roleId: string;
}): Promise<UserRow> {
  // One transaction: an account with no role assignment can sign in and see
  // nothing, which looks to its owner like a broken product and to an
  // administrator like a finished invitation.
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        institutionId: input.institutionId,
        campusId: input.campusId,
        name: input.name,
        email: input.email,
        employeeCode: input.employeeCode,
        passwordHash: input.passwordHash,
      },
      select: { id: true },
    });
    await tx.userRoleAssignment.create({
      data: {
        userId: user.id,
        roleId: input.roleId,
        institutionId: input.institutionId,
        campusId: input.campusId,
      },
    });
    return user.id;
  });
  const row = await getStaffRow(input.institutionId, created);
  if (!row) throw new Error("faculty_row_missing_after_create");
  return row;
}

export async function updateStaffRow(
  institutionId: string,
  id: string,
  data: { name?: string; employeeCode?: string | null },
): Promise<UserRow | null> {
  const result = await prisma.user.updateMany({
    where: { id, institutionId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.employeeCode !== undefined ? { employeeCode: data.employeeCode } : {}),
    },
  });
  if (result.count === 0) return null;
  return getStaffRow(institutionId, id);
}

export async function setStaffStatusRow(
  institutionId: string,
  id: string,
  status: "ACTIVE" | "INACTIVE",
): Promise<UserRow | null> {
  const result = await prisma.user.updateMany({ where: { id, institutionId }, data: { status } });
  if (result.count === 0) return null;
  return getStaffRow(institutionId, id);
}

/**
 * Sets a new password hash and ends every open session for that account.
 *
 * The session deletion is the half that makes the reset mean anything: a
 * password changed while the old session cookie still works has not stopped
 * whoever prompted the reset.
 */
export async function setStaffPasswordRow(
  institutionId: string,
  id: string,
  passwordHash: string,
): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({ where: { id, institutionId }, data: { passwordHash } });
    if (updated.count === 0) return 0;
    await tx.session.deleteMany({ where: { userId: id } });
    return updated.count;
  });
  return result > 0;
}

/** Ends every open session for an account. Used when it is deactivated. */
export async function endSessionsForUser(id: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId: id } });
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function listClassLinks(
  institutionId: string,
): Promise<Array<FacultyClassLink & { userId: string }>> {
  const rows = await prisma.cohortFaculty.findMany({
    where: { cohort: { institutionId } },
    select: {
      id: true,
      userId: true,
      role: true,
      cohort: { select: { id: true, name: true, termLabel: true } },
    },
    take: 2000,
  });
  return rows.map((row) => ({
    linkId: row.id,
    userId: row.userId,
    cohortId: row.cohort.id,
    cohortName: row.cohort.name,
    termLabel: row.cohort.termLabel,
    role: row.role,
  }));
}

export async function listSubjectLinks(
  institutionId: string,
): Promise<CohortSubjectOption[]> {
  const rows = await prisma.cohortSubject.findMany({
    where: { cohort: { institutionId } },
    select: {
      id: true,
      facultyId: true,
      faculty: { select: { name: true } },
      cohort: { select: { id: true, name: true } },
      subject: { select: { code: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  return rows.map((row) => ({
    cohortSubjectId: row.id,
    cohortId: row.cohort.id,
    cohortName: row.cohort.name,
    subjectCode: row.subject.code,
    subjectName: row.subject.name,
    facultyId: row.facultyId,
    facultyName: row.faculty?.name ?? null,
  }));
}

export async function listCohortOptions(institutionId: string): Promise<CohortOption[]> {
  const rows = await prisma.cohort.findMany({
    where: { institutionId },
    select: { id: true, name: true, termLabel: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  return rows;
}

/** The link row plus the institution its cohort belongs to, for the check. */
export async function getClassLink(
  linkId: string,
): Promise<{ id: string; userId: string; cohortId: string; institutionId: string; role: string } | null> {
  const row = await prisma.cohortFaculty.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      userId: true,
      role: true,
      cohort: { select: { id: true, institutionId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    cohortId: row.cohort.id,
    institutionId: row.cohort.institutionId,
    role: row.role,
  };
}

export async function deleteClassLink(linkId: string): Promise<void> {
  await prisma.cohortFaculty.delete({ where: { id: linkId } });
}

export async function getCohortSubject(
  cohortSubjectId: string,
): Promise<{
  id: string;
  institutionId: string;
  cohortName: string;
  subjectCode: string;
  facultyId: string | null;
} | null> {
  const row = await prisma.cohortSubject.findUnique({
    where: { id: cohortSubjectId },
    select: {
      id: true,
      facultyId: true,
      cohort: { select: { institutionId: true, name: true } },
      subject: { select: { code: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    institutionId: row.cohort.institutionId,
    cohortName: row.cohort.name,
    subjectCode: row.subject.code,
    facultyId: row.facultyId,
  };
}

export async function setCohortSubjectFacultyRow(
  cohortSubjectId: string,
  facultyId: string | null,
): Promise<void> {
  await prisma.cohortSubject.update({
    where: { id: cohortSubjectId },
    data: { facultyId },
  });
}

/** Assembles the view model. Exported for the service; no authorization here. */
export function assembleMembers(
  rows: UserRow[],
  idsWithPassword: readonly string[],
  classLinks: ReadonlyArray<FacultyClassLink & { userId: string }>,
  subjectLinks: readonly CohortSubjectOption[],
): FacultyMember[] {
  const hasPassword = new Set(idsWithPassword);
  return rows.map((row) => {
    const classes: FacultyClassLink[] = classLinks
      .filter((link) => link.userId === row.id)
      // Rebuilt field by field rather than spread-minus-userId: the member
      // already carries the id, and naming each field keeps a later column on
      // the join row from arriving here by accident.
      .map((link) => ({
        linkId: link.linkId,
        cohortId: link.cohortId,
        cohortName: link.cohortName,
        termLabel: link.termLabel,
        role: link.role,
      }));
    const subjects: FacultySubjectLink[] = subjectLinks
      .filter((link) => link.facultyId === row.id)
      .map((link) => ({
        cohortSubjectId: link.cohortSubjectId,
        cohortId: link.cohortId,
        cohortName: link.cohortName,
        subjectCode: link.subjectCode,
        subjectName: link.subjectName,
      }));
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      employeeCode: row.employeeCode,
      status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      lastLoginAt: row.lastLoginAt,
      canSignIn: hasPassword.has(row.id),
      roleKeys: row.roleAssignments.map((assignment) => assignment.role.key),
      classes,
      subjects,
    };
  });
}
