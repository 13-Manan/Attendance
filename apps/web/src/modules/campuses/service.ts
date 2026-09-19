import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import * as repo from "./repository";
import { validateCampusAddress, validateCampusCode, validateCampusName } from "./policy";
import { CampusError, type Campus, type CampusSummary } from "./types";

/**
 * Campus administration.
 *
 * ## Tenancy
 *
 * No function here takes an institution id. It is read from the session, once,
 * in `requireInstitution` below, and passed to a repository whose every
 * function requires it. There is therefore no argument a caller could supply —
 * from a form field, a route parameter or a crafted request body — that would
 * reach another institution's campuses. That is the same shape the faculty
 * directory uses, and it is the reason the brief's "a user from Institution A
 * must never access Institution B" is a property of the module rather than a
 * check somebody has to remember to write.
 *
 * ## Permissions
 *
 * `institution.read` to see the list; `campus.manage` to change anything. Both
 * already exist in the catalogue and `campus.manage` is already granted to
 * every seeded administrator role — this phase gives it its first caller
 * rather than inventing a key nobody's database has.
 *
 * ## Closing, not deleting
 *
 * See the note in `types.ts`. Closure is reversible, leaves history intact and
 * is audited in both directions.
 */

export interface CampusDeps {
  listSummaries?: typeof repo.listCampusSummaries;
  list?: typeof repo.listCampuses;
  get?: typeof repo.getCampus;
  findByCode?: typeof repo.findCampusByCode;
  create?: typeof repo.createCampus;
  update?: typeof repo.updateCampus;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
}

function deps(overrides: CampusDeps) {
  return {
    listSummaries: overrides.listSummaries ?? repo.listCampusSummaries,
    list: overrides.list ?? repo.listCampuses,
    get: overrides.get ?? repo.getCampus,
    findByCode: overrides.findByCode ?? repo.findCampusByCode,
    create: overrides.create ?? repo.createCampus,
    update: overrides.update ?? repo.updateCampus,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => defaultRecordAuditLog(input)),
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new CampusError(
      "This account is not scoped to a single institution, so it cannot manage campuses here.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listCampusesForRequest(
  actor: SessionUser,
  overrides: CampusDeps = {},
): Promise<CampusSummary[]> {
  const institutionId = requireInstitution(actor, "institution.read");
  return deps(overrides).listSummaries(institutionId);
}

/** Just the open ones, for a "which campus?" picker on another screen. */
export async function listOpenCampusOptions(
  actor: SessionUser,
  overrides: CampusDeps = {},
): Promise<Array<{ id: string; name: string; code: string }>> {
  const institutionId = requireInstitution(actor, "institution.read");
  const campuses = await deps(overrides).list(institutionId);
  return campuses
    .filter((campus) => campus.isActive)
    .map((campus) => ({ id: campus.id, name: campus.name, code: campus.code }));
}

export async function getCampusForRequest(
  actor: SessionUser,
  id: string,
  overrides: CampusDeps = {},
): Promise<Campus> {
  const institutionId = requireInstitution(actor, "institution.read");
  const campus = await deps(overrides).get(institutionId, id);
  // One message for "does not exist" and "belongs to somebody else". Saying
  // which would turn this into an oracle for guessing another institution's
  // campus ids.
  if (!campus) throw new CampusError("That campus does not exist.");
  return campus;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface CampusInput {
  name: unknown;
  code: unknown;
  address: unknown;
}

export async function createCampusForRequest(
  actor: SessionUser,
  input: CampusInput,
  overrides: CampusDeps = {},
): Promise<Campus> {
  const institutionId = requireInstitution(actor, "campus.manage");
  const d = deps(overrides);

  const name = validateCampusName(input.name);
  const code = validateCampusCode(input.code);
  const address = validateCampusAddress(input.address);

  // Checked before the insert so the administrator gets a sentence naming the
  // clash rather than a unique-constraint violation. The constraint is still
  // the thing that makes it true under a race — this is the message, not the
  // guarantee.
  const clash = await d.findByCode(institutionId, code);
  if (clash) {
    throw new CampusError(`"${code}" is already the code for ${clash.name}. Choose another.`);
  }

  const campus = await d.create({ institutionId, name, code, address });
  await d.audit({
    action: "campus.created",
    entityType: "Campus",
    entityId: campus.id,
    institutionId,
    actorUserId: actor.userId,
    afterJson: { name: campus.name, code: campus.code, address: campus.address, isActive: true },
  });
  return campus;
}

export async function updateCampusForRequest(
  actor: SessionUser,
  id: string,
  input: CampusInput,
  overrides: CampusDeps = {},
): Promise<Campus> {
  const institutionId = requireInstitution(actor, "campus.manage");
  const d = deps(overrides);

  const existing = await d.get(institutionId, id);
  if (!existing) throw new CampusError("That campus does not exist.");

  const name = validateCampusName(input.name);
  const code = validateCampusCode(input.code);
  const address = validateCampusAddress(input.address);

  if (code !== existing.code) {
    const clash = await d.findByCode(institutionId, code);
    if (clash && clash.id !== id) {
      throw new CampusError(`"${code}" is already the code for ${clash.name}. Choose another.`);
    }
  }

  const updated = await d.update(institutionId, id, { name, code, address });
  if (!updated) throw new CampusError("That campus does not exist.");

  await d.audit({
    action: "campus.updated",
    entityType: "Campus",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { name: existing.name, code: existing.code, address: existing.address },
    afterJson: { name: updated.name, code: updated.code, address: updated.address },
  });
  return updated;
}

/**
 * Closes or reopens a campus.
 *
 * One function for both directions because it is one decision with a sign, and
 * because the audit action is picked from the transition rather than from the
 * caller — an action name a caller could choose is a log a caller could
 * mislead.
 *
 * Already-closed and already-open are refused rather than treated as success.
 * A double-submitted "Close" is harmless, but a silent second success writes a
 * second audit row saying a campus was closed on a day it was already shut.
 */
export async function setCampusOpenForRequest(
  actor: SessionUser,
  id: string,
  isActive: boolean,
  overrides: CampusDeps = {},
): Promise<Campus> {
  const institutionId = requireInstitution(actor, "campus.manage");
  const d = deps(overrides);

  const existing = await d.get(institutionId, id);
  if (!existing) throw new CampusError("That campus does not exist.");
  if (existing.isActive === isActive) {
    throw new CampusError(
      isActive ? `${existing.name} is already open.` : `${existing.name} is already closed.`,
    );
  }

  const updated = await d.update(institutionId, id, { isActive });
  if (!updated) throw new CampusError("That campus does not exist.");

  await d.audit({
    action: isActive ? "campus.reopened" : "campus.closed",
    entityType: "Campus",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { isActive: existing.isActive },
    afterJson: { isActive },
  });
  return updated;
}
