// Where a college course page sits, as its breadcrumb and its way back.
//
// Pure, like `components/nav/trail.ts`, so the decision can be tested without
// rendering: which crumbs a course, a section or a page below a section shows,
// and where "← Back to …" leads.
//
// An administrator walks the college from the top — Departments, the
// department, the semester, the course. A head of department has one
// department and starts from Courses, so their trail is Courses → Physics →
// Section A → Aman Kumar, and the department and semester are named in each
// page's heading instead.

import type { BackTarget, TrailCrumb } from "@/components/nav/trail";
import { sectionFullName } from "@/modules/college-setup/policy";

export const COURSES_PATH = "/dashboard/college/courses";
const DEPARTMENTS_PATH = "/dashboard/college/departments";

/** "PHY401 · Physics", or just the name for a course with no code yet. */
export function courseTitle(course: { code: string | null; name: string }): string {
  if (!course.code) return course.name;
  return course.name.toUpperCase().startsWith(course.code.toUpperCase()) ? course.name : `${course.code} · ${course.name}`;
}

export interface CourseTrailInput {
  viewer: "admin" | "hod";
  /** The Courses page, keeping the session being viewed. */
  coursesHref?: string;
  department: { name: string; href: string };
  semester: { name: string; href: string };
  course: { name: string; code: string | null; href: string };
  /** On a section's page and every page below it. */
  section?: { label: string; href: string };
  /** A page below the section: "Add students", "New student", a student's name. */
  leaf?: string;
}

export interface CollegeTrail {
  items: TrailCrumb[];
  /** Absent when the way back is simply the crumb one level up. */
  back?: BackTarget;
}

export function courseTrail(input: CourseTrailInput): CollegeTrail {
  const { viewer, department, semester, course, section, leaf } = input;
  const items: TrailCrumb[] =
    viewer === "hod"
      ? [
          { label: "Courses", href: input.coursesHref ?? COURSES_PATH },
          { label: course.name, href: course.href },
        ]
      : [
          { label: "Departments", href: DEPARTMENTS_PATH },
          { label: department.name, href: department.href },
          { label: semester.name, href: semester.href },
          { label: courseTitle(course), href: course.href },
        ];
  if (section) items.push({ label: section.label, href: section.href });
  if (leaf) items.push({ label: leaf });
  // The page being shown is named, not linked.
  items[items.length - 1] = { label: items[items.length - 1].label };

  // Below a section the way back names it in full — "Physics — Section A" —
  // since "Back to Section A" alone does not say which course.
  if (section && leaf) {
    return { items, back: { label: sectionFullName(course.name, section.label), href: section.href } };
  }
  return { items };
}

export interface DepartmentTrailInput {
  viewer: "admin" | "hod";
  department: { name: string; href: string };
  /** The department's Faculty or Students page. */
  list: { label: "Faculty" | "Students"; href: string };
  /** A page below the list: a person, "Add student". */
  leaf?: { label: string; href?: string };
  /** A page below a person: "Face enrollment". */
  subleaf?: string;
}

/**
 * A department's Faculty and Students pages and the pages below them. A head
 * of department reaches them from the sidebar — Faculty, Students — so their
 * trail starts there; an administrator walks down from Departments.
 */
export function departmentTrail(input: DepartmentTrailInput): CollegeTrail {
  const items: TrailCrumb[] =
    input.viewer === "hod"
      ? [{ label: input.list.label, href: input.list.href }]
      : [
          { label: "Departments", href: DEPARTMENTS_PATH },
          { label: input.department.name, href: input.department.href },
          { label: input.list.label, href: input.list.href },
        ];
  if (input.leaf) items.push({ label: input.leaf.label, href: input.leaf.href });
  if (input.subleaf) items.push({ label: input.subleaf });
  // The page being shown is named, not linked.
  items[items.length - 1] = { label: items[items.length - 1].label };
  return { items };
}
