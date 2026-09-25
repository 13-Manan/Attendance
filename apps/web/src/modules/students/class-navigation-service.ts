import { prisma } from "@/lib/prisma";
import { hasPermission, requirePermission } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getInstitutionType } from "@/modules/institutions/repository";
import * as setup from "@/modules/school-setup/repository";
import { pickYear, sectionLabel } from "@/modules/school-setup/policy";
import { listOnRollPlacements, type OnRollPlacement } from "./class-navigation-repository";
import { searchStudents } from "./directory-repository";
import { STUDENT_PAGE_SIZE, type StudentFilters } from "./directory-filters";
import { StudentError, type StudentPage } from "./directory-types";
import type {
  StudentClassCard,
  StudentClassView,
  StudentClassesView,
  StudentSectionSummary,
  StudentSectionView,
  YearChoice,
} from "./class-navigation-types";

/**
 * The Students screens, class first: Classes → a class's sections → one
 * section's students.
 *
 * ## Only reads, over the structure that already exists
 *
 * Years, classes, sections and class teachers are read with the queries the
 * Academic → Classes screens use (`modules/school-setup/repository.ts`), and
 * named by the same rules (`modules/school-setup/policy.ts`). A section's
 * students are the student directory itself, narrowed to that section by its
 * existing class filter. Nothing here writes: adding a student to a section is
 * the existing Add student form with the section chosen, and moving one is the
 * existing placement on their record.
 *
 * ## Permissions and tenancy
 *
 * `student.read`, as for the directory, and `cohort.read`, because this shows
 * a school's classes and who teaches them. Every seeded role that can read
 * students can read classes. Every lookup is scoped to the institution in the
 * session: a class or section id copied from another school's URL finds
 * nothing, and a section reached through another class's URL is not that
 * class's section.
 *
 * ## Schools
 *
 * Class → Section is how a school is organised. A college's groups hang off
 * departments and programmes instead, and for one of those this whole view is
 * absent: its Students page is the directory, as before.
 */

export interface ClassNavigationDeps {
  institutionType?: (institutionId: string) => Promise<"SCHOOL" | "COLLEGE" | null>;
  listYears?: (institutionId: string) => Promise<YearChoice[]>;
  listClassUnits?: (institutionId: string) => Promise<Array<{ id: string; name: string }>>;
  getClassUnit?: (institutionId: string, classId: string) => Promise<{ id: string; name: string } | null>;
  listYearGroups?: (institutionId: string, yearId: string) => Promise<setup.GroupRow[]>;
  listClassGroupsInYear?: (
    institutionId: string,
    classId: string,
    yearId: string,
  ) => Promise<setup.GroupRow[]>;
  getGroup?: (institutionId: string, groupId: string) => Promise<setup.GroupRow | null>;
  listOnRollPlacements?: (institutionId: string, cohortIds: readonly string[]) => Promise<OnRollPlacement[]>;
  searchStudents?: typeof searchStudents;
}

function deps(overrides: ClassNavigationDeps) {
  return {
    institutionType: overrides.institutionType ?? getInstitutionType,
    listYears: overrides.listYears ?? setup.listYears,
    listClassUnits:
      overrides.listClassUnits ?? ((institutionId: string) => setup.listClassUnits(prisma, institutionId)),
    getClassUnit:
      overrides.getClassUnit ??
      ((institutionId: string, classId: string) => setup.getClassUnit(prisma, institutionId, classId)),
    listYearGroups:
      overrides.listYearGroups ??
      ((institutionId: string, yearId: string) => setup.listYearGroups(prisma, institutionId, yearId)),
    listClassGroupsInYear:
      overrides.listClassGroupsInYear ??
      ((institutionId: string, classId: string, yearId: string) =>
        setup.listClassGroupsInYear(prisma, institutionId, classId, yearId)),
    getGroup:
      overrides.getGroup ??
      ((institutionId: string, groupId: string) => setup.getGroup(prisma, institutionId, groupId)),
    listOnRollPlacements: overrides.listOnRollPlacements ?? listOnRollPlacements,
    searchStudents: overrides.searchStudents ?? searchStudents,
  };
}

