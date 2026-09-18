import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getCohortFacultyLink, getCohortSubjectFacultyLink } from "./repository";
import { hasPermission } from "./service";
import { ForbiddenError } from "./types";

/**
 * DB-backed wrapper used by Server Actions/Route Handlers. Admins with
 * cohort.manage bypass the ownership check entirely; everyone else must
 * have a matching CohortFaculty row. The pure predicate this wraps
 * (isFacultyOfCohort) lives in ./ownership.ts, kept import-free so it can be
 * unit-tested without a database.
 */
export async function requireCohortAccess(
  user: SessionUser,
  cohortId: string,
  opts?: { requirePrimary?: boolean },
): Promise<void> {
  if (hasPermission(user, "cohort.manage")) return;

  const link = await getCohortFacultyLink(cohortId, user.userId);
  if (!link || (opts?.requirePrimary && link.role !== "PRIMARY")) {
    throw new ForbiddenError("not_cohort_faculty");
  }
}

export async function requireCohortSubjectAccess(
  user: SessionUser,
  cohortSubjectId: string,
): Promise<void> {
  if (hasPermission(user, "cohort.manage")) return;

  const link = await getCohortSubjectFacultyLink(cohortSubjectId, user.userId);
  if (!link) {
    throw new ForbiddenError("not_subject_faculty");
  }
}
