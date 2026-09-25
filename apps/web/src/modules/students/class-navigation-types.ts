import type { YearChoice } from "@/modules/school-setup/types";

/**
 * The class-first view of the Students screens: Class → Section → students.
 *
 * Nothing here is a new concept. A class is a GRADE academic unit, a section
 * is that class's group for one academic year (a `Cohort`), its class teacher
 * is the group's PRIMARY `CohortFaculty`, and its students are the ones with an
 * ACTIVE enrollment in it — exactly as `modules/school-setup/types.ts` sets
 * them out. These are the same records, counted the way the student directory
 * counts: on roll.
 */

export type { YearChoice };

export interface SectionClassTeacher {
  name: string;
  /** False when their access has been stopped; shown so it can be followed up. */
  active: boolean;
}

export interface StudentSectionSummary {
  /** The section in this year (a `Cohort`): what a student is placed in. */
  id: string;
  /** What the school calls the section: "A", "Rose". */
  name: string;
  /** How it reads on its own: "Section A". */
  label: string;
  /** The name it goes by elsewhere in the product: "2-A". */
  groupName: string;
  /** The PRIMARY teacher, or null when none is assigned. */
  classTeacher: SectionClassTeacher | null;
  /** Students on roll placed in it now. */
  studentCount: number;
}

export interface StudentClassCard {
  /** The class (a GRADE `AcademicUnit`). */
  id: string;
  name: string;
  sectionCount: number;
  /** Distinct students on roll across its sections in the year. */
  studentCount: number;
}

export interface StudentClassesView {
  /** Null when the school has no academic year to show. */
  year: YearChoice | null;
  years: YearChoice[];
  /** Classes with at least one section in the year, in the order a school reads them. */
  classes: StudentClassCard[];
  /** Groups in the year that are not under a class — reachable through the directory's class filter. */
  otherGroups: number;
}

export interface StudentClassView {
  id: string;
  name: string;
  /** Null when the school has no academic year to show the class in. */
  year: YearChoice | null;
  years: YearChoice[];
  sections: StudentSectionSummary[];
  studentCount: number;
}

export interface StudentSectionView {
  classId: string;
  className: string;
  /** The academic year the section belongs to. */
  year: YearChoice;
  section: StudentSectionSummary;
}