type Deps = ReturnType<typeof deps>;

function requireNavigation(actor: SessionUser): string {
  requirePermission(actor, "student.read");
  requirePermission(actor, "cohort.read");
  if (!actor.institutionId) {
    throw new StudentError(
      "This account is not scoped to a single institution, so it cannot manage students here.",
    );
  }
  return actor.institutionId;
}

/** Whether the class-first view applies: the viewer may use it, and this is a school. */
export async function classNavigationAvailable(
  actor: SessionUser,
  overrides: ClassNavigationDeps = {},
): Promise<boolean> {
  if (!actor.institutionId) return false;
  if (!hasPermission(actor, "student.read") || !hasPermission(actor, "cohort.read")) return false;
  return (await deps(overrides).institutionType(actor.institutionId)) === "SCHOOL";
}

async function requireSchool(actor: SessionUser, d: Deps): Promise<string | null> {
  const institutionId = requireNavigation(actor);
  return (await d.institutionType(institutionId)) === "SCHOOL" ? institutionId : null;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** How many distinct on-roll students each key (a section, or a class) has. */
function tally(placements: readonly OnRollPlacement[], keyOf: (cohortId: string) => string | null) {
  const students = new Map<string, Set<string>>();
  for (const placement of placements) {
    const key = keyOf(placement.cohortId);
    if (key === null) continue;
    const set = students.get(key) ?? new Set<string>();
    set.add(placement.studentId);
    students.set(key, set);
  }
  return (key: string) => students.get(key)?.size ?? 0;
}

/**
 * The class teacher is the group's PRIMARY teacher — the rule the Classes
 * screens use (`toSectionRow` in school-setup), including which one is shown
 * if a group somehow has two: the first, in the order those screens read them.
 */
function toSection(group: setup.GroupRow, studentCount: number): StudentSectionSummary {
  const primary = group.facultyLinks.find((link) => link.role === "PRIMARY") ?? null;
  const name = setup.sectionNameOf(group);
  return {
    id: group.id,
    name,
    label: sectionLabel(name),
    groupName: group.name,
    classTeacher: primary
      ? { name: primary.user.name, active: primary.user.status === "ACTIVE" }
      : null,
    studentCount,
  };
}

/**
 * Sections in the order the school set them up in, as the Classes screens show
 * them (`sortedSections` in school-setup): "Rose, Lily, Iris" is an order.
 */
function inSetupOrder(groups: readonly setup.GroupRow[]): setup.GroupRow[] {
  const order = (group: setup.GroupRow) =>
    group.academicUnit.kind === "SECTION" ? group.academicUnit.sortOrder : 0;
  return [...groups].sort(
    (a, b) => order(a) - order(b) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/** 1st, 2nd … 10th, not 1st, 10th, 2nd — the Classes screens' order. */
const byClassName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The classes of one academic year — the current one unless another is asked
 * for — with how many sections and on-roll students each has. Null when the
 * view does not apply (not a school).
 */
export async function getStudentClassesForRequest(
  actor: SessionUser,
  requestedYearId?: string,
  overrides: ClassNavigationDeps = {},
): Promise<StudentClassesView | null> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, d);
  if (!institutionId) return null;

  const years = await d.listYears(institutionId);
  const year = pickYear(years, requestedYearId);
  if (!year) return { year: null, years, classes: [], otherGroups: 0 };

  const [units, groups] = await Promise.all([
    d.listClassUnits(institutionId),
    d.listYearGroups(institutionId, year.id),
  ]);

  const classOfGroup = new Map<string, string>();
  const sectionsOfClass = new Map<string, number>();
  let otherGroups = 0;
  for (const group of groups) {
    const classId = setup.classIdOf(group);
    if (!classId) {
      otherGroups += 1;
      continue;
    }
    classOfGroup.set(group.id, classId);
    sectionsOfClass.set(classId, (sectionsOfClass.get(classId) ?? 0) + 1);
  }

  const placements = await d.listOnRollPlacements(institutionId, [...classOfGroup.keys()]);
  const studentsInClass = tally(placements, (cohortId) => classOfGroup.get(cohortId) ?? null);

  const classes: StudentClassCard[] = units
    .filter((unit) => sectionsOfClass.has(unit.id))
    .map((unit) => ({
      id: unit.id,
      name: unit.name,
      sectionCount: sectionsOfClass.get(unit.id) ?? 0,
      studentCount: studentsInClass(unit.id),
    }))
    .sort(byClassName);

  return { year, years, classes, otherGroups };
}

/**
 * One class in one academic year: its sections, each with its class teacher
 * and on-roll student count. Null when the class is not this school's (or the
 * view does not apply), so the page can 404.
 */
export async function getStudentClassForRequest(
  actor: SessionUser,
  classId: string,
  requestedYearId?: string,
  overrides: ClassNavigationDeps = {},
): Promise<StudentClassView | null> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, d);
  if (!institutionId) return null;

  const unit = await d.getClassUnit(institutionId, classId);
  if (!unit) return null;

  const years = await d.listYears(institutionId);
  const year = pickYear(years, requestedYearId);
  if (!year) return { id: unit.id, name: unit.name, year: null, years, sections: [], studentCount: 0 };

  const groups = inSetupOrder(await d.listClassGroupsInYear(institutionId, unit.id, year.id));
  const placements = await d.listOnRollPlacements(
    institutionId,
    groups.map((group) => group.id),
  );
  const inSection = tally(placements, (cohortId) => cohortId);
  const inClass = tally(placements, () => unit.id);

  return {
    id: unit.id,
    name: unit.name,
    year,
    years,
    sections: groups.map((group) => toSection(group, inSection(group.id))),
    studentCount: inClass(unit.id),
  };
}

