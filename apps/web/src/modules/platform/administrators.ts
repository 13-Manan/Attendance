import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { hashPassword } from "@/modules/auth-tenancy/password";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requirePermission } from "@/modules/authorization/service";
import { TEMP_PASSWORD_NOTICE, type IssuedPassword } from "@/modules/faculty/directory-types";
import {
  GRANTABLE_ADMIN_ROLES,
  type GrantableAdminRole,
  type InstitutionAdministrator,
} from "./administrator-roles";

// The vocabulary lives in a server-free module so the form can render it too.
export { GRANTABLE_ADMIN_ROLES, defaultAdminRoleFor } from "./administrator-roles";
export type { GrantableAdminRole, InstitutionAdministrator } from "./administrator-roles";

/**
 * The one workflow that can put an administrator inside a tenant.
 *
 * ## Why this lives in the platform module rather than the faculty directory
 *
 * `modules/faculty` refuses a platform actor outright — `requireInstitution`
 * throws "this account is not scoped to a single institution" — and it should
 * keep refusing. That screen is an institution administering *itself*, and the
 * three roles it may grant (FACULTY, CLASS_TEACHER, ATTENDANCE_OPERATOR) are
 * deliberately the three that cannot administer anything. Widening it to admit
 * a platform caller would mean one function serving two very different trust
 * levels, which is how the wrong branch eventually runs.
 *
 * So the asymmetry is the design: an institution admin creates staff *below*
 * them, and only the platform tier creates the admin itself. Neither can climb.
 *
 * ## What this may and may not grant
 *
 * `GRANTABLE_ADMIN_ROLES` is an allow-list, not a denial of PLATFORM_SUPER_ADMIN.
 * The difference matters: a denial has to anticipate every bad value, an
 * allow-list has to anticipate every good one, and only the second fails safe
 * when the role catalogue grows. A new platform-capable role added tomorrow is
 * not grantable here unless somebody adds it here too.
 *
 * Every account this creates is bound to the institution passed in —
 * `institutionId` on both the user and the assignment. A user with a null
 * institution is a platform user, and this function has no path that produces
 * one.
 */

export interface CreateAdministratorInput {
  name: string;
  email: string;
  roleKey: string;
}

export interface CreatedAdministrator extends IssuedPassword {
  administrator: InstitutionAdministrator;
}

/** A refusal a platform administrator can act on, carrying no internal detail. */
export class AdministratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdministratorError";
  }
}

function requirePlatformAccess(actor: SessionUser): void {
  requirePermission(actor, "platform.institution.create");
}

/** Same generator the faculty directory uses: 16 URL-safe characters from a
 * CSPRNG, no ambiguous glyphs, not memorable by design. */
function newPassword(): string {
  return randomBytes(12).toString("base64url");
}

function requireName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw new AdministratorError("Enter the administrator's full name.");
  if (name.length > 120) throw new AdministratorError("The name must be 120 characters or fewer.");
  return name;
}

function requireEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email === "") throw new AdministratorError("Enter the administrator's email address.");
  if (email.length > 255) throw new AdministratorError("The email must be 255 characters or fewer.");
  // Deliberately permissive: the address has to be deliverable by the person
  // typing it, and a stricter pattern rejects real addresses more often than
  // it catches typos.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdministratorError("That does not look like an email address.");
  }
  return email;
}

function requireGrantableRole(raw: string): GrantableAdminRole {
  const key = raw.trim().toUpperCase();
  if ((GRANTABLE_ADMIN_ROLES as readonly string[]).includes(key)) {
    return key as GrantableAdminRole;
  }
  // Names the allowed set rather than the rejected value: a caller crafting a
  // request learns nothing about which other roles exist.
  throw new AdministratorError(
    `That role cannot be granted here. Choose one of: ${GRANTABLE_ADMIN_ROLES.join(", ")}.`,
  );
}

