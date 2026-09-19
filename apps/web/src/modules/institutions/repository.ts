import type { InstitutionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Institution } from "./types";

export function getInstitutionById(id: string): Promise<Institution | null> {
  return prisma.institution.findUnique({ where: { id } });
}

/**
 * Just the kind, for chrome that only needs to choose a word.
 *
 * The dashboard layout runs on every staff page and needs one enum value to
 * decide whether the sidebar says "Sections" or "Programs & semesters".
 * Reading the whole row — settings JSON and all — to answer that would put the
 * institution's entire configuration on the path of every single render.
 */
export async function getInstitutionType(id: string): Promise<InstitutionType | null> {
  const row = await prisma.institution.findUnique({ where: { id }, select: { type: true } });
  return row?.type ?? null;
}

/** Name and kind — what the app shell needs to say which tenant you are in. */
export interface InstitutionIdentity {
  name: string;
  type: InstitutionType;
}

/**
 * The same argument as `getInstitutionType`, one field wider.
 *
 * The dashboard layout runs on every staff page and now needs two things: the
 * kind, to choose the sidebar's vocabulary, and the name, to show the user
 * which institution they are operating inside. Two `select`ed columns in one
 * round trip — still not the settings JSON, which nothing in the chrome reads.
 */
export async function getInstitutionIdentity(id: string): Promise<InstitutionIdentity | null> {
  return prisma.institution.findUnique({
    where: { id },
    select: { name: true, type: true },
  });
}

// ---------------------------------------------------------------------------
// Dashboard headline counts
//
// Each is institution-scoped by a required argument — there is no unscoped
// variant to reach for, which is the same shape the cohort-scoped embedding
// lookup uses (modules/recognition-results/repository.ts) and for the same
// reason: a count that spans tenants is not a feature anybody asked for, so
// the function that could produce one should not exist.
// ---------------------------------------------------------------------------

export function countActiveStudents(institutionId: string): Promise<number> {
  return prisma.student.count({ where: { institutionId, status: "ACTIVE" } });
}

/**
 * Staff who can actually sign in — active users holding at least one role
 * assignment in this institution, minus anyone whose account is a student
 * login. A `Student.userId` link is what makes a User a student rather than
 * staff, so excluding it keeps a college's student portal accounts out of the
 * faculty headline.
 */
export function countFacultyUsers(institutionId: string): Promise<number> {
  return prisma.user.count({
    where: {
      institutionId,
      status: "ACTIVE",
      studentProfile: null,
      roleAssignments: { some: { institutionId } },
    },
  });
}

export function countCohorts(institutionId: string): Promise<number> {
  return prisma.cohort.count({ where: { institutionId } });
}
