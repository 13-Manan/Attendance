import { prisma } from "@/lib/prisma";

/**
 * The one read the class-first Students screens add.
 *
 * Everything else they show — years, classes, sections, class teachers — is
 * read through `modules/school-setup/repository.ts`, the queries the Classes
 * screens already use, so the two cannot disagree about what a school's
 * structure is. What those queries do not answer is "how many students on roll
 * are in this section right now", which is what a Students screen counts.
 */

export interface OnRollPlacement {
  cohortId: string;
  studentId: string;
}

/**
 * Every current placement of an on-roll student in these class groups.
 *
 * "Current" and "on roll" are the directory's own meanings: an ACTIVE
 * `Enrollment` (a student taken out of a section is not in it any more) of a
 * student whose status is ACTIVE (one who has left is not counted, even where
 * their placement was never ended). Both rows are required to be this
 * institution's, so an id from another school finds nothing.
 *
 * One query for any number of groups, returning pairs rather than counts: a
 * class's total is its distinct students, and a student briefly placed in two
 * of its sections during a move is one student.
 */
export async function listOnRollPlacements(
  institutionId: string,
  cohortIds: readonly string[],
): Promise<OnRollPlacement[]> {
  if (cohortIds.length === 0) return [];
  return prisma.enrollment.findMany({
    where: {
      institutionId,
      status: "ACTIVE",
      cohortId: { in: [...cohortIds] },
      student: { institutionId, status: "ACTIVE" },
    },
    select: { cohortId: true, studentId: true },
  });
}
