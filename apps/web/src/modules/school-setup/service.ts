import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { inviteFaculty, type InvitedFaculty } from "@/modules/faculty/directory-service";
import { getInstitutionType } from "@/modules/institutions/repository";
import * as repo from "./repository";
import {
  pickYear,
  sameName,
  sameSectionName,
  sectionGroupName,
  sectionLabel,
  sectionStatus,
  shortClassLabel,
  validateClassName,
  validateSectionName,
  validateSectionNames,
} from "./policy";
import {
  MAX_SECTIONS,
  SchoolSetupError,
  type ClassDetail,
  type ClassesOverview,
  type ClassSummary,
  type CreatedClass,
  type NewClassContext,
  type NewSectionInput,
  type RemovalCheck,
  type SectionDetail,
  type SectionRow,
  type SectionTeacher,
  type YearChoice,
} from "./types";

/**
 * School academic setup: Academic year → Class → Sections → Teacher.
 *
 * ## What it writes, and what it does not
 *
 * Only rows that already exist in the schema: a GRADE unit for the class, a
 * SECTION unit per section, a cohort per section per year, and a PRIMARY
 * `CohortFaculty` row for the teacher. No migration. A class set up here is
 * the same class every other screen — registers, students, reports — already
 * reads, which is the point: there is one structure, shown more simply.
 *
 * ## Years
 *
 * A class and its sections are reused from year to year; what is new each
 * year is the per-year group, which is what students, registers and teachers
 * attach to. Setting Class 8 up for 2027-28 therefore creates fresh groups
 * under the same class and leaves 2026-27's groups — and every register taken
 * against them — exactly as they were.
 *
 * ## Permissions
 *
 * Existing keys only. Reading is `academicStructure.manage`, the gate on the
 * whole Academic section. Changing the structure needs that and
 * `cohort.manage`; assigning a teacher needs `cohort.manage`, as it does on the
 * Faculty page; adding a teacher's account also needs `user.invite`, checked
 * by `inviteFaculty` itself.
 *
 * ## Concurrency
 *
 * Every structural write runs in one transaction behind a per-school advisory
 * lock (`repo.lockSchoolSetup`), so the duplicate checks and the writes they
 * guard cannot interleave with another administrator's. Removal additionally
 * relies on the foreign keys into a group being RESTRICT: if a student is
 * enrolled in the instant between the check and the delete, Postgres refuses
 * the delete and nothing is lost.
 */

const READ: PermissionKey[] = ["academicStructure.manage"];
const STRUCTURE: PermissionKey[] = ["academicStructure.manage", "cohort.manage"];
const TEACHER: PermissionKey[] = ["cohort.manage"];

const TX_OPTIONS = { timeout: 20_000 };

export interface SchoolSetupDeps {
  institutionType?: (institutionId: string) => Promise<"SCHOOL" | "COLLEGE" | null>;
  invite?: typeof inviteFaculty;
}

function deps(overrides: SchoolSetupDeps) {
  return {
    institutionType: overrides.institutionType ?? getInstitutionType,
    invite: overrides.invite ?? inviteFaculty,
  };
}

type Deps = ReturnType<typeof deps>;
type Tx = Prisma.TransactionClient;

async function requireSchool(
  actor: SessionUser,
  permissions: readonly PermissionKey[],
  d: Deps,
): Promise<string> {
  for (const permission of permissions) requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new SchoolSetupError(
      "This account is not linked to a single school, so it cannot set up classes.",
    );
  }
  if ((await d.institutionType(actor.institutionId)) !== "SCHOOL") {
    throw new SchoolSetupError("Classes and sections are set up this way for schools only.");
  }
  return actor.institutionId;
}

async function requireOpenYear(db: repo.Db, institutionId: string, yearId: string) {
  const year = await repo.getYear(db, institutionId, yearId);
  if (!year) throw new SchoolSetupError("That academic year does not belong to this school.");
  if (!year.isActive) {
    throw new SchoolSetupError(
      `${year.name} is archived, so its classes can't be changed. Restore it on the Academic year page first.`,
    );
  }
  return year;
}

async function requireClass(db: repo.Db, institutionId: string, classId: string) {
  const unit = await repo.getClassUnit(db, institutionId, classId);
  if (!unit) throw new SchoolSetupError("That class does not belong to this school.");
  return unit;
}

async function requireSection(db: repo.Db, institutionId: string, groupId: string) {
  const group = await repo.getGroup(db, institutionId, groupId);
  const classId = group ? repo.classIdOf(group) : null;
  if (!group || !classId) throw new SchoolSetupError("That section does not belong to this school.");
  return { group, classId };
}

