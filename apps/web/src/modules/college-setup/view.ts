import type { Prisma } from "@prisma/client";
import { nameKey, pickSession, sectionLabel, sectionStatus } from "./policy";
import type { GroupRow, UnitRow } from "./repository";
import type {
  CourseRef,
  DepartmentRef,
  SectionRow,
  SectionTeacher,
  SemesterRef,
  SessionChoice,
} from "./types";

/**
 * The college's academic tree in memory, and the small derivations every
 * college page makes from it.
 *
 * Pure: it works over rows `repository.ts` has already read, so a page's
 * query count is fixed however many departments, courses or sections the
 * college has — and every answer here can be tested without a database.
 */

export interface Tree {
  byId: Map<string, UnitRow>;
  children: Map<string, UnitRow[]>;
  departments: UnitRow[];
}

export function buildTree(units: readonly UnitRow[]): Tree {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const children = new Map<string, UnitRow[]>();
  for (const unit of units) {
    if (!unit.parentId) continue;
    children.set(unit.parentId, [...(children.get(unit.parentId) ?? []), unit]);
  }
  const departments = units
    .filter((unit) => unit.kind === "DEPARTMENT")
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
  return { byId, children, departments };
}

export function childrenOf(tree: Tree, unitId: string, kind: UnitRow["kind"]): UnitRow[] {
  return (tree.children.get(unitId) ?? []).filter((unit) => unit.kind === kind);
}

/** The nearest unit at or above this one of the given kind. */
export function ancestorOfKind(tree: Tree, unitId: string, kind: UnitRow["kind"]): UnitRow | null {
  let unit = tree.byId.get(unitId) ?? null;
  const seen = new Set<string>();
  while (unit && !seen.has(unit.id)) {
    if (unit.kind === kind) return unit;
    seen.add(unit.id);
    unit = unit.parentId ? (tree.byId.get(unit.parentId) ?? null) : null;
  }
  return null;
}

/** A department's semesters, in programme order. */
export function semestersOf(tree: Tree, departmentId: string): UnitRow[] {
  return childrenOf(tree, departmentId, "SEMESTER").sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en", { numeric: true }),
  );
}

/** A semester's courses, by code. */
export function coursesOf(tree: Tree, semesterId: string): UnitRow[] {
  return childrenOf(tree, semesterId, "COURSE").sort((a, b) =>
    (a.code ?? a.name).localeCompare(b.code ?? b.name, "en", { numeric: true, sensitivity: "base" }),
  );
}

/** Every course under a department. */
export function departmentCourses(tree: Tree, departmentId: string): UnitRow[] {
  return semestersOf(tree, departmentId).flatMap((semester) => coursesOf(tree, semester.id));
}

/**
 * The units a course's section groups can hang off: its section names, and —
 * for a group set up on the older screens — the course itself.
 */
export function sectionUnitIds(tree: Tree, courseIds: readonly string[]): string[] {
  const ids: string[] = [];
  for (const courseId of courseIds) {
    ids.push(courseId, ...childrenOf(tree, courseId, "SECTION").map((unit) => unit.id));
  }
  return ids;
}

/** The course a section group belongs to, or null if it does not hang off a course. */
export function courseIdOfGroup(tree: Tree, group: Pick<GroupRow, "academicUnitId">): string | null {
  const unit = tree.byId.get(group.academicUnitId);
  if (!unit) return null;
  if (unit.kind === "COURSE") return unit.id;
  if (unit.kind === "SECTION" && unit.parentId && tree.byId.get(unit.parentId)?.kind === "COURSE") {
    return unit.parentId;
  }
  return null;
}

/** The section's own name — the section unit's, or the group's for one hung straight off the course. */
export function sectionNameOfGroup(tree: Tree, group: Pick<GroupRow, "academicUnitId" | "name">): string {
  const unit = tree.byId.get(group.academicUnitId);
  return unit?.kind === "SECTION" ? unit.name : group.name;
}

export function toDepartmentRef(unit: UnitRow): DepartmentRef {
  return { id: unit.id, name: unit.name, code: unit.code };
}

export function toSemesterRef(unit: UnitRow): SemesterRef {
  return { id: unit.id, name: unit.name, number: unit.sortOrder };
}

