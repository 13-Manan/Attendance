import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAcademicUnitLabels } from "@/modules/institutions/service";
import * as repo from "./directory-repository";
import { buildUnitTree, toParentChoices } from "./directory-tree";
import {
  optionalId,
  validateKind,
  validateSortOrder,
  validateUnitCode,
  validateUnitName,
} from "./directory-policy";
import {
  createAcademicUnitForRequest,
  renameAcademicUnitForRequest,
} from "./service";
import { KINDS_BY_INSTITUTION_TYPE } from "./types";
import type { AcademicUnit, AcademicUnitKind } from "./types";
import {
  AcademicStructureError,
  type UnitFormOptions,
  type UnitRow,
  type UnitTreeNode,
} from "./directory-types";

/**
 * Administering the academic structure: the shelf everything else is filed on.
 *
 * ## Tenancy
 *
 * No function here takes an institution id. It is read from the session, once,
 * in `requireInstitution` below, and passed to a repository whose every
 * function requires it. There is therefore no argument a caller could supply —
 * a form field, a route parameter, a crafted request body — that reaches
 * another institution's structure. The tests assert it by counting parameters.
 *
 * ## One write path
 *
 * Nothing here writes. Creating and renaming go through `service.ts`, which
 * enforces the rule that a school has no semesters and a college no grades,
 * checks the parent and the campus belong to the same institution, and records
 * the audit row. A second writer here would let the structure change without
 * one.
 *
 * What this file adds is the layer between a form and that service: reading
 * untrusted strings, refusing them in sentences rather than in codes, and
 * assembling the several reads a screen needs into one.
 *
 * ## Permission
 *
 * `academicStructure.manage`, for reading as well as writing. That is the
 * existing gate on `listAcademicUnitsForRequest` and on the whole
 * `/dashboard/academic` section, and narrowing it here would not make anything
 * safer — a faculty member reads the structure through the classes they teach.
 */

export interface StructureDirectoryDeps {
  listRows?: typeof repo.listUnitRows;
  get?: typeof repo.getUnitForInstitution;
  listCampuses?: typeof repo.listCampusChoicesForUnits;
  getInstitution?: typeof getInstitutionById;
  create?: typeof createAcademicUnitForRequest;
  rename?: typeof renameAcademicUnitForRequest;
}

function deps(overrides: StructureDirectoryDeps) {
  return {
    listRows: overrides.listRows ?? repo.listUnitRows,
    get: overrides.get ?? repo.getUnitForInstitution,
    listCampuses: overrides.listCampuses ?? repo.listCampusChoicesForUnits,
    getInstitution: overrides.getInstitution ?? getInstitutionById,
    create: overrides.create ?? createAcademicUnitForRequest,
    rename: overrides.rename ?? renameAcademicUnitForRequest,
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new AcademicStructureError(
      "This account is not scoped to a single institution, so it has no academic structure.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listUnitsForRequest(
  actor: SessionUser,
  overrides: StructureDirectoryDeps = {},
): Promise<UnitTreeNode[]> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  return buildUnitTree(await deps(overrides).listRows(institutionId));
}

export async function getUnitForRequest(
  actor: SessionUser,
  id: string,
  overrides: StructureDirectoryDeps = {},
): Promise<UnitRow> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const unit = await deps(overrides).get(institutionId, id);
  // One message for "does not exist" and "belongs to another institution".
  // Saying which would turn this page into an oracle for guessing ids.
  if (!unit) throw new AcademicStructureError("That part of the structure does not exist.");
  return unit;
}

/**
 * Everything the form needs: the kinds this institution may have, its own word
 * for each of them, the units a new one could sit inside, and the campuses.
 */
