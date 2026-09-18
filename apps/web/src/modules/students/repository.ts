import { prisma } from "@/lib/prisma";
import type { Student } from "./types";

export function getStudentById(id: string): Promise<Student | null> {
  return prisma.student.findUnique({ where: { id } });
}

export function listStudentsByCohort(cohortId: string): Promise<Student[]> {
  return prisma.student.findMany({
    where: { enrollments: { some: { cohortId, status: "ACTIVE" } } },
    orderBy: { lastName: "asc" },
  });
}

/** Institution-wide listing for admin roles (student.read without a cohort
 * scope) — still always institution-scoped, never global. */
export function listStudentsByInstitution(institutionId: string): Promise<Student[]> {
  return prisma.student.findMany({
    where: { institutionId },
    orderBy: { lastName: "asc" },
  });
}
