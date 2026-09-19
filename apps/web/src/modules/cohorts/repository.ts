import { prisma } from "@/lib/prisma";
import type { Cohort, CohortFaculty, CohortFacultyRole } from "./types";

export function getCohortById(id: string): Promise<Cohort | null> {
  return prisma.cohort.findUnique({ where: { id } });
}

export function listCohortsByInstitution(institutionId: string): Promise<Cohort[]> {
  return prisma.cohort.findMany({
    where: { institutionId },
    orderBy: [{ createdAt: "desc" }],
  });
}

export function listCohortsForFaculty(userId: string): Promise<Cohort[]> {
  return prisma.cohort.findMany({
    where: { facultyLinks: { some: { userId } } },
    orderBy: [{ createdAt: "desc" }],
  });
}

export function listCohortFaculty(cohortId: string): Promise<CohortFaculty[]> {
  return prisma.cohortFaculty.findMany({ where: { cohortId } });
}

export interface CreateCohortData {
  institutionId: string;
  academicUnitId: string;
  academicSessionId: string;
  name: string;
  termLabel?: string | null;
}

export function createCohort(data: CreateCohortData): Promise<Cohort> {
  return prisma.cohort.create({
    data: {
      institutionId: data.institutionId,
      academicUnitId: data.academicUnitId,
      academicSessionId: data.academicSessionId,
      name: data.name,
      termLabel: data.termLabel ?? null,
    },
  });
}

export interface UpdateCohortData {
  name?: string;
  termLabel?: string | null;
}

export function updateCohort(id: string, data: UpdateCohortData): Promise<Cohort> {
  return prisma.cohort.update({ where: { id }, data });
}

export interface AssignFacultyData {
  cohortId: string;
  userId: string;
  role: CohortFacultyRole;
}

export function upsertCohortFaculty(data: AssignFacultyData): Promise<CohortFaculty> {
  return prisma.cohortFaculty.upsert({
    where: { cohortId_userId: { cohortId: data.cohortId, userId: data.userId } },
    create: data,
    update: { role: data.role },
  });
}

export function removeCohortFaculty(cohortId: string, userId: string): Promise<CohortFaculty> {
  return prisma.cohortFaculty.delete({
    where: { cohortId_userId: { cohortId, userId } },
  });
}
