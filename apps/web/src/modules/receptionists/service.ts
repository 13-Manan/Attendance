import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hashPassword } from "@/modules/auth-tenancy/password";
import { requirePermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getInstitutionType } from "@/modules/institutions/repository";
import { accessFromPermissions, defaultAccess } from "./catalog";
import {
  grantableAccess,
  validateReceptionistEmail,
  validateReceptionistName,
  validateReceptionistPhone,
} from "./policy";
import * as repo from "./repository";
import {
  ReceptionistError,
  type IssuedReceptionistPassword,
  type NewReceptionist,
  type ReceptionistSummary,
} from "./types";

/**
 * A school's receptionists, managed by its principal.
 *
 * Who may: the holder of `role.assign` — the administrator's authority to
 * give people roles, which a receptionist can never be granted (see
 * `NEVER_GRANTABLE`) — in their own institution, which must be a school.
 * The institution is always the actor's; nothing here takes one from a
 * request, and an id that is not one of this school's receptionists is
 * "not found", whichever school it belongs to.
 *
 * What it does: an ordinary account with its own institution-scoped role.
 * The principal switches access on and off; the role's grants change, and
 * the receptionist's very next request is decided by them — sessions read
 * their permissions from the database every time. The temporary password is
 * shown once and must be replaced at first sign-in; it is never stored in a
 * readable form, and a lost one is replaced, not recovered.
 */

const TEMP_PASSWORD_BYTES = 12;

function newTemporaryPassword(): string {
  // 16 characters of base64url: the same strength as a teacher's.
  return randomBytes(TEMP_PASSWORD_BYTES).toString("base64url");
}

async function requireManager(actor: SessionUser): Promise<string> {
  requirePermission(actor, "role.assign");
  const institutionId = actor.institutionId;
  if (!institutionId) throw new ForbiddenError("no_institution");
  if ((await getInstitutionType(institutionId)) !== "SCHOOL") {
    throw new ReceptionistError("Receptionist accounts are for schools.");
  }
  return institutionId;
}

function summaryOf(row: repo.ReceptionistRow, phone: string | null): ReceptionistSummary {
  const permissions = row.roleAssignments.flatMap((assignment) =>
    assignment.role.permissions.map((grant) => grant.permission),
  );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone,
    status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    access: accessFromPermissions(permissions),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    mustChangePassword: row.mustChangePassword,
  };
}

async function requireReceptionist(institutionId: string, userId: unknown): Promise<repo.ReceptionistRow> {
  const id = typeof userId === "string" ? userId.trim() : "";
  const row = id === "" || id.length > 64 ? null : await repo.getReceptionistRow(institutionId, id);
  if (!row) throw new ReceptionistError("That receptionist could not be found.");
  return row;
}

