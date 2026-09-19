import { recordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import * as repo from "./repository";
import {
  createAcademicSession as createAcademicSessionRepo,
  getAcademicSessionById as getAcademicSessionByIdRepo,
  listAcademicSessionsByInstitution as listAcademicSessionsByInstitutionRepo,
  updateAcademicSession as updateAcademicSessionRepo,
} from "./repository";
import { parseSessionDate, validateDateRange, validateSessionName } from "./policy";
import {
  AcademicSessionError,
  type AcademicSession,
  type AcademicSessionSummary,
} from "./types";

export interface CreateAcademicSessionInput {
  institutionId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

export interface CreateAcademicSessionDeps {
  createAcademicSession?: (data: CreateAcademicSessionInput) => Promise<AcademicSession>;
  findByName?: typeof repo.findAcademicSessionByName;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
}

/**
 * Creates an AcademicSession (a named academic year/session, e.g. "2026-27").
 * The cross-institution guard fires before the write, so cross-tenant
 * spoofing of `institutionId` in the request body is impossible for any
 * non-platform user.
 *
 * Both refusals are `AcademicSessionError`, which is what carries a sentence
 * back to the form. They used to be a bare `Error` and a unique-constraint
 * violation from Prisma, and the page could say no more than "check dates and
 * uniqueness" — true of both, useful for neither.
 */
export async function createAcademicSessionForRequest(
  actor: SessionUser,
  input: CreateAcademicSessionInput,
  deps: CreateAcademicSessionDeps = {},
): Promise<AcademicSession> {
  requirePermission(actor, "academicStructure.manage");
  requireSameInstitution(actor, input.institutionId);

  validateDateRange(input.startDate, input.endDate);

  // Checked rather than left to `@@unique([institutionId, name])`, so the
  // refusal names the year instead of surfacing a constraint name.
  const findByName = deps.findByName ?? repo.findAcademicSessionByName;
  if (await findByName(input.institutionId, input.name)) {
    throw new AcademicSessionError(
      `This institution already has an academic year called ${input.name}.`,
    );
  }

  const createFn = deps.createAcademicSession ?? createAcademicSessionRepo;

  // We do not use prisma.$transaction here because the injected create may be
  // a plain function in tests; the real path is one insert + one audit row.
  const created = await createFn(input);
  await (deps.audit ?? recordAuditLog)({
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

// ---------------------------------------------------------------------------
// The academic year as an administered thing: listed, edited, made current,
// archived and brought back.
// ---------------------------------------------------------------------------

/**
 * ## Tenancy
 *
 * None of the functions below takes an institution id. It comes from the
 * session, once, in `requireInstitution`, and every repository call is scoped
 * with it — so a year id lifted from another institution's URL reads as "does
 * not exist" rather than as somebody else's year.
 *
 * The four functions above predate this and take an explicit `institutionId`
 * checked by `requireSameInstitution`. They are left exactly as they are: they
 * are correct, they are covered by tests, and rewriting a working write path
 * is not what this phase is for.
 *
 * ## Permission
 *
 * `academicStructure.manage` throughout, including for reading. There is no
 * `academicStructure.read` key, and inventing one now would be a key that
 * exists in this build's code and in nobody's database — role→permission rows
 * are seeded data — which would lock every administrator out of the page. The
 * same argument is written out in `modules/admin-settings/service.ts`.
 */
export interface AcademicSessionDeps {
  listSummaries?: typeof repo.listAcademicSessionSummaries;
  get?: typeof repo.getAcademicSessionForInstitution;
  getCurrent?: typeof repo.getCurrentAcademicSession;
  findByName?: typeof repo.findAcademicSessionByName;
  update?: typeof repo.updateAcademicSessionForInstitution;
  setCurrent?: typeof repo.setCurrentAcademicSession;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
}

function deps(overrides: AcademicSessionDeps) {
  return {
    listSummaries: overrides.listSummaries ?? repo.listAcademicSessionSummaries,
    get: overrides.get ?? repo.getAcademicSessionForInstitution,
    getCurrent: overrides.getCurrent ?? repo.getCurrentAcademicSession,
    findByName: overrides.findByName ?? repo.findAcademicSessionByName,
    update: overrides.update ?? repo.updateAcademicSessionForInstitution,
    setCurrent: overrides.setCurrent ?? repo.setCurrentAcademicSession,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => recordAuditLog(input)),
  };
}

function requireInstitution(actor: SessionUser): string {
  requirePermission(actor, "academicStructure.manage");
  if (!actor.institutionId) {
    throw new AcademicSessionError(
      "This account is not scoped to a single institution, so there are no academic years to manage here.",
    );
  }
  return actor.institutionId;
}

export async function listAcademicSessionSummariesForRequest(
  actor: SessionUser,
  overrides: AcademicSessionDeps = {},
): Promise<AcademicSessionSummary[]> {
  return deps(overrides).listSummaries(requireInstitution(actor));
}

export async function getAcademicSessionForRequest(
  actor: SessionUser,
  id: string,
  overrides: AcademicSessionDeps = {},
): Promise<AcademicSession> {
  const institutionId = requireInstitution(actor);
  const session = await deps(overrides).get(institutionId, id);
  if (!session) throw new AcademicSessionError("That academic year does not exist.");
  return session;
}

/**
 * The year this institution is in, or null.
 *
 * Null is a real answer, not an error: an institution that has just been
 * created has no current year until somebody picks one, and the screens that
 * need one say so rather than failing.
 */
export async function getCurrentAcademicSessionForRequest(
  actor: SessionUser,
  overrides: AcademicSessionDeps = {},
): Promise<AcademicSession | null> {
  return deps(overrides).getCurrent(requireInstitution(actor));
}

export interface UpdateAcademicSessionInput {
  name: unknown;
  startDate: unknown;
  endDate: unknown;
}

/**
 * Renames a year or moves its dates.
 *
 * The dates are not checked against the sessions already recorded inside the
 * year. Shortening a year does not delete a register, and an institution
 * correcting a typo in a date should not be told that three months of
 * attendance stand in the way — the log records the change, which is the thing
 * an auditor actually needs.
 */
export async function updateAcademicSessionForRequest(
  actor: SessionUser,
  id: string,
  input: UpdateAcademicSessionInput,
  overrides: AcademicSessionDeps = {},
): Promise<void> {
  const institutionId = requireInstitution(actor);
  const d = deps(overrides);

  const name = validateSessionName(input.name);
  const startDate = parseSessionDate(input.startDate, "start date");
  const endDate = parseSessionDate(input.endDate, "end date");
  validateDateRange(startDate, endDate);

  const existing = await d.get(institutionId, id);
  if (!existing) throw new AcademicSessionError("That academic year does not exist.");

  if (name !== existing.name) {
    const clash = await d.findByName(institutionId, name);
    if (clash && clash.id !== id) {
      throw new AcademicSessionError(`This institution already has an academic year called ${name}.`);
    }
  }

  const changed = await d.update(institutionId, id, { name, startDate, endDate });
  if (changed === 0) throw new AcademicSessionError("That academic year does not exist.");

  await d.audit({
    action: "academic_session.updated",
    entityType: "AcademicSession",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: {
      name: existing.name,
      startDate: existing.startDate.toISOString(),
      endDate: existing.endDate.toISOString(),
    },
    afterJson: {
      name,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    },
  });
}

/**
 * Makes one year the current one.
 *
 * Exclusive and transactional: the year that held the status loses it in the
 * same write, because two current years would mean two different answers to
 * "which year is this student being enrolled into".
 */
export async function setCurrentAcademicSessionForRequest(
  actor: SessionUser,
  id: string,
  overrides: AcademicSessionDeps = {},
): Promise<void> {
  const institutionId = requireInstitution(actor);
  const d = deps(overrides);

  const session = await d.get(institutionId, id);
  if (!session) throw new AcademicSessionError("That academic year does not exist.");
  if (session.isCurrent) {
    // Refused rather than quietly succeeding: a second success would write a
    // log row saying somebody switched the current year on a day nothing
    // changed.
    throw new AcademicSessionError(`${session.name} is already the current academic year.`);
  }

  const { changed, unset } = await d.setCurrent(institutionId, id);
  if (!changed) throw new AcademicSessionError("That academic year does not exist.");

  await d.audit({
    action: "academic_session.activated",
    entityType: "AcademicSession",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { isCurrent: false, isActive: session.isActive },
    // The years that stopped being current are named here, so the log can
    // answer "why did last year stop being the default" without a diff of two
    // separate rows.
    afterJson: { isCurrent: true, isActive: true, noLongerCurrent: unset },
  });
}

/**
 * Archives a year, or brings one back.
 *
 * Archiving never deletes: cohorts point at the year and the attendance under
 * them has to stay readable. The current year cannot be archived while it is
 * current — an institution with no current year has no answer to "which year
 * is this", and silently clearing it here would hide that decision inside an
 * action that says "archive".
 */
export async function setAcademicSessionArchivedForRequest(
  actor: SessionUser,
  id: string,
  archived: boolean,
  overrides: AcademicSessionDeps = {},
): Promise<void> {
  const institutionId = requireInstitution(actor);
  const d = deps(overrides);

  const session = await d.get(institutionId, id);
  if (!session) throw new AcademicSessionError("That academic year does not exist.");

  if (archived && !session.isActive) {
    throw new AcademicSessionError(`${session.name} is already archived.`);
  }
  if (!archived && session.isActive) {
    throw new AcademicSessionError(`${session.name} is not archived.`);
  }
  if (archived && session.isCurrent) {
    throw new AcademicSessionError(
      `${session.name} is the current academic year. Make another year current first, then archive this one.`,
    );
  }

  const changed = await d.update(institutionId, id, { isActive: !archived });
  if (changed === 0) throw new AcademicSessionError("That academic year does not exist.");

  await d.audit({
    // The action is derived from the transition, never passed in, so the log
    // cannot say the opposite of what happened.
    action: archived ? "academic_session.archived" : "academic_session.restored",
    entityType: "AcademicSession",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { isActive: session.isActive },
    afterJson: { isActive: !archived },
  });
}
