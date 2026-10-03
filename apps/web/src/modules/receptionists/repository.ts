import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { RECEPTIONIST_ROLE_NAME, RECEPTIONIST_ROLE_PREFIX, receptionistRoleKey } from "./catalog";

/**
 * Receptionist accounts in the database. Each is an ordinary `User` with one
 * institution-scoped role of its own (`RECEPTIONIST__<userId>`, isSystem false)
 * whose `RolePermission` rows are exactly what the principal switched on — no
 * schema of its own. Every write here commits with its audit row, so a change
 * without its record cannot exist.
 *
 * Every lookup is pinned to an institution *and* to that institution's
 * receptionist role: an id from another school, or of an account that is not a
 * receptionist, is simply not found.
 */

const SELECT = {
  id: true,
  name: true,
  email: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  mustChangePassword: true,
  roleAssignments: {
    where: { role: { key: { startsWith: RECEPTIONIST_ROLE_PREFIX } } },
    select: {
      role: { select: { id: true, key: true, institutionId: true, permissions: { select: { permission: true } } } },
    },
  },
} satisfies Prisma.UserSelect;

export type ReceptionistRow = Prisma.UserGetPayload<{ select: typeof SELECT }>;

function receptionistWhere(institutionId: string): Prisma.UserWhereInput {
  return {
    institutionId,
    roleAssignments: { some: { role: { key: { startsWith: RECEPTIONIST_ROLE_PREFIX }, institutionId } } },
  };
}

export function listReceptionistRows(institutionId: string): Promise<ReceptionistRow[]> {
  return prisma.user.findMany({
    where: receptionistWhere(institutionId),
    select: SELECT,
    orderBy: [{ status: "asc" }, { name: "asc" }],
    take: 200,
  });
}

export function getReceptionistRow(institutionId: string, userId: string): Promise<ReceptionistRow | null> {
  return prisma.user.findFirst({ where: { id: userId, ...receptionistWhere(institutionId) }, select: SELECT });
}

/** Any account at all with this address, in any institution: an address belongs to one account. */
export function findAccountByEmail(email: string): Promise<{ id: string } | null> {
  return prisma.user.findUnique({ where: { email }, select: { id: true } });
}

/**
 * The phone number each receptionist was last given, from their own audit rows
 * (`receptionist.created` / `.updated` carry it) — the same no-schema pattern
 * twin confirmations use. Missing means none was ever recorded.
 */
export async function latestPhones(institutionId: string, userIds: readonly string[]): Promise<Map<string, string | null>> {
  const phones = new Map<string, string | null>();
  if (userIds.length === 0) return phones;
  const rows = await prisma.auditLog.findMany({
    where: {
      institutionId,
      entityType: "User",
      entityId: { in: [...userIds] },
      action: { in: ["receptionist.created", "receptionist.updated"] },
    },
    select: { entityId: true, afterJson: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of rows) {
    if (phones.has(row.entityId)) continue;
    const after = row.afterJson as Record<string, unknown> | null;
    if (after && "phone" in after) phones.set(row.entityId, typeof after.phone === "string" ? after.phone : null);
  }
  return phones;
}

export async function createReceptionistAccount(input: {
  institutionId: string;
  name: string;
  email: string;
  passwordHash: string;
  permissions: readonly string[];
  audit: (userId: string) => RecordAuditLogInput;
}): Promise<ReceptionistRow> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        institutionId: input.institutionId,
        email: input.email,
        name: input.name,
        status: "ACTIVE",
        passwordHash: input.passwordHash,
        // Their first sign-in is to choose their own.
        mustChangePassword: true,
      },
      select: { id: true },
    });
    const role = await tx.role.create({
      data: {
        institutionId: input.institutionId,
        key: receptionistRoleKey(user.id),
        name: RECEPTIONIST_ROLE_NAME,
        isSystem: false,
        permissions: { create: input.permissions.map((permission) => ({ permission })) },
      },
      select: { id: true },
    });
    await tx.userRoleAssignment.create({
      data: { userId: user.id, roleId: role.id, institutionId: input.institutionId },
    });
    await recordAuditLog(input.audit(user.id), tx);
    return tx.user.findUniqueOrThrow({ where: { id: user.id }, select: SELECT });
  });
}

export async function updateReceptionistName(
  institutionId: string,
  userId: string,
  name: string,
  audit: RecordAuditLogInput,
): Promise<ReceptionistRow | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({ where: { id: userId, ...receptionistWhere(institutionId) }, data: { name } });
    if (updated.count === 0) return null;
    await recordAuditLog(audit, tx);
    return tx.user.findFirst({ where: { id: userId }, select: SELECT });
  });
}

/** Replaces the role's grants with exactly these; takes effect on the receptionist's next request. */
export async function replaceReceptionistPermissions(
  institutionId: string,
  userId: string,
  permissions: readonly string[],
  audit: RecordAuditLogInput,
): Promise<ReceptionistRow | null> {
  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findFirst({
      where: {
        key: receptionistRoleKey(userId),
        institutionId,
        assignments: { some: { userId, user: { institutionId } } },
      },
      select: { id: true },
    });
    if (!role) return null;
    await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
    if (permissions.length > 0) {
      await tx.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permission })) });
    }
    await recordAuditLog(audit, tx);
    return tx.user.findFirst({ where: { id: userId }, select: SELECT });
  });
}

/** Stopping an account ends its sessions in the same transaction: the refusal is immediate. */
export async function setReceptionistStatus(
  institutionId: string,
  userId: string,
  status: "ACTIVE" | "INACTIVE",
  audit: RecordAuditLogInput,
): Promise<ReceptionistRow | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({ where: { id: userId, ...receptionistWhere(institutionId) }, data: { status } });
    if (updated.count === 0) return null;
    if (status === "INACTIVE") await tx.session.deleteMany({ where: { userId } });
    await recordAuditLog(audit, tx);
    return tx.user.findFirst({ where: { id: userId }, select: SELECT });
  });
}

/** A new temporary password: every session ends, and the next sign-in must replace it. */
export async function setReceptionistPassword(
  institutionId: string,
  userId: string,
  passwordHash: string,
  audit: RecordAuditLogInput,
): Promise<ReceptionistRow | null> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, ...receptionistWhere(institutionId) },
      data: { passwordHash, mustChangePassword: true },
    });
    if (updated.count === 0) return null;
    await tx.session.deleteMany({ where: { userId } });
    await recordAuditLog(audit, tx);
    return tx.user.findFirst({ where: { id: userId }, select: SELECT });
  });
}