async function withPhone(institutionId: string, row: repo.ReceptionistRow | null): Promise<ReceptionistSummary> {
  if (!row) throw new ReceptionistError("That receptionist could not be found.");
  const phones = await repo.latestPhones(institutionId, [row.id]);
  return summaryOf(row, phones.get(row.id) ?? null);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listReceptionists(actor: SessionUser): Promise<ReceptionistSummary[]> {
  const institutionId = await requireManager(actor);
  const rows = await repo.listReceptionistRows(institutionId);
  const phones = await repo.latestPhones(institutionId, rows.map((row) => row.id));
  return rows.map((row) => summaryOf(row, phones.get(row.id) ?? null));
}

export async function getReceptionist(actor: SessionUser, userId: unknown): Promise<ReceptionistSummary> {
  const institutionId = await requireManager(actor);
  return withPhone(institutionId, await requireReceptionist(institutionId, userId));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function createReceptionist(
  actor: SessionUser,
  input: { name: unknown; email: unknown; phone?: unknown; access?: readonly string[] },
): Promise<NewReceptionist> {
  const institutionId = await requireManager(actor);
  const name = validateReceptionistName(input.name);
  const email = validateReceptionistEmail(input.email);
  const phone = validateReceptionistPhone(input.phone);
  // Useful from the first sign-in: the everyday work on, administration off.
  const { access, permissions } = grantableAccess(actor, input.access ?? defaultAccess());

  const taken = () =>
    new ReceptionistError(
      `An account already uses ${email}. If that is the same person, ask the platform administrator — an address can only belong to one account.`,
    );
  if (await repo.findAccountByEmail(email)) throw taken();

  const password = newTemporaryPassword();
  let row: repo.ReceptionistRow;
  try {
    row = await repo.createReceptionistAccount({
      institutionId,
      name,
      email,
      passwordHash: await hashPassword(password),
      permissions,
      audit: (userId) => ({
        action: "receptionist.created",
        entityType: "User",
        entityId: userId,
        institutionId,
        actorUserId: actor.userId,
        // No password, no hash: the facts of the account and what it may do.
        afterJson: { name, email, phone, access, passwordChangeRequired: true },
      }),
    });
  } catch (error) {
    // Two principals adding the same address at once: the database decides.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw taken();
    throw error;
  }
  return { receptionist: summaryOf(row, phone), password };
}

/** Name and phone. The email is what they sign in with: a different address is a different account. */
export async function updateReceptionist(
  actor: SessionUser,
  userId: unknown,
  input: { name: unknown; phone?: unknown },
): Promise<ReceptionistSummary> {
  const institutionId = await requireManager(actor);
  const before = await requireReceptionist(institutionId, userId);
  const name = validateReceptionistName(input.name);
  const phone = validateReceptionistPhone(input.phone);
  const phoneBefore = (await repo.latestPhones(institutionId, [before.id])).get(before.id) ?? null;

  const row = await repo.updateReceptionistName(institutionId, before.id, name, {
    action: "receptionist.updated",
    entityType: "User",
    entityId: before.id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { name: before.name, phone: phoneBefore },
    afterJson: { name, phone },
  });
  if (!row) throw new ReceptionistError("That receptionist could not be found.");
  return summaryOf(row, phone);
}

export async function setReceptionistAccess(
  actor: SessionUser,
  userId: unknown,
  requested: readonly string[],
): Promise<ReceptionistSummary> {
  const institutionId = await requireManager(actor);
  const before = await requireReceptionist(institutionId, userId);
  const { access, permissions } = grantableAccess(actor, requested);
  const accessBefore = summaryOf(before, null).access;

  const row = await repo.replaceReceptionistPermissions(institutionId, before.id, permissions, {
    action: "receptionist.permissions_changed",
    entityType: "User",
    entityId: before.id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { access: accessBefore },
    afterJson: {
      access,
      turnedOn: access.filter((id) => !accessBefore.includes(id)),
      turnedOff: accessBefore.filter((id) => !access.includes(id)),
    },
  });
  return withPhone(institutionId, row);
}

export async function setReceptionistActive(
  actor: SessionUser,
  userId: unknown,
  active: boolean,
): Promise<ReceptionistSummary> {
  const institutionId = await requireManager(actor);
  const before = await requireReceptionist(institutionId, userId);
  const status = active ? "ACTIVE" : "INACTIVE";
  if (before.status === status) {
    throw new ReceptionistError(active ? "That account is already switched on." : "That account is already switched off.");
  }
  const row = await repo.setReceptionistStatus(institutionId, before.id, status, {
    action: active ? "receptionist.enabled" : "receptionist.disabled",
    entityType: "User",
    entityId: before.id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { status: before.status },
    afterJson: { status, ...(active ? {} : { sessionsEnded: true }) },
  });
  return withPhone(institutionId, row);
}

/** A new temporary password, shown once; the old one and every session stop working now. */
export async function resetReceptionistPassword(
  actor: SessionUser,
  userId: unknown,
): Promise<IssuedReceptionistPassword> {
  const institutionId = await requireManager(actor);
  const before = await requireReceptionist(institutionId, userId);
  const password = newTemporaryPassword();
  const row = await repo.setReceptionistPassword(institutionId, before.id, await hashPassword(password), {
    action: "receptionist.password_reset",
    entityType: "User",
    entityId: before.id,
    institutionId,
    actorUserId: actor.userId,
    // States the fact; carries neither password nor hash.
    afterJson: { email: before.email, passwordChangeRequired: true, sessionsEnded: true },
  });
  if (!row) throw new ReceptionistError("That receptionist could not be found.");
  return { email: row.email, password };
}