function serialize(row: {
  id: string;
  name: string;
  email: string;
  status: string;
  institutionId: string | null;
  createdAt: Date;
  roleAssignments: Array<{ role: { key: string } }>;
}): InstitutionAdministrator {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
    roleKeys: row.roleAssignments.map((assignment) => assignment.role.key),
    institutionId: row.institutionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Everyone in this institution holding one of the administrator roles.
 *
 * Scoped by `institutionId` on the user *and* on the assignment. Either alone
 * would be nearly right: a user belongs to one institution, and an assignment
 * names the institution it applies to, but the pair is what makes a row here
 * unambiguously this tenant's administrator.
 */
export async function listInstitutionAdministrators(
  actor: SessionUser,
  institutionId: string,
): Promise<InstitutionAdministrator[]> {
  requirePlatformAccess(actor);

  const rows = await prisma.user.findMany({
    where: {
      institutionId,
      roleAssignments: {
        some: {
          institutionId,
          role: { key: { in: [...GRANTABLE_ADMIN_ROLES] } },
        },
      },
    },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      institutionId: true,
      createdAt: true,
      roleAssignments: { select: { role: { select: { key: true } } } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });

  return rows.map(serialize);
}

/**
 * Creates an administrator for one institution, with a temporary password
 * returned exactly once.
 *
 * The user row and the role assignment are written in one transaction. An
 * account with no assignment can sign in and see nothing, which reads to its
 * owner as a broken product and to whoever created it as a finished job — the
 * faculty directory makes the same guarantee for the same reason.
 */
export async function createInstitutionAdministrator(
  actor: SessionUser,
  institutionId: string,
  input: CreateAdministratorInput,
): Promise<CreatedAdministrator> {
  requirePlatformAccess(actor);

  const name = requireName(input.name);
  const email = requireEmail(input.email);
  const roleKey = requireGrantableRole(input.roleKey);

  const institution = await prisma.institution.findUnique({
    where: { id: institutionId },
    select: { id: true, name: true, type: true },
  });
  if (!institution) throw new AdministratorError("That institution no longer exists.");

  // Addresses are unique across the whole platform, so this has to look
  // everywhere — but it must not say where. Confirming that an address already
  // belongs to some other tenant leaks who works where.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    throw new AdministratorError(
      `An account already uses ${email}. An address can only belong to one account.`,
    );
  }

  const role = await prisma.role.findFirst({
    where: { institutionId: null, key: roleKey },
    select: { id: true, key: true },
  });
  if (!role) {
    throw new AdministratorError(
      `The ${roleKey} role is not seeded on this deployment. Run the system bootstrap first.`,
    );
  }

  const password = newPassword();
  const passwordHash = await hashPassword(password);

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        // Never null. A null institution is what makes a platform user, and
        // this workflow does not create those.
        institutionId: institution.id,
        // Institution-wide rather than scoped to a campus: an administrator
        // has to be able to create the campuses, so cannot belong to one yet.
        campusId: null,
        name,
        email,
        passwordHash,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    await tx.userRoleAssignment.create({
      data: {
        userId: user.id,
        roleId: role.id,
        institutionId: institution.id,
        campusId: null,
      },
    });

    return user.id;
  });

  await recordAuditLog({
    action: "user.created",
    entityType: "User",
    entityId: created,
    institutionId: institution.id,
    actorUserId: actor.userId,
    // Who, and what access. Never the password, never the hash.
    afterJson: { name, email, roleKey, createdBy: "platform" },
  });

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: created },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      institutionId: true,
      createdAt: true,
      roleAssignments: { select: { role: { select: { key: true } } } },
    },
  });

  return { administrator: serialize(row), password, notice: TEMP_PASSWORD_NOTICE };
}

/**
 * Loads an administrator, refusing anything that is not one of *this*
 * institution's administrators.
 *
 * The role check is part of the lookup rather than a separate step: without
 * it, a platform caller could pass any user id in this tenant and reset a
 * teacher's password from a screen that says "administrators".
 */
async function requireAdministrator(institutionId: string, userId: string) {
  const row = await prisma.user.findFirst({
    where: {
      id: userId,
      institutionId,
      roleAssignments: {
        some: { institutionId, role: { key: { in: [...GRANTABLE_ADMIN_ROLES] } } },
      },
    },
    select: { id: true, email: true, status: true },
  });
  if (!row) {
    throw new AdministratorError("That account is not an administrator of this institution.");
  }
  return row;
}

/**
 * Issues a new temporary password and invalidates every session opened with
 * the old one.
 *
 * There is no way to read the existing password — nothing stores it — so
 * "resend it" is not something this could do even if asked.
 */
export async function resetAdministratorPassword(
  actor: SessionUser,
  institutionId: string,
  userId: string,
): Promise<IssuedPassword> {
  requirePlatformAccess(actor);

  const admin = await requireAdministrator(institutionId, userId);

  const password = newPassword();
  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: admin.id }, data: { passwordHash } });
    // The old password stops working here; the sessions it opened have to stop
    // with it, or a leaked password keeps its access until each one expires.
    await tx.session.deleteMany({ where: { userId: admin.id } });
  });

  await recordAuditLog({
    action: "user.updated",
    entityType: "User",
    entityId: admin.id,
    institutionId,
    actorUserId: actor.userId,
    afterJson: { email: admin.email, passwordReset: true, sessionsEnded: true },
  });

  return { password, notice: TEMP_PASSWORD_NOTICE };
}

/**
 * Deactivates or reactivates an administrator.
 *
 * Not a delete: the account authored audit rows and attendance decisions, and
 * those have to keep naming somebody. Deactivating ends their sessions and
 * stops them signing in again, which is what "remove their access" actually
 * means here.
 */
export async function setAdministratorStatus(
  actor: SessionUser,
  institutionId: string,
  userId: string,
  active: boolean,
): Promise<InstitutionAdministrator> {
  requirePlatformAccess(actor);

  const admin = await requireAdministrator(institutionId, userId);

  if (!active && admin.id === actor.userId) {
    // Unreachable today — a platform user has a null institution and so is
    // never one of these rows — but the cost of being wrong about that later
    // is an administrator who cannot undo what they just did.
    throw new AdministratorError("You cannot deactivate the account you are signed in with.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: admin.id },
      data: { status: active ? "ACTIVE" : "INACTIVE" },
    });
    if (!active) {
      await tx.session.deleteMany({ where: { userId: admin.id } });
    }
  });

  await recordAuditLog({
    action: active ? "user.reactivated" : "user.deactivated",
    entityType: "User",
    entityId: admin.id,
    institutionId,
    actorUserId: actor.userId,
    afterJson: { email: admin.email, status: active ? "ACTIVE" : "INACTIVE" },
  });

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: admin.id },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      institutionId: true,
      createdAt: true,
      roleAssignments: { select: { role: { select: { key: true } } } },
    },
  });

  return serialize(row);
}
