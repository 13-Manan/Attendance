import { prisma } from "@/lib/prisma";
import type { Faculty } from "./types";

export function getFacultyById(id: string): Promise<Faculty | null> {
  return prisma.user.findUnique({ where: { id } });
}

export function listFacultyForCohort(cohortId: string): Promise<Faculty[]> {
  return prisma.user.findMany({
    where: { facultyCohorts: { some: { cohortId } } },
  });
}