/**
 * A teacher is offered, and accepted, only if they are an active member of
 * staff here whose role can confirm a register, and not a student. The
 * refusal says which of those failed, because each has a different fix.
 */
async function requireTeacher(db: repo.Db, institutionId: string, userId: string) {
  const id = userId.trim();
  if (id === "") throw new SchoolSetupError("Choose a teacher.");
  const teacher = await repo.findEligibleTeacher(db, institutionId, id);
  if (teacher) return teacher;
  const user = await repo.findSchoolUser(db, institutionId, id);
  if (!user) throw new SchoolSetupError("That teacher does not belong to this school.");
  if (user.status !== "ACTIVE") {
    throw new SchoolSetupError(
      `${user.name}'s access has been stopped, so they can't be given a section. Restore it on the Faculty page first.`,
    );
  }
  throw new SchoolSetupError(
    `${user.name} can't take attendance with their current role, so they can't be given a section. ` +
      "Change their role on the Faculty page, or choose someone else.",
  );
}

function audit(tx: Tx, actor: SessionUser, institutionId: string, input: {
  action: Parameters<typeof recordAuditLog>[0]["action"];
  entityType: string;
  entityId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}) {
  return recordAuditLog({ ...input, institutionId, actorUserId: actor.userId }, tx);
}

function isForeignKeyRefusal(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function toTeacher(link: repo.GroupRow["facultyLinks"][number]): SectionTeacher {
  return {
    linkId: link.id,
    userId: link.user.id,
    name: link.user.name,
    active: link.user.status === "ACTIVE",
  };
}

function toSectionRow(group: repo.GroupRow): SectionRow {
  const primary = group.facultyLinks.find((link) => link.role === "PRIMARY") ?? null;
  const teacher = primary ? toTeacher(primary) : null;
  return {
    id: group.id,
    name: repo.sectionNameOf(group),
    groupName: group.name,
    teacher,
    otherTeachers: group.facultyLinks.filter((link) => link !== primary).map(toTeacher),
    studentCount: group._count.enrollments,
    status: sectionStatus(teacher),
  };
}

/** Sections in the order the school set them up in, not alphabetically — "Rose, Lily, Iris" is an order. */
function sortedSections(groups: repo.GroupRow[]): SectionRow[] {
  return [...groups]
    .sort((a, b) => {
      const order = (g: repo.GroupRow) => (g.academicUnit.kind === "SECTION" ? g.academicUnit.sortOrder : 0);
      return order(a) - order(b) || a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map(toSectionRow);
}

const byClassName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });

export async function getClassesOverview(
  actor: SessionUser,
  requestedYearId?: string,
  overrides: SchoolSetupDeps = {},
): Promise<ClassesOverview> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, READ, d);

  const [institution, years] = await Promise.all([
    repo.getInstitutionSummary(institutionId),
    repo.listYears(institutionId),
  ]);
  const institutionName = institution?.name ?? "";
  const year = pickYear(years, requestedYearId);
  if (!year) return { institutionName, year: null, years, classes: [], notSetUp: [], otherGroups: 0 };

  const [classUnits, groups] = await Promise.all([
    repo.listClassUnits(prisma, institutionId),
    repo.listYearGroups(prisma, institutionId, year.id),
  ]);

  const byClass = new Map<string, repo.GroupRow[]>();
  let otherGroups = 0;
  for (const group of groups) {
    const classId = repo.classIdOf(group);
    if (!classId) {
      otherGroups += 1;
      continue;
    }
    byClass.set(classId, [...(byClass.get(classId) ?? []), group]);
  }

  const classes: ClassSummary[] = [];
  const idle: { id: string; name: string }[] = [];
  for (const unit of classUnits) {
    const inYear = byClass.get(unit.id);
    if (!inYear) {
      idle.push(unit);
      continue;
    }
    const sections = sortedSections(inYear);
    classes.push({
      id: unit.id,
      name: unit.name,
      sections,
      studentCount: sections.reduce((sum, section) => sum + section.studentCount, 0),
      needsTeacher: sections.filter((section) => section.status !== "ready").length,
    });
  }

  const sectionUnits = await repo.listSectionUnits(
    prisma,
    institutionId,
    idle.map((unit) => unit.id),
  );
  const notSetUp = idle.map((unit) => {
    const names: string[] = [];
    for (const section of sectionUnits) {
      if (section.parentId === unit.id && !names.some((name) => sameSectionName(name, section.name))) {
        names.push(section.name);
      }
    }
    return { id: unit.id, name: unit.name, sectionNames: names };
  });

  return {
    institutionName,
    year,
    years,
    classes: classes.sort(byClassName),
    notSetUp: notSetUp.sort(byClassName),
    otherGroups,
  };
}

