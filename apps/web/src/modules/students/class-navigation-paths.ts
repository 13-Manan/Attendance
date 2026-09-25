/**
 * Where the class-first Students screens live, as data.
 *
 * Pure, so the pages, the create action and the tests build the same URLs.
 * The shape follows the Classes screens under Academic
 * (`/dashboard/academic/classes/[classId]/sections/[sectionId]`): a class and
 * a section are record ids in the path, and the academic year a class is shown
 * for is `?year=` — a section belongs to exactly one year, so its URL needs
 * none.
 */

export const STUDENTS_BASE = "/dashboard/students";
export const STUDENT_CLASSES_BASE = `${STUDENTS_BASE}/classes`;

function yearQuery(yearId: string | null | undefined): string {
  return yearId ? `?year=${encodeURIComponent(yearId)}` : "";
}

export function studentClassesHref(yearId?: string | null): string {
  return `${STUDENT_CLASSES_BASE}${yearQuery(yearId)}`;
}

export function studentClassHref(classId: string, yearId?: string | null): string {
  return `${STUDENT_CLASSES_BASE}/${encodeURIComponent(classId)}${yearQuery(yearId)}`;
}

export function studentSectionHref(classId: string, sectionId: string): string {
  return `${STUDENT_CLASSES_BASE}/${encodeURIComponent(classId)}/sections/${encodeURIComponent(sectionId)}`;
}

/** The Add student form, with this section chosen as the class to place them in. */
export function addStudentToSectionHref(sectionId: string): string {
  return `${STUDENTS_BASE}/new?cohortId=${encodeURIComponent(sectionId)}`;
}

/** A record id as it appears in these paths: a cuid, in practice. */
const ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The section page to go back to after a student is added from it, or null.
 *
 * The value arrives in a form field, so it is a claim, not a destination:
 * only a path of exactly the section-page shape is accepted — no scheme, no
 * host, no query, no `..` — which is what keeps it from ever becoming an open
 * redirect. Whether the section belongs to the person's institution is a
 * separate question, answered by the section page itself when it loads.
 */
export function parseSectionReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prefix = `${STUDENT_CLASSES_BASE}/`;
  if (!value.startsWith(prefix)) return null;
  const parts = value.slice(prefix.length).split("/");
  if (parts.length !== 3 || parts[1] !== "sections") return null;
  const [classId, , sectionId] = parts;
  if (!ID_SEGMENT.test(classId) || !ID_SEGMENT.test(sectionId)) return null;
  return studentSectionHref(classId, sectionId);
}