/**
 * One section, reached through its class. Null when either is not this
 * school's, or the section is not that class's.
 */
export async function getStudentSectionForRequest(
  actor: SessionUser,
  classId: string,
  sectionId: string,
  overrides: ClassNavigationDeps = {},
): Promise<StudentSectionView | null> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, d);
  if (!institutionId) return null;
  const view = await sectionView(institutionId, sectionId, d);
  return view && view.classId === classId ? view : null;
}

/**
 * The section a class group is, when it is one: what the Add student form
 * needs to say "adding to 2-A" and to return there. Null for anything that is
 * not a section of a class at this school.
 */
export async function findSectionForRequest(
  actor: SessionUser,
  sectionId: string,
  overrides: ClassNavigationDeps = {},
): Promise<StudentSectionView | null> {
  const d = deps(overrides);
  const institutionId = await requireSchool(actor, d);
  if (!institutionId) return null;
  return sectionView(institutionId, sectionId, d);
}

async function sectionView(
  institutionId: string,
  sectionId: string,
  d: Deps,
): Promise<StudentSectionView | null> {
  const group = await d.getGroup(institutionId, sectionId);
  const classId = group ? setup.classIdOf(group) : null;
  if (!group || !classId) return null;

  const [unit, years, placements] = await Promise.all([
    d.getClassUnit(institutionId, classId),
    d.listYears(institutionId),
    d.listOnRollPlacements(institutionId, [group.id]),
  ]);
  const year = years.find((candidate) => candidate.id === group.academicSessionId);
  if (!unit || !year) return null;

  const onRoll = tally(placements, (cohortId) => cohortId);
  return {
    classId: unit.id,
    className: unit.name,
    year,
    section: toSection(group, onRoll(group.id)),
  };
}

/**
 * One page of a section's students: the student directory, narrowed by its
 * own class filter to this section, with its counts ("33 students, 32 on
 * roll") taken over the section. Everything else — search, status, sort,
 * paging, which students count as "in" a class — is the directory's.
 */
export async function listSectionStudentsForRequest(
  actor: SessionUser,
  sectionId: string,
  filters: StudentFilters,
  overrides: ClassNavigationDeps = {},
): Promise<StudentPage> {
  const institutionId = requireNavigation(actor);
  return deps(overrides).searchStudents(
    institutionId,
    { ...filters, cohortId: sectionId },
    STUDENT_PAGE_SIZE,
    { cohortId: sectionId },
  );
}