/** Null when the class does not exist at this school, so the page can 404. */
export async function getClassDetail(
  actor: SessionUser,
  classId: string,
  requestedYearId?: string,
  overrides: SchoolSetupDeps = {},
): Promise<ClassDetail | null> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, READ, d);

  const unit = await repo.getClassUnit(prisma, institutionId, classId);
  if (!unit) return null;

  const years = await repo.listYears(institutionId);
  const year = pickYear(years, requestedYearId);
  if (!year) {
    throw new SchoolSetupError("Set up an academic year first, then come back to this class.");
  }

  const [groups, teachers] = await Promise.all([
    repo.listClassGroupsInYear(prisma, institutionId, unit.id, year.id),
    repo.listEligibleTeachers(prisma, institutionId),
  ]);

  return { id: unit.id, name: unit.name, year, years, sections: sortedSections(groups), teachers };
}

/**
 * What the Add class form starts from: the year, the staff who can be given a
 * section, and — when setting an existing class up for another year — that
 * class's name and the section names it used before.
 */
export async function getNewClassContext(
  actor: SessionUser,
  requestedYearId?: string,
  fromClassId?: string,
  overrides: SchoolSetupDeps = {},
): Promise<NewClassContext> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, READ, d);

  const [years, teachers] = await Promise.all([
    repo.listYears(institutionId),
    repo.listEligibleTeachers(prisma, institutionId),
  ]);
  const year = pickYear(years, requestedYearId);

  let from: NewClassContext["from"] = null;
  const unit = fromClassId ? await repo.getClassUnit(prisma, institutionId, fromClassId) : null;
  if (unit) {
    const names: string[] = [];
    for (const section of await repo.listSectionUnits(prisma, institutionId, [unit.id])) {
      if (!names.some((name) => sameSectionName(name, section.name))) names.push(section.name);
    }
    from = { id: unit.id, name: unit.name, sectionNames: names };
  }

  return { year, years, teachers, from };
}

/**
 * Why a section can or cannot be removed, in the words the screen shows.
 *
 * All the reasons at once rather than the first: somebody who clears the
 * students and tries again should not then discover the registers.
 */
export function removalCheck(
  blockers: Awaited<ReturnType<typeof repo.countRemovalBlockers>>,
  year: Pick<YearChoice, "name" | "isActive">,
): RemovalCheck {
  const reasons: string[] = [];
  if (!year.isActive) {
    reasons.push(`${year.name} is archived, so its sections are kept as they are.`);
  }
  if (blockers.students > 0) {
    const still =
      blockers.currentStudents < blockers.students
        ? ` (${blockers.currentStudents} still in it)`
        : "";
    reasons.push(
      `${plural(blockers.students, "student has", "students have")} been placed in this section${still}. ` +
        "Their records stay linked to it.",
    );
  }
  if (blockers.registers > 0) {
    reasons.push(
      `Attendance has been taken for this section ${plural(blockers.registers, "time", "times")}, and attendance is never deleted.`,
    );
  }
  if (blockers.subjects > 0) {
    reasons.push(`${plural(blockers.subjects, "subject is", "subjects are")} set up for this section.`);
  }
  if (blockers.externalLinks > 0) {
    reasons.push("It is linked to another system through an integration. Unlink it in Integrations first.");
  }
  return { allowed: reasons.length === 0, reasons };
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

/** Null when the section does not exist at this school, so the page can 404. */
export async function getSectionDetail(
  actor: SessionUser,
  groupId: string,
  overrides: SchoolSetupDeps = {},
): Promise<SectionDetail | null> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, READ, d);

  const group = await repo.getGroup(prisma, institutionId, groupId);
  const classId = group ? repo.classIdOf(group) : null;
  if (!group || !classId) return null;

  const [unit, year, blockers, teachers, otherYears, siblings] = await Promise.all([
    repo.getClassUnit(prisma, institutionId, classId),
    repo.getYear(prisma, institutionId, group.academicSessionId),
    repo.countRemovalBlockers(prisma, institutionId, group.id),
    repo.listEligibleTeachers(prisma, institutionId),
    group.academicUnit.kind === "SECTION"
      ? prisma.cohort.count({ where: { academicUnitId: group.academicUnit.id, id: { not: group.id } } })
      : Promise.resolve(0),
    repo.listClassGroupsInYear(prisma, institutionId, classId, group.academicSessionId),
  ]);
  if (!unit || !year) return null;

  return {
    classId: unit.id,
    className: unit.name,
    year,
    section: toSectionRow(group),
    sharedAcrossYears: otherYears > 0,
    sectionsInYear: siblings.length,
    teachers,
    removal: removalCheck(blockers, year),
  };
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/** A class whose name is, or reads as, one that already exists: "Class 8" beside "Grade 8". */
function findClash(
  classes: readonly { id: string; name: string }[],
  name: string,
  exceptId?: string,
) {
  return classes.find(
    (unit) =>
      unit.id !== exceptId &&
      (sameName(unit.name, name) || sameName(shortClassLabel(unit.name), shortClassLabel(name))),
  );
}