export async function getUnitFormOptionsForRequest(
  actor: SessionUser,
  overrides: StructureDirectoryDeps = {},
): Promise<UnitFormOptions> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const d = deps(overrides);

  const [institution, rows, campuses] = await Promise.all([
    d.getInstitution(institutionId),
    d.listRows(institutionId),
    d.listCampuses(institutionId),
  ]);

  if (!institution) throw new AcademicStructureError("That institution does not exist.");

  return {
    institutionType: institution.type,
    allowedKinds: [...KINDS_BY_INSTITUTION_TYPE[institution.type]],
    labels: resolveAcademicUnitLabels(institution) as Record<AcademicUnitKind, string>,
    parents: toParentChoices(buildUnitTree(rows)),
    campuses,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The raw form, before any of it is trusted. */
export interface UnitInput {
  name: unknown;
  code: unknown;
  sortOrder: unknown;
  /** Only read on create — see `updateUnitFromFormForRequest` for why. */
  kind?: unknown;
  parentId?: unknown;
  campusId?: unknown;
}

/**
 * Turns the structure service's coded errors into sentences.
 *
 * The cross-institution ones must not be repeated as themselves: saying "that
 * campus is in another institution" would confirm the id names a real row
 * somewhere else, which "does not exist" does not.
 */
function describeFailure(error: unknown): never {
  if (error instanceof AcademicStructureError) throw error;
  const code = error instanceof Error ? error.message : "";
  if (code.startsWith("invalid_kind_for_institution_type")) {
    throw new AcademicStructureError(
      "That is not something this institution's structure can hold.",
    );
  }
  if (code === "parent_not_found" || code === "cross_institution_parent") {
    throw new AcademicStructureError("The thing you are putting this inside does not exist.");
  }
  if (code === "campus_not_found" || code === "cross_institution_campus") {
    throw new AcademicStructureError("That campus does not exist.");
  }
  if (code === "academic_unit_not_found") {
    throw new AcademicStructureError("That part of the structure does not exist.");
  }
  if (code === "institution_not_found") {
    throw new AcademicStructureError("That institution does not exist.");
  }
  throw error;
}

export async function createUnitFromFormForRequest(
  actor: SessionUser,
  input: UnitInput,
  overrides: StructureDirectoryDeps = {},
): Promise<AcademicUnit> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const d = deps(overrides);

  const institution = await d.getInstitution(institutionId);
  if (!institution) throw new AcademicStructureError("That institution does not exist.");

  const name = validateUnitName(input.name);
  const code = validateUnitCode(input.code);
  const sortOrder = validateSortOrder(input.sortOrder);
  const kind = validateKind(input.kind, KINDS_BY_INSTITUTION_TYPE[institution.type]);
  const parentId = optionalId(input.parentId);
  const campusId = optionalId(input.campusId);

  try {
    return await d.create(actor, {
      institutionId,
      kind,
      name,
      code,
      parentId,
      campusId,
      sortOrder,
    });
  } catch (error) {
    describeFailure(error);
  }
}

/**
 * Rename a part of the structure, or change its code or its position.
 *
 * The kind, the parent and the campus are not editable, and that is a domain
 * decision rather than an omission: they decide where every class underneath it
 * sits, and moving a grade to another campus would re-file the attendance taken
 * for every class in it. Something in the wrong place is created again in the
 * right one, and the wrong one is left to its history.
 */
export async function updateUnitFromFormForRequest(
  actor: SessionUser,
  id: string,
  input: UnitInput,
  overrides: StructureDirectoryDeps = {},
): Promise<AcademicUnit> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const d = deps(overrides);

  // Scoped read first, so an id from another institution's URL is "does not
  // exist" here rather than a permission error from further down, which would
  // confirm the row is real.
  const existing = await d.get(institutionId, id);
  if (!existing) throw new AcademicStructureError("That part of the structure does not exist.");

  const name = validateUnitName(input.name);
  const code = validateUnitCode(input.code);
  const sortOrder = validateSortOrder(input.sortOrder);

  try {
    return await d.rename(actor, { id, name, code, sortOrder });
  } catch (error) {
    describeFailure(error);
  }
}
