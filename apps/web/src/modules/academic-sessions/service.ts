import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  createAcademicSession as createAcademicSessionRepo,
  getAcademicSessionById as getAcademicSessionByIdRepo,
  listAcademicSessionsByInstitution as listAcademicSessionsByInstitutionRepo,
  updateAcademicSession as updateAcademicSessionRepo,
} from "./repository";
import type { AcademicSession } from "./types";

export interface CreateAcademicSessionInput {
  institutionId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

export interface CreateAcademicSessionDeps {
  createAcademicSession?: (data: CreateAcademicSessionInput) => Promise<AcademicSession>;
}

/**
 * Creates an AcademicSession (a named academic year/session, e.g. "2026-27").
 * The cross-institution guard fires before the write, so cross-tenant
 * spoofing of `institutionId` in the request body is impossible for any
 * non-platform user.
 */
export async function createAcademicSessionForRequest(
  actor: SessionUser,
  input: CreateAcademicSessionInput,
  deps: CreateAcademicSessionDeps = {},
): Promise<AcademicSession> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, input.institutionId);

  if (input.endDate <= input.startDate) throw new Error("invalid_date_range");

  const createFn = deps.createAcademicSession ?? createAcademicSessionRepo;

  // We do not use prisma.$transaction here because the injected create may be
  // a plain function in tests; the real path is one insert + one audit row,
  // and the audit call reuses the default prisma client.
  const created = await createFn(input);
  await recordAuditLog({
    action: "academic_session.created",
    entityType: "AcademicSession",
    entityId: created.id,
    institutionId: input.institutionId,
    actorUserId: actor.userId,
    afterJson: created,
  });
  return created;
}

export interface ListAcademicSessionsDeps {
  listAcademicSessionsByInstitution?: (institutionId: string) => Promise<AcademicSession[]>;
}

export async function listAcademicSessionsForRequest(
  actor: SessionUser,
  institutionId: string,
  deps: ListAcademicSessionsDeps = {},
): Promise<AcademicSession[]> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, institutionId);
  const listFn = deps.listAcademicSessionsByInstitution ?? listAcademicSessionsByInstitutionRepo;
  return listFn(institutionId);
}

export interface ArchiveAcademicSessionDeps {
  getAcademicSessionById?: (id: string) => Promise<AcademicSession | null>;
  updateAcademicSession?: (id: string, data: { isActive?: boolean }) => Promise<AcademicSession>;
}

/**
 * "Archive" = set isActive=false. We deliberately do not delete rows — Cohorts
 * link to AcademicSession, and past attendance history must remain readable
 * for compliance.
 */
export async function archiveAcademicSessionForRequest(
  actor: SessionUser,
  id: string,
  deps: ArchiveAcademicSessionDeps = {},
): Promise<AcademicSession> {
  requirePermission(actor, "academicStructure.manage");
  const getFn = deps.getAcademicSessionById ?? getAcademicSessionByIdRepo;
  const existing = await getFn(id);
  if (!existing) throw new Error("academic_session_not_found");
  requireSameInstitution(actor, existing.institutionId);

  const updateFn = deps.updateAcademicSession ?? updateAcademicSessionRepo;
  const updated = await updateFn(id, { isActive: false });
  await recordAuditLog({
    action: "academic_session.archived",
    entityType: "AcademicSession",
    entityId: id,
    institutionId: existing.institutionId,
    actorUserId: actor.userId,
    beforeJson: { isActive: existing.isActive },
    afterJson: { isActive: false },
  });
  return updated;
}