export function toCourseRef(unit: UnitRow): CourseRef {
  return { id: unit.id, code: unit.code, name: unit.name };
}

// ---------------------------------------------------------------------------
// Department metadata: its head and its current semester
// ---------------------------------------------------------------------------

export function metadataObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, Prisma.JsonValue>) }
    : {};
}

function metadataString(unit: Pick<UnitRow, "metadata">, key: string): string | null {
  const value = metadataObject(unit.metadata)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Who the department names as its head, if anyone. */
export function headUserIdOf(department: Pick<UnitRow, "metadata">): string | null {
  return metadataString(department, "headUserId");
}

/** The department's current semester, if one is set and still one of its semesters. */
export function currentSemesterIdOf(tree: Tree, department: UnitRow): string | null {
  const id = metadataString(department, "currentSemesterId");
  if (!id) return null;
  const semester = tree.byId.get(id);
  return semester?.kind === "SEMESTER" && semester.parentId === department.id ? id : null;
}

/** The metadata with one key set, or removed when `value` is null. Other keys are kept. */
export function withMetadata(
  unit: Pick<UnitRow, "metadata">,
  key: string,
  value: string | null,
): Prisma.InputJsonValue {
  const next = metadataObject(unit.metadata);
  if (value === null) delete next[key];
  else next[key] = value;
  return next as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function toTeacher(link: GroupRow["facultyLinks"][number]): SectionTeacher {
  return { userId: link.user.id, name: link.user.name, active: link.user.status === "ACTIVE" };
}

/** "Section A", or an older group's own name — see `SectionRow.label`. */
export function sectionLabelOfGroup(tree: Tree, group: Pick<GroupRow, "academicUnitId" | "name">): string {
  const unit = tree.byId.get(group.academicUnitId);
  return unit?.kind === "SECTION" ? sectionLabel(unit.name) : group.name;
}

export function toSectionRow(tree: Tree, group: GroupRow): SectionRow {
  const primary = group.facultyLinks.find((link) => link.role === "PRIMARY") ?? null;
  const teacher = primary ? toTeacher(primary) : null;
  return {
    id: group.id,
    name: sectionNameOfGroup(tree, group),
    label: sectionLabelOfGroup(tree, group),
    groupName: group.name,
    teacher,
    studentCount: group._count.enrollments,
    status: sectionStatus(teacher),
  };
}

/** Sections in the order they were set up, not alphabetically. */
export function sortedSectionRows(tree: Tree, groups: readonly GroupRow[]): SectionRow[] {
  const order = (group: GroupRow) => {
    const unit = tree.byId.get(group.academicUnitId);
    return unit?.kind === "SECTION" ? unit.sortOrder : -1;
  };
  return [...groups]
    .sort((a, b) => order(a) - order(b) || a.createdAt.getTime() - b.createdAt.getTime())
    .map((group) => toSectionRow(tree, group));
}

/** The groups of each course, keyed by course id. */
export function groupsByCourse(tree: Tree, groups: readonly GroupRow[]): Map<string, GroupRow[]> {
  const byCourse = new Map<string, GroupRow[]>();
  for (const group of groups) {
    const courseId = courseIdOfGroup(tree, group);
    if (!courseId) continue;
    byCourse.set(courseId, [...(byCourse.get(courseId) ?? []), group]);
  }
  return byCourse;
}

/** The link that carries a group's course onto its registers: the subject with the course's code. */
export function courseSubjectLink(
  group: Pick<GroupRow, "subjects">,
  courseCode: string | null,
): GroupRow["subjects"][number] | null {
  if (!courseCode) return null;
  const key = nameKey(courseCode);
  return group.subjects.find((link) => nameKey(link.subject.code) === key) ?? null;
}

/** Distinct students across a set of groups. */
export function distinctStudents(
  placements: readonly { studentId: string; cohortId: string }[],
  groupIds: ReadonlySet<string>,
): number {
  const students = new Set<string>();
  for (const placement of placements) {
    if (groupIds.has(placement.cohortId)) students.add(placement.studentId);
  }
  return students.size;
}

export { pickSession };
export type { SessionChoice };
