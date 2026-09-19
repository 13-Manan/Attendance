import { prisma } from "@/lib/prisma";
import type { CohortSubject, StudentSubjectEnrollment, Subject } from "./types";

export function getSubjectById(id: string): Promise<Subject | null> {
  return prisma.subject.findUnique({ where: { id } });
}

export function listSubjectsByInstitution(institutionId: string): Promise<Subject[]> {
  return prisma.subject.findMany({
    where: { institutionId },
    orderBy: [{ code: "asc" }],
  });
}

export interface CreateSubjectData {
  institutionId: string;
  code: string;
  name: string;
}

export function createSubject(data: CreateSubjectData): Promise<Subject> {
  return prisma.subject.create({ data });
}

/**
 * By id alone, because the only caller has already read the row through
 * `getSubjectById` and checked the institution on it. `institutionId` is not
 * in the `data`, so this cannot move a subject between tenants.
 */
export function updateSubject(
  id: string,
  data: { code: string; name: string },
): Promise<Subject> {
  return prisma.subject.update({ where: { id }, data });
}

export function getCohortSubjectById(id: string): Promise<CohortSubject | null> {
  return prisma.cohortSubject.findUnique({ where: { id } });
}

export function listCohortSubjectsByCohort(cohortId: string): Promise<CohortSubject[]> {
  return prisma.cohortSubject.findMany({ where: { cohortId } });
}

export function listCohortSubjectsForFaculty(userId: string): Promise<CohortSubject[]> {
  return prisma.cohortSubject.findMany({ where: { facultyId: userId } });
}

export interface AttachSubjectData {
  cohortId: string;
  subjectId: string;
  facultyId?: string | null;
}

export function attachSubjectToCohort(data: AttachSubjectData): Promise<CohortSubject> {
  return prisma.cohortSubject.upsert({
    where: { cohortId_subjectId: { cohortId: data.cohortId, subjectId: data.subjectId } },
    create: {
      cohortId: data.cohortId,
      subjectId: data.subjectId,
      facultyId: data.facultyId ?? null,
    },
    update: { facultyId: data.facultyId ?? null },
  });
}

export interface EnrollStudentSubjectData {
  studentId: string;
  cohortSubjectId: string;
}

export function enrollStudentInSubject(data: EnrollStudentSubjectData): Promise<StudentSubjectEnrollment> {
  return prisma.studentSubjectEnrollment.upsert({
    where: {
      studentId_cohortSubjectId: {
        studentId: data.studentId,
        cohortSubjectId: data.cohortSubjectId,
      },
    },
    create: data,
    update: {},
  });
}

export function listStudentSubjectEnrollments(cohortSubjectId: string): Promise<StudentSubjectEnrollment[]> {
  return prisma.studentSubjectEnrollment.findMany({ where: { cohortSubjectId } });
}
