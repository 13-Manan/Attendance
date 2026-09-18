// Pure resource-ownership checks — zero imports, deliberately, so this file
// (and only this file) can be loaded by `node --test` without needing any
// alias resolution or a database. The DB-touching wrappers that call these
// live in ./cohort-access.ts.

export interface CohortFacultyLink {
  userId: string;
  cohortId: string;
  role: "PRIMARY" | "ASSISTANT";
}

/**
 * Is this user faculty (optionally, specifically the PRIMARY / "class
 * teacher") for this cohort? This is what makes "Class Teacher only sees
 * their own class" a real check rather than a role label — a FACULTY or
 * CLASS_TEACHER role grants no cohort access on its own without a matching
 * CohortFaculty row.
 */
export function isFacultyOfCohort(
  links: CohortFacultyLink[],
  userId: string,
  cohortId: string,
  opts?: { requirePrimary?: boolean },
): boolean {
  return links.some(
    (link) =>
      link.userId === userId &&
      link.cohortId === cohortId &&
      (!opts?.requirePrimary || link.role === "PRIMARY"),
  );
}

export interface CohortSubjectFacultyLink {
  facultyId: string | null;
  cohortSubjectId: string;
}

/** Same idea as isFacultyOfCohort, scoped to one subject within a college cohort. */
export function isFacultyOfCohortSubject(
  links: CohortSubjectFacultyLink[],
  userId: string,
  cohortSubjectId: string,
): boolean {
  return links.some((link) => link.facultyId === userId && link.cohortSubjectId === cohortSubjectId);
}
