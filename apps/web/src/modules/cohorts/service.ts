import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getAcademicSessionById } from "@/modules/academic-sessions/repository";
import { getAcademicUnitById } from "@/modules/academic-structure/repository";
import type { AcademicSession } from "@/modules/academic-sessions/types";
import type { AcademicUnit } from "@/modules/academic-structure/types";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createCohort as createCohortRepo,
  getCohortById as getCohortByIdRepo,
  listCohortsByInstitution as listCohortsByInstitutionRepo,
  listCohortsForFaculty as listCohortsForFacultyRepo,
  updateCohort as updateCohortRepo,
  upsertCohortFaculty as upsertCohortFacultyRepo,
} from "./repository";
import type { Cohort, CohortFaculty, CohortFacultyRole } from "./types";

export interface CreateCohortInput {
  institutionId: string;
  academicUnitId: string;
  academicSessionId: string;
  name: string;
  termLabel?: string | null;
}

export interface CreateCohortDeps {
  getAcademicUnitById?: (id: string) => Promise<AcademicUnit | null>;
  getAcademicSessionById?: (id: string) => Promise<AcademicSession | null>;
  createCohort?: (data: CreateCohortInput) => Promise<Cohort>;
}

/**
 * Creates a Cohort — the atomic attendance-taking group — with a strict
 * tenant-consistency check: both its AcademicUnit and AcademicSession must
 * live in the same institution as the caller. This is the join point where a
 * cross-institution smuggle would otherwise hide: any of the three IDs
 * silently pointing to another tenant would let one institution's
 * class-teacher access another institution's students via the Cohort.
 */
export async function createCohortForRequest(
  actor: SessionUser,
  input: CreateCohortInput,
  deps: CreateCohortDeps = {},
): Promise<Cohort> {
  requirePermission(actor, "cohort.manage");
  requireSameInstitution(actor, input.institutionId);

  const getUnit = deps.getAcademicUnitById ?? getAcademicUnitById;
  const unit = await getUnit(input.academicUnitId);
  if (!unit) throw new Error("academic_unit_not_found");
  if (unit.institutionId !== input.institutionId) {
    throw new Error("cross_institution_academic_unit");
  }

  const getSession = deps.getAcademicSessionById ?? getAcademicSessionById;
  const session = await getSession(input.academicSessionId);
  if (!session) throw new Error("academic_session_not_found");
  if (session.institutionId !== input.institutionId) {
    throw new Error("cross_institution_academic_session");
  }

  const createFn = deps.createCohort ?? createCohortRepo;
  const created = await createFn(input);
  await recordAuditLog({
    action: "cohort.created",
    entityType: "Cohort",
    entityId: created.id,
    institutionId: input.institutionId,
    actorUserId: actor.userId,
    afterJson: created,
  });
  return created;
}

export interface UpdateCohortInput {
  cohortId: string;
  name?: string;
  termLabel?: string | null;
}

export interface UpdateCohortDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  updateCohort?: (id: string, data: { name?: string; termLabel?: string | null }) => Promise<Cohort>;
}

/**
 * Renames a cohort. Only the label moves: the academic unit and the academic
 * session are what the cohort *is*, and enrollments, attendance sessions and
 * face-review rows already point at this row on that understanding. Moving
 * "Grade 8 A, 2026-27" onto another year would silently re-file a year of
 * attendance, so a class in the wrong year is created again in the right one
 * rather than edited across.
 */
export async function updateCohortForRequest(
  actor: SessionUser,
  input: UpdateCohortInput,
  deps: UpdateCohortDeps = {},
): Promise<Cohort> {
  requirePermission(actor, "cohort.manage");

  const getCohort = deps.getCohortById ?? getCohortByIdRepo;
  const before = await getCohort(input.cohortId);
  if (!before) throw new Error("cohort_not_found");
  requireSameInstitution(actor, before.institutionId);

  const updateFn = deps.updateCohort ?? updateCohortRepo;
  const after = await updateFn(input.cohortId, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.termLabel === undefined ? {} : { termLabel: input.termLabel }),
  });
  await recordAuditLog({
    action: "cohort.updated",
    entityType: "Cohort",
    entityId: after.id,
    institutionId: before.institutionId,
    actorUserId: actor.userId,
    beforeJson: before,
    afterJson: after,
  });
  return after;
}

export interface ListCohortsDeps {
  listCohortsByInstitution?: (institutionId: string) => Promise<Cohort[]>;
}

export async function listCohortsForInstitutionRequest(
  actor: SessionUser,
  institutionId: string,
  deps: ListCohortsDeps = {},
): Promise<Cohort[]> {
  requirePermission(actor, "cohort.read");
  requireSameInstitution(actor, institutionId);
  const listFn = deps.listCohortsByInstitution ?? listCohortsByInstitutionRepo;
  return listFn(institutionId);
}

/**
 * The "faculty only sees assigned classes" projection: returns cohorts the
 * caller is directly linked to via CohortFaculty. Uses the caller's own user
 * id — never accepts a userId param — so a caller cannot enumerate another
 * user's cohorts through this method.
 */
export async function listCohortsForCurrentFaculty(
  actor: SessionUser,
  deps: { listCohortsForFaculty?: (userId: string) => Promise<Cohort[]> } = {},
): Promise<Cohort[]> {
  requirePermission(actor, "cohort.read");
  const listFn = deps.listCohortsForFaculty ?? listCohortsForFacultyRepo;
  return listFn(actor.userId);
}

export interface AssignFacultyToCohortInput {
  cohortId: string;
  userId: string;
  role: CohortFacultyRole;
}

export interface AssignFacultyDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  getUserById?: (id: string) => Promise<Pick<User, "id" | "institutionId"> | null>;
  upsertCohortFaculty?: (data: AssignFacultyToCohortInput) => Promise<CohortFaculty>;
}

async function defaultGetUserById(id: string): Promise<Pick<User, "id" | "institutionId"> | null> {
  return prisma.user.findUnique({ where: { id }, select: { id: true, institutionId: true } });
}

/**
 * Assigns a faculty or class teacher to a cohort. PRIMARY = class teacher
 * (school) / lead faculty (college); ASSISTANT = additional teacher. Enforces
 * that both the cohort AND the target user belong to the caller's institution,
 * so an admin cannot borrow a faculty account from another tenant.
 */
export async function assignFacultyToCohortForRequest(
  actor: SessionUser,
  input: AssignFacultyToCohortInput,
  deps: AssignFacultyDeps = {},
): Promise<CohortFaculty> {
  requirePermission(actor, "cohort.manage");

  const getCohort = deps.getCohortById ?? getCohortByIdRepo;
  const cohort = await getCohort(input.cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const getUser = deps.getUserById ?? defaultGetUserById;
  const user = await getUser(input.userId);
  if (!user) throw new Error("user_not_found");
  if (user.institutionId !== cohort.institutionId) {
    throw new Error("cross_institution_user");
  }

  const upsertFn = deps.upsertCohortFaculty ?? upsertCohortFacultyRepo;
  const link = await upsertFn(input);
  await recordAuditLog({
    action: "cohort_faculty.assigned",
    entityType: "CohortFaculty",
    entityId: link.id,
    institutionId: cohort.institutionId,
    actorUserId: actor.userId,
    afterJson: link,
  });
  return link;
}