/**
 * Add a class for a year, with its sections and — optionally — their teachers,
 * all or nothing.
 *
 * A class name the school already has is reused rather than duplicated: that
 * is how "Class 8" is set up again for next year. It is refused only if it is
 * already set up for *this* year. A name that merely reads the same as an
 * existing class — "Class 8" beside "Grade 8" — is refused, because to a
 * principal they are the same class and two of them would split its students.
 */
export async function createClass(
  actor: SessionUser,
  input: { yearId: string; className: string; sections: readonly NewSectionInput[] },
  overrides: SchoolSetupDeps = {},
): Promise<CreatedClass> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, STRUCTURE, d);
  const className = validateClassName(input.className);
  const sectionNames = validateSectionNames(input.sections.map((section) => section.name));
  const teacherIds = input.sections.map((section) => section.teacherId?.trim() || null);

  return prisma.$transaction(async (tx) => {
    await repo.lockSchoolSetup(tx, institutionId);
    const year = await requireOpenYear(tx, institutionId, input.yearId);

    const classUnits = await repo.listClassUnits(tx, institutionId);
    let unit = classUnits.find((existing) => sameName(existing.name, className));
    if (unit) {
      const already = await repo.listClassGroupsInYear(tx, institutionId, unit.id, year.id);
      if (already.length > 0) {
        throw new SchoolSetupError(
          `${unit.name} is already set up for ${year.name}. Open it to add or change sections.`,
        );
      }
    } else {
      const clash = findClash(classUnits, className);
      if (clash) {
        throw new SchoolSetupError(
          `This school already has "${clash.name}", which reads as the same class. ` +
            `Set up ${clash.name} instead, or choose a name that can't be mistaken for it.`,
        );
      }
      unit = await tx.academicUnit.create({
        data: { institutionId, campusId: actor.campusId ?? null, kind: "GRADE", name: className },
        select: { id: true, name: true, sortOrder: true },
      });
      await audit(tx, actor, institutionId, {
        action: "academic_unit.created",
        entityType: "AcademicUnit",
        entityId: unit.id,
        afterJson: { kind: "GRADE", name: className },
      });
    }

    const teachers = new Map<string, { id: string; name: string }>();
    for (const id of teacherIds) {
      if (id && !teachers.has(id)) teachers.set(id, await requireTeacher(tx, institutionId, id));
    }

    const existingSections = await repo.listSectionUnits(tx, institutionId, [unit.id]);
    const sectionIds: string[] = [];
    for (const [index, name] of sectionNames.entries()) {
      const sectionUnitId = await sectionUnitFor(tx, actor, institutionId, {
        classId: unit.id,
        yearId: year.id,
        name,
        sortOrder: index,
        existing: existingSections,
      });
      const groupId = await createGroup(tx, actor, institutionId, {
        sectionUnitId,
        yearId: year.id,
        name: sectionGroupName(unit.name, name),
      });
      sectionIds.push(groupId);
      const teacherId = teacherIds[index];
      if (teacherId) await linkTeacher(tx, actor, institutionId, groupId, teacherId, null);
    }

    return { classId: unit.id, sectionIds };
  }, TX_OPTIONS);
}

/**
 * The SECTION unit a new group should hang off: one of this class's existing
 * sections with the same name that is free this year, or a new one. Reusing it
 * is what lets "8-A" in 2027-28 be recognisably the same section as last year.
 */
