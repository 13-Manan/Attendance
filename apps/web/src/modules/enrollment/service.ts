import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getCohortById } from "@/modules/cohorts/repository";
import { getStudentById } from "@/modules/students/repository";
import type { Cohort } from "@/modules/cohorts/types";
import type { Student } from "@/modules/students/types";
import {
  getEnrollment as getEnrollmentRepo,
  listEnrollmentsForCohort as listEnrollmentsForCohortRepo,
  markEnrollmentUnenrolled as markEnrollmentUnenrolledRepo,
  upsertEnrollment as upsertEnrollmentRepo,
} from "./repository";
import type { Enrollment, EnrollmentStatus } from "./types";

export interface EnrollStudentInput {
  studentId: string;
  cohortId: string;
  status?: EnrollmentStatus;
}

export interface EnrollStudentDeps {
  getStudentById?: (id: string) => Promise<Student | null>;
  getCohortById?: (id: string) => Promise<Cohort | null>;
  upsertEnrollment?: (data: {
    institutionId: string;
    studentId: string;
    cohortId: string;
    status?: EnrollmentStatus;
  }) => Promise<Enrollment>;
}

/**
 * The single choke point that binds a Student to a Cohort. Every check
 * downstream ("faculty only sees my class's students," "face search only
 * scans cohort's enrolled students") derives its scope from Enrollment rows,
 * so this method — the ONLY writer to that table — is where the
 * cross-institution guard has to hold. A cross-tenant enrollment would leak
 * a student into a foreign cohort's face-search index, so we refuse it
 * before the write reaches the DB.
 */
export async function enrollStudentInCohortForRequest(
  actor: SessionUser,
  input: EnrollStudentInput,
  deps: EnrollStudentDeps = {},
): Promise<Enrollment> {
  requirePermission(actor, "enrollment.manage");

  const getStudent = deps.getStudentById ?? getStudentById;
  const student = await getStudent(input.studentId);
  if (!student) throw new Error("student_not_found");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(input.cohortId);
  if (!cohort) throw new Error("cohort_not_found");

  requireSameInstitution(actor, cohort.institutionId);
  if (student.institutionId !== cohort.institutionId) {
    throw new Error("cross_institution_enrollment");
  }

  const upsertFn = deps.upsertEnrollment ?? upsertEnrollmentRepo;
  const enrollment = await upsertFn({
    institutionId: cohort.institutionId,
    studentId: input.studentId,
    cohortId: input.cohortId,
    status: input.status ?? "ACTIVE",
  });
  await recordAuditLog({
    action: "enrollment.created",
    entityType: "Enrollment",
    entityId: enrollment.id,
    institutionId: cohort.institutionId,
    actorUserId: actor.userId,
    afterJson: enrollment,
  });
  return enrollment;
}

export interface UnenrollStudentInput {
  studentId: string;
  cohortId: string;
}

export interface UnenrollStudentDeps {
  getEnrollment?: (studentId: string, cohortId: string) => Promise<Enrollment | null>;
  getCohortById?: (id: string) => Promise<Cohort | null>;
  markEnrollmentUnenrolled?: (id: string) => Promise<Enrollment>;
}

export async function unenrollStudentFromCohortForRequest(
  actor: SessionUser,
  input: UnenrollStudentInput,
  deps: UnenrollStudentDeps = {},
): Promise<Enrollment> {
  requirePermission(actor, "enrollment.manage");

  const getE = deps.getEnrollment ?? getEnrollmentRepo;
  const existing = await getE(input.studentId, input.cohortId);
  if (!existing) throw new Error("enrollment_not_found");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(input.cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const markFn = deps.markEnrollmentUnenrolled ?? markEnrollmentUnenrolledRepo;
  const updated = await markFn(existing.id);
  await recordAuditLog({
    action: "enrollment.updated",
    entityType: "Enrollment",
    entityId: updated.id,
    institutionId: cohort.institutionId,
    actorUserId: actor.userId,
    beforeJson: existing,
    afterJson: updated,
  });
  return updated;
}

export interface ListEnrollmentsDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  listEnrollmentsForCohort?: (cohortId: string) => Promise<Enrollment[]>;
}

export async function listEnrollmentsForRequest(
  actor: SessionUser,
  cohortId: string,
  deps: ListEnrollmentsDeps = {},
): Promise<Enrollment[]> {
  requirePermission(actor, "cohort.read");
  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);
  const listFn = deps.listEnrollmentsForCohort ?? listEnrollmentsForCohortRepo;
  return listFn(cohortId);
}
