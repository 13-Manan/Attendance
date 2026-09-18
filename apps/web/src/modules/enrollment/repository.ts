import { prisma } from "@/lib/prisma";
import type { Enrollment, EnrollmentStatus } from "./types";

export function listEnrollmentsForCohort(cohortId: string): Promise<Enrollment[]> {
  return prisma.enrollment.findMany({
    where: { cohortId },
    orderBy: [{ enrolledAt: "asc" }],
  });
}

export function getEnrollment(studentId: string, cohortId: string): Promise<Enrollment | null> {
  return prisma.enrollment.findUnique({
    where: { studentId_cohortId: { studentId, cohortId } },
  });
}

export interface UpsertEnrollmentData {
  institutionId: string;
  studentId: string;
  cohortId: string;
  status?: EnrollmentStatus;
}

export function upsertEnrollment(data: UpsertEnrollmentData): Promise<Enrollment> {
  return prisma.enrollment.upsert({
    where: { studentId_cohortId: { studentId: data.studentId, cohortId: data.cohortId } },
    create: {
      institutionId: data.institutionId,
      studentId: data.studentId,
      cohortId: data.cohortId,
      status: data.status ?? "ACTIVE",
    },
    update: {
      status: data.status ?? "ACTIVE",
      unenrolledAt: null,
    },
  });
}

export function markEnrollmentUnenrolled(id: string): Promise<Enrollment> {
  return prisma.enrollment.update({
    where: { id },
    data: { status: "INACTIVE", unenrolledAt: new Date() },
  });
}