async function sectionUnitFor(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  input: {
    classId: string;
    yearId: string;
    name: string;
    sortOrder: number;
    existing: Awaited<ReturnType<typeof repo.listSectionUnits>>;
  },
): Promise<string> {
  const reusable = input.existing.find(
    (section) =>
      sameName(section.name, input.name) &&
      !section.cohorts.some((group) => group.academicSessionId === input.yearId),
  );
  if (reusable) {
    // Claimed for this year, so a second section of the same name in the same
    // call cannot pick it up too.
    reusable.cohorts.push({ academicSessionId: input.yearId });
    return reusable.id;
  }
  const created = await tx.academicUnit.create({
    data: {
      institutionId,
      campusId: actor.campusId ?? null,
      parentId: input.classId,
      kind: "SECTION",
      name: input.name,
      sortOrder: input.sortOrder,
    },
    select: { id: true, name: true, parentId: true },
  });
  input.existing.push({ ...created, cohorts: [{ academicSessionId: input.yearId }] });
  await audit(tx, actor, institutionId, {
    action: "academic_unit.created",
    entityType: "AcademicUnit",
    entityId: created.id,
    afterJson: { kind: "SECTION", name: input.name, parentId: input.classId },
  });
  return created.id;
}

async function createGroup(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  input: { sectionUnitId: string; yearId: string; name: string },
): Promise<string> {
  const group = await tx.cohort.create({
    data: {
      institutionId,
      academicUnitId: input.sectionUnitId,
      academicSessionId: input.yearId,
      name: input.name,
    },
    select: { id: true },
  });
  await audit(tx, actor, institutionId, {
    action: "cohort.created",
    entityType: "Cohort",
    entityId: group.id,
    afterJson: { name: input.name, academicUnitId: input.sectionUnitId, academicSessionId: input.yearId },
  });
  return group.id;
}

/** Makes `userId` the section's teacher; `previousRole` is their existing link on it, if any. */
async function linkTeacher(
  tx: Tx,
  actor: SessionUser,
  institutionId: string,
  groupId: string,
  userId: string,
  previousRole: string | null,
) {
  const link = await tx.cohortFaculty.upsert({
    where: { cohortId_userId: { cohortId: groupId, userId } },
    create: { cohortId: groupId, userId, role: "PRIMARY" },
    update: { role: "PRIMARY" },
    select: { id: true },
  });
  await audit(tx, actor, institutionId, {
    action: "cohort_faculty.assigned",
    entityType: "CohortFaculty",
    entityId: link.id,
    beforeJson: previousRole ? { role: previousRole } : undefined,
    afterJson: { cohortId: groupId, userId, role: "PRIMARY" },
  });
}

/**
 * Rename a class.
 *
 * The groups of the year being viewed are renamed with it where their name
 * was the one this screen generated ("8-A" → "VIII-A"); a name somebody typed
 * by hand is theirs and is left alone. Earlier years keep the name they were
 * taught under, which is what their registers print.
 */
export async function renameClass(
  actor: SessionUser,
  input: { classId: string; yearId: string; name: string },
  overrides: SchoolSetupDeps = {},
): Promise<{ name: string }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, STRUCTURE, d);
  const name = validateClassName(input.name);

  await prisma.$transaction(async (tx) => {
    await repo.lockSchoolSetup(tx, institutionId);
    const unit = await requireClass(tx, institutionId, input.classId);
    if (unit.name === name) throw new SchoolSetupError(`The class is already called ${name}.`);

    const clash = findClash(await repo.listClassUnits(tx, institutionId), name, unit.id);
    if (clash) {
      throw new SchoolSetupError(`This school already has "${clash.name}". Choose a different name.`);
    }

    await tx.academicUnit.update({ where: { id: unit.id }, data: { name } });

    const renamed: string[] = [];
    const year = await repo.getYear(tx, institutionId, input.yearId);
    if (year?.isActive) {
      const groups = await repo.listClassGroupsInYear(tx, institutionId, unit.id, year.id);
      for (const group of groups) {
        const section = repo.sectionNameOf(group);
        if (group.academicUnit.kind !== "SECTION") continue;
        if (group.name !== sectionGroupName(unit.name, section)) continue;
        const next = sectionGroupName(name, section);
        await tx.cohort.update({ where: { id: group.id }, data: { name: next } });
        await audit(tx, actor, institutionId, {
          action: "cohort.updated",
          entityType: "Cohort",
          entityId: group.id,
          beforeJson: { name: group.name },
          afterJson: { name: next },
        });
        renamed.push(group.id);
      }
    }

    await audit(tx, actor, institutionId, {
      action: "academic_unit.updated",
      entityType: "AcademicUnit",
      entityId: unit.id,
      beforeJson: { name: unit.name },
      afterJson: { name, renamedCohortIds: renamed },
    });
  }, TX_OPTIONS);

  return { name };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function refuseDuplicateSection(
  className: string,
  yearName: string,
  groups: readonly repo.GroupRow[],
  name: string,
) {
  const clash = groups.find((group) => sameSectionName(repo.sectionNameOf(group), name));
  if (clash) {
    throw new SchoolSetupError(
      `${className} already has a section called "${repo.sectionNameOf(clash)}" in ${yearName}. ` +
        "Section names are compared without regard to capital letters.",
    );
  }
}

