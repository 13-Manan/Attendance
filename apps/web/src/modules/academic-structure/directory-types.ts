import type { AcademicUnitKind, InstitutionType } from "@prisma/client";

/**
 * The administrator-facing shapes for the academic structure.
 *
 * The structure is the shelf everything else is filed on: a class sits in a
 * unit, a student sits in a class, and a register is taken for that class. So
 * these rows carry what is already attached to each unit — that is the number
 * that makes "rename this" and "this one is a mistake" different decisions.
 */

export const MAX_UNIT_NAME = 120;
export const MAX_UNIT_CODE = 40;
/** Sort order is a hand-typed hint, not an index. Small and positive. */
export const MAX_SORT_ORDER = 9999;

/**
 * What to call the structure as a whole, per institution type.
 *
 * The individual kinds are named by the institution's own labels — a school
 * that calls its grades "Standards" says so in settings — but the heading above
 * the list is not one of those, and "Academic units" is nobody's word for it.
 */
export const STRUCTURE_WORDS: Record<
  InstitutionType,
  { title: string; singular: string; plural: string; description: string }
> = {
  SCHOOL: {
    title: "School structure",
    singular: "grade or section",
    plural: "grades and sections",
    description:
      "The grades the school is organised into, and the sections inside them. Classes are created underneath these, one per academic year.",
  },
  COLLEGE: {
    title: "College structure",
    singular: "department, semester or course",
    plural: "departments, semesters and courses",
    description:
      "Departments, the programmes they run, and the semesters inside them. Sections are created underneath these, one per academic year.",
  },
};

/** One unit, with what is already filed under it. */
export interface UnitRow {
  id: string;
  name: string;
  kind: AcademicUnitKind;
  code: string | null;
  sortOrder: number;
  createdAt: Date;
  parentId: string | null;
  parentName: string | null;
  campusId: string | null;
  campusName: string | null;
  /** Classes created under this unit, across every academic year. */
  cohortCount: number;
  /** Units nested directly inside it. */
  childCount: number;
  /** Staff whose department this is. Only ever non-zero on a DEPARTMENT. */
  facultyCount: number;
}

export interface UnitTreeNode extends UnitRow {
  children: UnitTreeNode[];
  /** How deep it sits, so a flat table can still be read as a tree. */
  depth: number;
}

export interface ParentChoice {
  id: string;
  name: string;
  kind: AcademicUnitKind;
  depth: number;
}

export interface UnitCampusChoice {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
}

export interface UnitFormOptions {
  institutionType: InstitutionType;
  /** The kinds this institution type is allowed to build its tree from. */
  allowedKinds: AcademicUnitKind[];
  /** This institution's own word for each kind. */
  labels: Record<AcademicUnitKind, string>;
  parents: ParentChoice[];
  campuses: UnitCampusChoice[];
}

/** A refusal an administrator is meant to read, as opposed to a bug. */
export class AcademicStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcademicStructureError";
  }
}
