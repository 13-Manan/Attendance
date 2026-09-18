import { prisma } from "@/lib/prisma";
import type { AcademicSession } from "./types";

export function getAcademicSessionById(id: string): Promise<AcademicSession | null> {
  return prisma.academicSession.findUnique({ where: { id } });
}

export function listAcademicSessionsByInstitution(institutionId: string): Promise<AcademicSession[]> {
  return prisma.academicSession.findMany({
    where: { institutionId },
    orderBy: [{ isActive: "desc" }, { startDate: "desc" }],
  });
}

export interface CreateAcademicSessionData {
  institutionId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

export function createAcademicSession(data: CreateAcademicSessionData): Promise<AcademicSession> {
  return prisma.academicSession.create({ data });
}

export interface UpdateAcademicSessionData {
  name?: string;
  startDate?: Date;
  endDate?: Date;
  isActive?: boolean;
}

export function updateAcademicSession(id: string, data: UpdateAcademicSessionData): Promise<AcademicSession> {
  return prisma.academicSession.update({ where: { id }, data });
}
