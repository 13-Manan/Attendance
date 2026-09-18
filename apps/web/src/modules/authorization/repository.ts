import { prisma } from "@/lib/prisma";

export function getCohortFacultyLink(cohortId: string, userId: string) {
  return prisma.cohortFaculty.findUnique({
    where: { cohortId_userId: { cohortId, userId } },
  });
}

export function getCohortSubjectFacultyLink(cohortSubjectId: string, userId: string) {
  return prisma.cohortSubject.findFirst({
    where: { id: cohortSubjectId, facultyId: userId },
  });
}
