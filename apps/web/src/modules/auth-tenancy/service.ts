import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { hmacHash } from "@/lib/crypto";
import { recordAuditLog } from "@/modules/audit/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { hashPassword, verifyPassword } from "./password";
import { findUserByEmail, findActiveSessionByTokenHash } from "./repository";
import type { ResolvedRole, SessionUser } from "./types";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type UserWithRoles = NonNullable<Awaited<ReturnType<typeof findUserByEmail>>>;

/** Flattens UserRoleAssignment -> Role -> RolePermission onto one SessionUser. */
export function toSessionUser(user: UserWithRoles): SessionUser {
  const roles: ResolvedRole[] = user.roleAssignments.map((assignment) => ({
    key: assignment.role.key,
    name: assignment.role.name,
    institutionId: assignment.institutionId,
    campusId: assignment.campusId,
    permissions: assignment.role.permissions.map((p) => p.permission as PermissionKey),
  }));

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    institutionId: user.institutionId,
    campusId: user.campusId,
    roles,
  };
}

export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type LoginResult =
  | { ok: true; rawToken: string; user: SessionUser }
  | { ok: false; reason: "invalid_credentials" | "account_inactive" };

/**
 * Next-agnostic: no cookies()/redirect() calls here, so this is unit
 * -testable and reusable if a non-cookie client (e.g. a future mobile app)
 * ever needs to authenticate. The Server Action wrapper (actions.ts) owns
 * the cookie.
 */
export async function loginService(
  email: string,
  password: string,
  context: RequestContext = {},
): Promise<LoginResult> {
  const user = await findUserByEmail(email);

  // Same failure path (and near-identical timing) whether the account
  // exists, the password is wrong, or there's no password set at all —
  // never reveal which case it was.
  const passwordValid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !passwordValid) {
    await recordAuditLog({
      action: "auth.login.failure",
      entityType: "User",
      entityId: user?.id ?? email,
      institutionId: user?.institutionId ?? null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status !== "ACTIVE") {
    await recordAuditLog({
      action: "auth.login.failure",
      entityType: "User",
      entityId: user.id,
      actorUserId: user.id,
      institutionId: user.institutionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return { ok: false, reason: "account_inactive" };
  }

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hmacHash(env.AUTH_SECRET, rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.$transaction(async (tx) => {
    await tx.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
      },
    });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAuditLog(
      {
        action: "auth.login.success",
        entityType: "User",
        entityId: user.id,
        actorUserId: user.id,
        institutionId: user.institutionId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      tx,
    );
  });

  return { ok: true, rawToken, user: toSessionUser(user) };
}

export async function logoutService(rawToken: string): Promise<void> {
  const tokenHash = hmacHash(env.AUTH_SECRET, rawToken);
  const session = await findActiveSessionByTokenHash(tokenHash);
  if (!session || session.revokedAt) return;

  await prisma.$transaction(async (tx) => {
    await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await recordAuditLog(
      {
        action: "auth.logout",
        entityType: "User",
        entityId: session.userId,
        actorUserId: session.userId,
        institutionId: session.user.institutionId,
      },
      tx,
    );
  });
}

/** Used only by the seed script / a future user-provisioning admin flow. */
export { hashPassword };

export async function getSessionUserByRawToken(rawToken: string): Promise<SessionUser | null> {
  const tokenHash = hmacHash(env.AUTH_SECRET, rawToken);
  const session = await findActiveSessionByTokenHash(tokenHash);
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.status !== "ACTIVE") return null;
  return toSessionUser(session.user);
}