export async function addSection(
  actor: SessionUser,
  input: { classId: string; yearId: string; name: string; teacherId?: string },
  overrides: SchoolSetupDeps = {},
): Promise<{ sectionId: string; name: string }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, STRUCTURE, d);
  const name = validateSectionName(input.name);
  const teacherId = input.teacherId?.trim() || null;

  return prisma.$transaction(async (tx) => {
    await repo.lockSchoolSetup(tx, institutionId);
    const unit = await requireClass(tx, institutionId, input.classId);
    const year = await requireOpenYear(tx, institutionId, input.yearId);
    const groups = await repo.listClassGroupsInYear(tx, institutionId, unit.id, year.id);
    if (groups.length >= MAX_SECTIONS) {
      throw new SchoolSetupError(`A class can have at most ${MAX_SECTIONS} sections.`);
    }
    refuseDuplicateSection(unit.name, year.name, groups, name);
    if (teacherId) await requireTeacher(tx, institutionId, teacherId);

    const existing = await repo.listSectionUnits(tx, institutionId, [unit.id]);
    const nextOrder =
      groups.reduce(
        (max, group) => Math.max(max, group.academicUnit.kind === "SECTION" ? group.academicUnit.sortOrder : 0),
        -1,
      ) + 1;
    const sectionUnitId = await sectionUnitFor(tx, actor, institutionId, {
      classId: unit.id,
      yearId: year.id,
      name,
      sortOrder: nextOrder,
      existing,
    });
    const sectionId = await createGroup(tx, actor, institutionId, {
      sectionUnitId,
      yearId: year.id,
      name: sectionGroupName(unit.name, name),
    });
    if (teacherId) await linkTeacher(tx, actor, institutionId, sectionId, teacherId, null);
    return { sectionId, name };
  }, TX_OPTIONS);
}

/**
 * Rename a section for the year it belongs to.
 *
 * If last year's section of the same name is the same row, renaming it in
 * place would rename last year too — so a section shared across years is
 * moved onto a section of the new name instead, and last year keeps "A".
 * Nothing that points at the group (students, registers, teachers) moves:
 * they point at the group, not at the section above it.
 */
export async function renameSection(
  actor: SessionUser,
  input: { sectionId: string; name: string },
  overrides: SchoolSetupDeps = {},
): Promise<{ name: string }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, STRUCTURE, d);
  const name = validateSectionName(input.name);

  await prisma.$transaction(async (tx) => {
    await repo.lockSchoolSetup(tx, institutionId);
    const { group, classId } = await requireSection(tx, institutionId, input.sectionId);
    const unit = await requireClass(tx, institutionId, classId);
    const year = await requireOpenYear(tx, institutionId, group.academicSessionId);

    const oldName = repo.sectionNameOf(group);
    if (oldName === name) throw new SchoolSetupError(`The section is already called ${name}.`);
    const siblings = (await repo.listClassGroupsInYear(tx, institutionId, unit.id, year.id)).filter(
      (other) => other.id !== group.id,
    );
    refuseDuplicateSection(unit.name, year.name, siblings, name);

    if (group.academicUnit.kind !== "SECTION") {
      // Attached straight to the class: the group's own name is the section's.
      await tx.cohort.update({ where: { id: group.id }, data: { name } });
      await audit(tx, actor, institutionId, {
        action: "cohort.updated",
        entityType: "Cohort",
        entityId: group.id,
        beforeJson: { name: group.name },
        afterJson: { name },
      });
      return;
    }

    const sectionUnit = group.academicUnit;
    const sharedWithOtherYears =
      (await tx.cohort.count({ where: { academicUnitId: sectionUnit.id, id: { not: group.id } } })) > 0;

    let sectionUnitId = sectionUnit.id;
    if (sharedWithOtherYears) {
      const existing = await repo.listSectionUnits(tx, institutionId, [unit.id]);
      sectionUnitId = await sectionUnitFor(tx, actor, institutionId, {
        classId: unit.id,
        yearId: year.id,
        name,
        sortOrder: sectionUnit.sortOrder,
        existing,
      });
    } else {
      await tx.academicUnit.update({ where: { id: sectionUnit.id }, data: { name } });
      await audit(tx, actor, institutionId, {
        action: "academic_unit.updated",
        entityType: "AcademicUnit",
        entityId: sectionUnit.id,
        beforeJson: { name: oldName },
        afterJson: { name },
      });
    }

    const nextGroupName =
      group.name === sectionGroupName(unit.name, oldName) ? sectionGroupName(unit.name, name) : group.name;
    if (sectionUnitId !== sectionUnit.id || nextGroupName !== group.name) {
      await tx.cohort.update({
        where: { id: group.id },
        data: { name: nextGroupName, academicUnitId: sectionUnitId },
      });
      await audit(tx, actor, institutionId, {
        action: "cohort.updated",
        entityType: "Cohort",
        entityId: group.id,
        beforeJson: { name: group.name, academicUnitId: sectionUnit.id },
        afterJson: { name: nextGroupName, academicUnitId: sectionUnitId },
      });
    }
  }, TX_OPTIONS);

  return { name };
}

