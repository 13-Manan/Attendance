import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { YearChoice } from "./types";

/**
 * Reads and writes for school setup. Every query names the institution, so a
 * row id taken from another school's URL finds nothing rather than something.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The permission a teacher's role has to carry to be offered for a section.
 *
 * "Can confirm a register" is what being a section's teacher means, and the
 * roles that grant it are already decided in RBAC: FACULTY, CLASS_TEACHER and
 * the administrator roles do; ATTENDANCE_OPERATOR — who runs capture for
 * someone else's class — and STUDENT do not. Reading it from the role's
 * permissions rather than listing role keys means an institution that renames
 * or re-seeds a role gets the right answer without a code change.
 */
export const TEACHING_PERMISSION = "attendanceSession.finalize";

/**
 * Serialises structural changes to one school's classes.
 *
 * "Is Class 8 already set up for this year?" and "create it" have to be one
 * step, or two administrators pressing Save together both see "no" and both
 * create it — the schema has no unique constraint that would catch it, and
 * adding one would be a migration over data that may already contain the
 * duplicates it forbids. A transaction-scoped advisory lock keyed on the
 * institution makes the check-then-write atomic per school, releases itself on
 * commit or rollback, and never blocks a different school.
 */
export async function lockSchoolSetup(tx: Prisma.TransactionClient, institutionId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`school-setup:${institutionId}`}))`;
}

export async function getInstitutionSummary(institutionId: string) {
  return prisma.institution.findUnique({
    where: { id: institutionId },
    select: { id: true, name: true, type: true },
  });
}

export async function listYears(institutionId: string): Promise<YearChoice[]> {
  return prisma.academicSession.findMany({
    where: { institutionId },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
      isActive: true,
    },
  });
}

export async function getYear(db: Db, institutionId: string, id: string) {
  return db.academicSession.findFirst({
    where: { id, institutionId },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
      isActive: true,
    },
  });
}

export async function listClassUnits(db: Db, institutionId: string) {
  return db.academicUnit.findMany({
    where: { institutionId, kind: "GRADE" },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, sortOrder: true },
  });
}

export async function getClassUnit(db: Db, institutionId: string, id: string) {
  return db.academicUnit.findFirst({
    where: { id, institutionId, kind: "GRADE" },
    select: { id: true, name: true, sortOrder: true, campusId: true },
  });
}

export async function listSectionUnits(db: Db, institutionId: string, classIds: readonly string[]) {
  if (classIds.length === 0) return [];
  return db.academicUnit.findMany({
    where: { institutionId, kind: "SECTION", parentId: { in: [...classIds] } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      parentId: true,
      cohorts: { select: { academicSessionId: true } },
    },
  });
}

const GROUP_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  academicSessionId: true,
  academicUnit: {
    select: {
      id: true,
      kind: true,
      name: true,
      parentId: true,
      sortOrder: true,
      parent: { select: { id: true, kind: true } },
    },
  },
  facultyLinks: {
    orderBy: { id: "asc" },
    select: { id: true, role: true, user: { select: { id: true, name: true, status: true } } },
  },
  _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
} satisfies Prisma.CohortSelect;

export type GroupRow = Prisma.CohortGetPayload<{ select: typeof GROUP_SELECT }>;

/** Every group in one year, with its teachers and current student count. */
export async function listYearGroups(db: Db, institutionId: string, yearId: string) {
  return db.cohort.findMany({
    where: { institutionId, academicSessionId: yearId },
    orderBy: [{ createdAt: "asc" }],
    select: GROUP_SELECT,
  });
}

export async function getGroup(db: Db, institutionId: string, id: string) {
  return db.cohort.findFirst({ where: { id, institutionId }, select: GROUP_SELECT });
}

/**
 * The class a group belongs to: the unit itself when the group hangs directly
 * off a class, or the unit's parent when it hangs off a section. Null for
 * anything else — a college's programme, a hand-built GENERIC unit.
 */
export function classIdOf(group: GroupRow): string | null {
  const unit = group.academicUnit;
  if (unit.kind === "GRADE") return unit.id;
  if (unit.kind === "SECTION" && unit.parent?.kind === "GRADE") return unit.parent.id;
  return null;
}

/** The section's own name — the section unit's, or the group's for one attached directly to the class. */
export function sectionNameOf(group: GroupRow): string {
  return group.academicUnit.kind === "SECTION" ? group.academicUnit.name : group.name;
}

/** Every group of one class in one year. */
export async function listClassGroupsInYear(
  db: Db,
  institutionId: string,
  classId: string,
  yearId: string,
) {
  return db.cohort.findMany({
    where: {
      institutionId,
      academicSessionId: yearId,
      OR: [
        { academicUnitId: classId },
        { academicUnit: { kind: "SECTION", parentId: classId } },
      ],
    },
    orderBy: [{ createdAt: "asc" }],
    select: GROUP_SELECT,
  });
}

/** Active staff at this school whose role lets them teach a section, and who are not students. */
export async function listEligibleTeachers(db: Db, institutionId: string) {
  return db.user.findMany({
    where: eligibleTeacherWhere(institutionId),
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, email: true },
  });
}

export async function findEligibleTeacher(db: Db, institutionId: string, userId: string) {
  return db.user.findFirst({
    where: { id: userId, ...eligibleTeacherWhere(institutionId) },
    select: { id: true, name: true, email: true },
  });
}

/** Whether somebody exists at this school at all, to tell "not eligible" from "not found". */
export async function findSchoolUser(db: Db, institutionId: string, userId: string) {
  return db.user.findFirst({
    where: { id: userId, institutionId },
    select: { id: true, name: true, status: true },
  });
}

function eligibleTeacherWhere(institutionId: string): Prisma.UserWhereInput {
  return {
    institutionId,
    status: "ACTIVE",
    roleAssignments: {
      some: {
        institutionId,
        role: { permissions: { some: { permission: TEACHING_PERMISSION } } },
      },
      none: { role: { key: "STUDENT" } },
    },
    studentProfile: { is: null },
  };
}

/**
 * Everything that would stop a section being removed.
 *
 * Enrolments of any status count, not only current ones: a student who moved
 * to another section still has this one in their history, and their old
 * registers point at it. External links count because an integration would
 * go on sending records for a section that no longer exists.
 */
export async function countRemovalBlockers(db: Db, institutionId: string, groupId: string) {
  const [students, currentStudents, registers, subjects, externalLinks] = await Promise.all([
    db.enrollment.count({ where: { cohortId: groupId } }),
    db.enrollment.count({ where: { cohortId: groupId, status: "ACTIVE" } }),
    db.attendanceSession.count({ where: { cohortId: groupId } }),
    db.cohortSubject.count({ where: { cohortId: groupId } }),
    db.externalIdentity.count({
      where: { institutionId, entityType: "COHORT", internalId: groupId },
    }),
  ]);
  return { students, currentStudents, registers, subjects, externalLinks };
}

/** Whether a unit is still in use by anything after a group is removed from it. */
export async function unitStillInUse(db: Db, unitId: string): Promise<boolean> {
  const [groups, children, staff] = await Promise.all([
    db.cohort.count({ where: { academicUnitId: unitId } }),
    db.academicUnit.count({ where: { parentId: unitId } }),
    db.user.count({ where: { departmentId: unitId } }),
  ]);
  return groups + children + staff > 0;
}
