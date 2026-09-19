import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import type { InstitutionType } from "@prisma/client";
import {
  getAcademicUnitById as getAcademicUnitByIdRepo,
  listAcademicUnitsByInstitution as listAcademicUnitsByInstitutionRepo,
  updateAcademicUnit as updateAcademicUnitRepo,
} from "./repository";
import { KINDS_BY_INSTITUTION_TYPE } from "./types";
import type { AcademicUnit, AcademicUnitKind } from "./types";

export interface CreateAcademicUnitInput {
  institutionId: string;
  campusId?: string | null;
  parentId?: string | null;
  kind: AcademicUnitKind;
  name: string;
  code?: string | null;
  sortOrder?: number;
}

export interface CreateAcademicUnitDeps {
  getInstitutionType?: (institutionId: string) => Promise<InstitutionType | null>;
  getParentUnit?: (id: string) => Promise<AcademicUnit | null>;
  getCampus?: (id: string) => Promise<{ institutionId: string } | null>;
}

async function defaultGetInstitutionType(institutionId: string): Promise<InstitutionType | null> {
  const inst = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: { type: true },
  });
  return inst?.type ?? null;
}

async function defaultGetCampus(id: string): Promise<{ institutionId: string } | null> {
  return prisma.campus.findUnique({ where: { id }, select: { institutionId: true } });
}

/**
 * Creates an AcademicUnit inside a strict cross-institution + institution-type
 * guardrail: a SCHOOL admin cannot invent a SEMESTER, a COLLEGE admin cannot
 * invent a GRADE, and no admin can hang a child unit onto a parent from
 * another institution. All three checks happen before any write, so denial
 * paths never touch the database.
 */
export async function createAcademicUnitForRequest(
  actor: SessionUser,
  input: CreateAcademicUnitInput,
  deps: CreateAcademicUnitDeps = {},
): Promise<AcademicUnit> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, input.institutionId);

  const getType = deps.getInstitutionType ?? defaultGetInstitutionType;
  const type = await getType(input.institutionId);
  if (!type) throw new Error("institution_not_found");

  const allowed: readonly AcademicUnitKind[] = KINDS_BY_INSTITUTION_TYPE[type];
  if (!allowed.includes(input.kind)) {
    throw new Error(`invalid_kind_for_institution_type:${input.kind}/${type}`);
  }

  if (input.parentId) {
    const getParent = deps.getParentUnit ?? getAcademicUnitByIdRepo;
    const parent = await getParent(input.parentId);
    if (!parent) throw new Error("parent_not_found");
    if (parent.institutionId !== input.institutionId) {
      // Cross-institution nesting would silently smuggle a parent from
      // another tenant into this tenant's tree — reject before writing.
      throw new Error("cross_institution_parent");
    }
  }

  if (input.campusId) {
    // Same reasoning as the parent, and the same reason it cannot be skipped:
    // `campusId` arrives from a form, and an id belonging to another tenant
    // would put their campus's name on this institution's screens — and on
    // every register taken under the unit.
    const getCampus = deps.getCampus ?? defaultGetCampus;
    const campus = await getCampus(input.campusId);
    if (!campus) throw new Error("campus_not_found");
    if (campus.institutionId !== input.institutionId) {
      throw new Error("cross_institution_campus");
    }
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.academicUnit.create({
      data: {
        institutionId: input.institutionId,
        campusId: input.campusId ?? null,
        parentId: input.parentId ?? null,
        kind: input.kind,
        name: input.name,
        code: input.code ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await recordAuditLog(
      {
        action: "academic_unit.created",
        entityType: "AcademicUnit",
        entityId: created.id,
        institutionId: input.institutionId,
        actorUserId: actor.userId,
        afterJson: created,
      },
      tx,
    );
    return created;
  });
}

export interface ListAcademicUnitsDeps {
  listAcademicUnitsByInstitution?: (institutionId: string) => Promise<AcademicUnit[]>;
}

export async function listAcademicUnitsForRequest(
  actor: SessionUser,
  institutionId: string,
  deps: ListAcademicUnitsDeps = {},
): Promise<AcademicUnit[]> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, institutionId);
  const listFn = deps.listAcademicUnitsByInstitution ?? listAcademicUnitsByInstitutionRepo;
  return listFn(institutionId);
}

export interface RenameAcademicUnitInput {
  id: string;
  name?: string;
  code?: string | null;
  sortOrder?: number;
}

export interface RenameAcademicUnitDeps {
  getAcademicUnitById?: (id: string) => Promise<AcademicUnit | null>;
  updateAcademicUnit?: (id: string, data: { name?: string; code?: string | null; sortOrder?: number }) => Promise<AcademicUnit>;
}

/**
 * Renames a unit, or changes its code or its place in the order.
 *
 * What it does not change is the kind, the parent or the campus. Those decide
 * where every cohort underneath it sits, and moving a GRADE under another
 * campus would re-file the attendance taken for every class in it — so a unit
 * in the wrong place is created again in the right one.
 *
 * The audit row records the whole row before and after rather than the fields
 * that were sent: "name was 'Grade 8'" is what somebody reading the log six
 * months later needs, and a diff of the submitted form does not say it.
 */
export async function renameAcademicUnitForRequest(
  actor: SessionUser,
  input: RenameAcademicUnitInput,
  deps: RenameAcademicUnitDeps = {},
): Promise<AcademicUnit> {
  requirePermission(actor, "academicStructure.manage");
  const getFn = deps.getAcademicUnitById ?? getAcademicUnitByIdRepo;
  const existing = await getFn(input.id);
  if (!existing) throw new Error("academic_unit_not_found");
  requireSameInstitution(actor, existing.institutionId);

  const updateFn = deps.updateAcademicUnit ?? updateAcademicUnitRepo;
  const { id, ...data } = input;
  const updated = await updateFn(id, data);

  await recordAuditLog({
    action: "academic_unit.updated",
    entityType: "AcademicUnit",
    entityId: updated.id,
    institutionId: existing.institutionId,
    actorUserId: actor.userId,
    beforeJson: existing,
    afterJson: updated,
  });

  return updated;
}

/**
 * Structural / read-only helper: given a flat list of AcademicUnits, group
 * them into a parent -> children tree. Pure so the UI can call it without a
 * database.
 */
export interface AcademicUnitTreeNode extends AcademicUnit {
  children: AcademicUnitTreeNode[];
}

export function buildAcademicUnitTree(units: AcademicUnit[]): AcademicUnitTreeNode[] {
  const byId = new Map<string, AcademicUnitTreeNode>();
  for (const u of units) byId.set(u.id, { ...u, children: [] });
  const roots: AcademicUnitTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
