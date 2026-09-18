import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { prisma } from "@/lib/prisma";
import type { InstitutionType, User } from "@prisma/client";
import { getCohortById } from "@/modules/cohorts/repository";
import { getStudentById } from "@/modules/students/repository";
import type { Cohort } from "@/modules/cohorts/types";
import type { Student } from "@/modules/students/types";
import {
  attachSubjectToCohort as attachSubjectToCohortRepo,
  createSubject as createSubjectRepo,
  enrollStudentInSubject as enrollStudentInSubjectRepo,
  getCohortSubjectById as getCohortSubjectByIdRepo,
  getSubjectById as getSubjectByIdRepo,
  listCohortSubjectsByCohort as listCohortSubjectsByCohortRepo,
  listSubjectsByInstitution as listSubjectsByInstitutionRepo,
} from "./repository";
import type { CohortSubject, StudentSubjectEnrollment, Subject } from "./types";

export interface CreateSubjectInput {
  institutionId: string;
  code: string;
  name: string;
}

export interface CreateSubjectDeps {
  getInstitutionType?: (institutionId: string) => Promise<InstitutionType | null>;
  createSubject?: (data: CreateSubjectInput) => Promise<Subject>;
}

async function defaultGetInstitutionType(institutionId: string): Promise<InstitutionType | null> {
  const inst = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: { type: true },
  });
  return inst?.type ?? null;
}

/**
 * Subjects are a college concept (a school-mode institution runs one daily
 * session per class — see Institution.settings.attendanceMode). We hard-block
 * a SCHOOL admin from creating Subject rows so the "one engine, two
 * workflows" invariant can never be silently violated by data.
 */
export async function createSubjectForRequest(
  actor: SessionUser,
  input: CreateSubjectInput,
  deps: CreateSubjectDeps = {},
): Promise<Subject> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, input.institutionId);

  const getType = deps.getInstitutionType ?? defaultGetInstitutionType;
  const type = await getType(input.institutionId);
  if (type !== "COLLEGE") throw new Error("subjects_are_college_only");

  const createFn = deps.createSubject ?? createSubjectRepo;
  const created = await createFn(input);
  await recordAuditLog({
    action: "subject.created",
    entityType: "Subject",
    entityId: created.id,
    institutionId: input.institutionId,
    actorUserId: actor.userId,
    afterJson: created,
  });
  return created;
}

export interface ListSubjectsDeps {
  listSubjectsByInstitution?: (institutionId: string) => Promise<Subject[]>;
}

export async function listSubjectsForRequest(
  actor: SessionUser,
  institutionId: string,
  deps: ListSubjectsDeps = {},
): Promise<Subject[]> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, institutionId);
  const listFn = deps.listSubjectsByInstitution ?? listSubjectsByInstitutionRepo;
  return listFn(institutionId);
}

export interface AttachSubjectToCohortInput {
  cohortId: string;
  subjectId: string;
  facultyId?: string | null;
}

export interface AttachSubjectDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  getSubjectById?: (id: string) => Promise<Subject | null>;
  getUserById?: (id: string) => Promise<Pick<User, "id" | "institutionId"> | null>;
  attachSubjectToCohort?: (data: AttachSubjectToCohortInput) => Promise<CohortSubject>;
}

async function defaultGetUserById(id: string): Promise<Pick<User, "id" | "institutionId"> | null> {
  return prisma.user.findUnique({ where: { id }, select: { id: true, institutionId: true } });
}

/**
 * Attaches a Subject to a Cohort (making it a taught subject in that
 * cohort) and optionally assigns a faculty to teach it. Enforces that the
 * cohort, the subject, and the faculty user all belong to the same
 * institution as the caller — this is the CohortSubject-scoped analogue of
 * createCohort's tenant-consistency check.
 */
export async function attachSubjectToCohortForRequest(
  actor: SessionUser,
  input: AttachSubjectToCohortInput,
  deps: AttachSubjectDeps = {},
): Promise<CohortSubject> {
  requirePermission(actor, "academicStructure.manage");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(input.cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const getSubject = deps.getSubjectById ?? getSubjectByIdRepo;
  const subject = await getSubject(input.subjectId);
  if (!subject) throw new Error("subject_not_found");
  if (subject.institutionId !== cohort.institutionId) {
    throw new Error("cross_institution_subject");
  }

  if (input.facultyId) {
    const getUser = deps.getUserById ?? defaultGetUserById;
    const user = await getUser(input.facultyId);
    if (!user) throw new Error("faculty_not_found");
    if (user.institutionId !== cohort.institutionId) {
      throw new Error("cross_institution_faculty");
    }
  }

  const attachFn = deps.attachSubjectToCohort ?? attachSubjectToCohortRepo;
  const link = await attachFn(input);
  await recordAuditLog({
    action: "cohort_subject.attached",
    entityType: "CohortSubject",
    entityId: link.id,
    institutionId: cohort.institutionId,
    actorUserId: actor.userId,
    afterJson: link,
  });
  return link;
}

export async function listCohortSubjectsForRequest(
  actor: SessionUser,
  cohortId: string,
  deps: {
    getCohortById?: (id: string) => Promise<Cohort | null>;
    listCohortSubjectsByCohort?: (cohortId: string) => Promise<CohortSubject[]>;
  } = {},
): Promise<CohortSubject[]> {
  requirePermission(actor, "cohort.read");
  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);
  const listFn = deps.listCohortSubjectsByCohort ?? listCohortSubjectsByCohortRepo;
  return listFn(cohortId);
}

export interface EnrollStudentInSubjectInput {
  studentId: string;
  cohortSubjectId: string;
}

export interface EnrollStudentSubjectDeps {
  getCohortSubjectById?: (id: string) => Promise<CohortSubject | null>;
  getCohortById?: (id: string) => Promise<Cohort | null>;
  getStudentById?: (id: string) => Promise<Student | null>;
  enrollStudentInSubject?: (data: EnrollStudentInSubjectInput) => Promise<StudentSubjectEnrollment>;
}

/**
 * Enrolls a Student in one of that cohort's CohortSubjects. The student
 * must be in the same institution as the cohort — a student from another
 * institution being enrolled here would be a direct cross-tenant leak of
 * face-embedding search scope.
 */
export async function enrollStudentInSubjectForRequest(
  actor: SessionUser,
  input: EnrollStudentInSubjectInput,
  deps: EnrollStudentSubjectDeps = {},
): Promise<StudentSubjectEnrollment> {
  requirePermission(actor, "enrollment.manage");

  const getCS = deps.getCohortSubjectById ?? getCohortSubjectByIdRepo;
  const cs = await getCS(input.cohortSubjectId);
  if (!cs) throw new Error("cohort_subject_not_found");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(cs.cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const getStudent = deps.getStudentById ?? getStudentById;
  const student = await getStudent(input.studentId);
  if (!student) throw new Error("student_not_found");
  if (student.institutionId !== cohort.institutionId) {
    throw new Error("cross_institution_student");
  }

  const enrollFn = deps.enrollStudentInSubject ?? enrollStudentInSubjectRepo;
  const enrollment = await enrollFn(input);
  await recordAuditLog({
    action: "student_subject_enrollment.created",
    entityType: "StudentSubjectEnrollment",
    entityId: enrollment.id,
    institutionId: cohort.institutionId,
    actorUserId: actor.userId,
    afterJson: enrollment,
  });
  return enrollment;
}
