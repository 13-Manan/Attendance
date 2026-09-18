import { prisma } from "@/lib/prisma";
import type { AcademicUnit, AcademicUnitKind } from "./types";

export function getAcademicUnitById(id: string): Promise<AcademicUnit | null> {
  return prisma.academicUnit.findUnique({ where: { id } });
}

export function listAcademicUnitsByInstitution(institutionId: string): Promise<AcademicUnit[]> {
  return prisma.academicUnit.findMany({
    where: { institutionId },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

export interface CreateAcademicUnitData {
  institutionId: string;
  campusId?: string | null;
  parentId?: string | null;
  kind: AcademicUnitKind;
  name: string;
  code?: string | null;
  sortOrder?: number;
}

export function createAcademicUnit(data: CreateAcademicUnitData): Promise<AcademicUnit> {
  return prisma.academicUnit.create({
    data: {
      institutionId: data.institutionId,
      campusId: data.campusId ?? null,
      parentId: data.parentId ?? null,
      kind: data.kind,
      name: data.name,
      code: data.code ?? null,
      sortOrder: data.sortOrder ?? 0,
    },
  });
}

export interface UpdateAcademicUnitData {
  name?: string;
  code?: string | null;
  sortOrder?: number;
}

export function updateAcademicUnit(id: string, data: UpdateAcademicUnitData): Promise<AcademicUnit> {
  return prisma.academicUnit.update({ where: { id }, data });
}