/**
 * Remove a section from a year — only if nothing has ever happened in it.
 *
 * Refused, with every reason, if any student has ever been placed in it, any
 * register taken, any subject set up, or an integration links to it. Its
 * teacher assignment is removed with it. A section or class left with nothing
 * at all under it, in any year, is removed too, so a mistake leaves no trace
 * in the lists; one that still has another year's sections stays.
 */
export async function removeSection(
  actor: SessionUser,
  sectionId: string,
  overrides: SchoolSetupDeps = {},
): Promise<{ classId: string; classRemoved: boolean; name: string }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, STRUCTURE, d);

  try {
    return await prisma.$transaction(async (tx) => {
      await repo.lockSchoolSetup(tx, institutionId);
      const { group, classId } = await requireSection(tx, institutionId, sectionId);
      const unit = await requireClass(tx, institutionId, classId);
      const year = await repo.getYear(tx, institutionId, group.academicSessionId);
      if (!year) throw new SchoolSetupError("That section does not belong to this school.");

      const name = repo.sectionNameOf(group);
      const check = removalCheck(await repo.countRemovalBlockers(tx, institutionId, group.id), year);
      if (!check.allowed) {
        throw new SchoolSetupError(`${sectionLabel(name)} can't be removed. ${check.reasons.join(" ")}`);
      }

      for (const link of group.facultyLinks) {
        await tx.cohortFaculty.delete({ where: { id: link.id } });
        await audit(tx, actor, institutionId, {
          action: "cohort_faculty.removed",
          entityType: "CohortFaculty",
          entityId: link.id,
          beforeJson: { cohortId: group.id, userId: link.user.id, role: link.role },
        });
      }

      await tx.cohort.delete({ where: { id: group.id } });
      await audit(tx, actor, institutionId, {
        action: "cohort.deleted",
        entityType: "Cohort",
        entityId: group.id,
        beforeJson: {
          name: group.name,
          section: name,
          className: unit.name,
          academicUnitId: group.academicUnit.id,
          academicSessionId: year.id,
          yearName: year.name,
        },
      });

      if (group.academicUnit.kind === "SECTION" && !(await repo.unitStillInUse(tx, group.academicUnit.id))) {
        await tx.academicUnit.delete({ where: { id: group.academicUnit.id } });
        await audit(tx, actor, institutionId, {
          action: "academic_unit.deleted",
          entityType: "AcademicUnit",
          entityId: group.academicUnit.id,
          beforeJson: { kind: "SECTION", name, parentId: unit.id },
        });
      }

      let classRemoved = false;
      if (!(await repo.unitStillInUse(tx, unit.id))) {
        await tx.academicUnit.delete({ where: { id: unit.id } });
        await audit(tx, actor, institutionId, {
          action: "academic_unit.deleted",
          entityType: "AcademicUnit",
          entityId: unit.id,
          beforeJson: { kind: "GRADE", name: unit.name },
        });
        classRemoved = true;
      }

      return { classId: unit.id, classRemoved, name };
    }, TX_OPTIONS);
  } catch (error) {
    // The check above ran under the setup lock, but enrolling a student does
    // not take that lock. If one arrived in between, the foreign key refused
    // the delete and the whole transaction — teacher removal included — rolled
    // back. Say so rather than showing a database error.
    if (isForeignKeyRefusal(error)) {
      throw new SchoolSetupError(
        "Something was added to this section while it was being removed, so it has been kept. Reload the page to see what changed.",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Teachers
// ---------------------------------------------------------------------------

/**
 * Give a section its teacher, or change who it is.
 *
 * One teacher per section on this screen: the previous one's assignment is
 * removed in the same transaction, and both halves are audited. Additional
 * teachers, set up from the Faculty page, are left exactly as they were.
 */
export async function setSectionTeacher(
  actor: SessionUser,
  input: { sectionId: string; teacherId: string },
  overrides: SchoolSetupDeps = {},
): Promise<{ teacherName: string; replaced: string[] }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, TEACHER, d);
  if (input.teacherId.trim() === "") throw new SchoolSetupError("Choose a teacher.");

  return prisma.$transaction(async (tx) => {
    await repo.lockSchoolSetup(tx, institutionId);
    const { group } = await requireSection(tx, institutionId, input.sectionId);
    await requireOpenYear(tx, institutionId, group.academicSessionId);
    const teacher = await requireTeacher(tx, institutionId, input.teacherId);

    const primaries = group.facultyLinks.filter((link) => link.role === "PRIMARY");
    const others = primaries.filter((link) => link.user.id !== teacher.id);
    if (primaries.length > 0 && others.length === 0) {
      throw new SchoolSetupError(`${teacher.name} already teaches this section.`);
    }

    for (const link of others) {
      await tx.cohortFaculty.delete({ where: { id: link.id } });
      await audit(tx, actor, institutionId, {
        action: "cohort_faculty.removed",
        entityType: "CohortFaculty",
        entityId: link.id,
        beforeJson: { cohortId: group.id, userId: link.user.id, role: link.role },
      });
    }

    const existing = group.facultyLinks.find((link) => link.user.id === teacher.id);
    await linkTeacher(tx, actor, institutionId, group.id, teacher.id, existing?.role ?? null);
    return { teacherName: teacher.name, replaced: others.map((link) => link.user.name) };
  }, TX_OPTIONS);
}

export async function removeSectionTeacher(
  actor: SessionUser,
  sectionId: string,
  overrides: SchoolSetupDeps = {},
): Promise<{ teacherName: string }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, TEACHER, d);

  return prisma.$transaction(async (tx) => {
    await repo.lockSchoolSetup(tx, institutionId);
    const { group } = await requireSection(tx, institutionId, sectionId);
    await requireOpenYear(tx, institutionId, group.academicSessionId);
    const primaries = group.facultyLinks.filter((link) => link.role === "PRIMARY");
    if (primaries.length === 0) throw new SchoolSetupError("This section has no teacher to remove.");

    for (const link of primaries) {
      await tx.cohortFaculty.delete({ where: { id: link.id } });
      await audit(tx, actor, institutionId, {
        action: "cohort_faculty.removed",
        entityType: "CohortFaculty",
        entityId: link.id,
        beforeJson: { cohortId: group.id, userId: link.user.id, role: link.role },
      });
    }
    return { teacherName: primaries.map((link) => link.user.name).join(", ") };
  }, TX_OPTIONS);
}

