import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasPermission } from "@/modules/authorization/service";
import { getCohortDetailForRequest } from "@/modules/cohorts/directory-service";
import { parseReturnPath, type ReturnPath } from "@/lib/return-path";
import { getStudentSectionForRequest } from "./class-navigation-service";
import { studentSectionHref } from "./class-navigation-paths";
import { parseStudentFilters, studentFilterQuery } from "./directory-filters";

/**
 * Where a student's record was opened from, when that is a list other than
 * the whole directory — so the record can offer "← Back to Class 8 · Section A"
 * instead of "← Back to Students".
 *
 * Only these lists link to a student with `?returnTo=`: a section's students,
 * and a class's roster under Academic. A value naming anything else is not an
 * origin, and the record leads back to Students, its own parent.
 */
const SECTION = "/dashboard/students/classes/[classId]/sections/[sectionId]";
const COHORT = "/dashboard/academic/cohorts/[cohortId]";
export const STUDENT_RECORD_ORIGINS = [SECTION, COHORT] as const;

export interface RecordOrigin {
  /** The list by the name its own page shows: "Class 8 · Section A". */
  label: string;
  href: string;
}

/** The origin rebuilt from its parsed ids and the query keys its page understands. */
function rebuild(match: ReturnPath): string {
  if (match.pattern === SECTION) {
    // The section's own filters, re-read the way its page reads them — never
    // the class, which that page fixes itself.
    const filters = { ...parseStudentFilters(Object.fromEntries(match.query)), cohortId: "" };
    const section = studentSectionHref(match.params.classId, match.params.sectionId);
    return `${section}${studentFilterQuery(filters)}`;
  }
  return `/dashboard/academic/cohorts/${encodeURIComponent(match.params.cohortId)}`;
}

/**
 * The origin as a path safe to pass on to the record's own pages (Edit, Face
 * enrollment) and to put in a link — rebuilt, never echoed — or null.
 *
 * Checks the shape only. Whether the viewer may open that list, and what it
 * is called, is `resolveStudentOrigin`'s question, asked where it is shown.
 */
export function studentOriginPath(value: unknown): string | null {
  const match = parseReturnPath(value, STUDENT_RECORD_ORIGINS);
  return match ? rebuild(match) : null;
}

/**
 * The origin, named through the same service and checks as its own page, or
 * null: a section that has been removed or is another school's, a roster the
 * viewer may not open, or no origin at all. The record then leads back to
 * Students — a record never fails to show because of where it was opened from.
 */
export async function resolveStudentOrigin(
  user: SessionUser,
  value: unknown,
): Promise<RecordOrigin | null> {
  const match = parseReturnPath(value, STUDENT_RECORD_ORIGINS);
  if (!match) return null;
  const href = rebuild(match);

  try {
    if (match.pattern === SECTION) {
      const view = await getStudentSectionForRequest(
        user,
        match.params.classId,
        match.params.sectionId,
      );
      return view ? { label: `${view.className} · ${view.section.label}`, href } : null;
    }
    if (!hasPermission(user, "cohort.read")) return null;
    const cohort = await getCohortDetailForRequest(user, match.params.cohortId);
    return { label: cohort.name, href };
  } catch {
    return null;
  }
}