/**
 * Add a new teacher's account and give them this section.
 *
 * The account is created by `inviteFaculty` — the one place a staff password
 * is set — with the FACULTY role: enough to teach and take attendance for
 * their own sections and nothing more. Their role can be changed later on the
 * Faculty page.
 *
 * Two steps, not one transaction, because the account and its password come
 * from the Faculty service. If the account is created and the section then
 * cannot be assigned (another administrator removed it a moment earlier),
 * the password is still returned — it is the only time it can be shown — and
 * the result says the assignment did not happen.
 */
export async function inviteTeacherForSection(
  actor: SessionUser,
  input: { sectionId: string; name: string; email: string; employeeCode?: string },
  overrides: SchoolSetupDeps = {},
): Promise<{ invited: InvitedFaculty; assignError: string | null }> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, [...TEACHER, "user.invite"], d);

  const { group } = await requireSection(prisma, institutionId, input.sectionId);
  await requireOpenYear(prisma, institutionId, group.academicSessionId);

  const invited = await d.invite(actor, {
    name: input.name,
    email: input.email,
    employeeCode: input.employeeCode,
    roleKey: "FACULTY",
  });

  try {
    await setSectionTeacher(actor, { sectionId: group.id, teacherId: invited.member.id }, overrides);
    return { invited, assignError: null };
  } catch (error) {
    return {
      invited,
      assignError:
        error instanceof SchoolSetupError
          ? error.message
          : "The account was created, but the section could not be assigned. Try assigning it again.",
    };
  }
}
