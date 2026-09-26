import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { hmacHash } from "@/lib/crypto";
import { recordAuditLog } from "@/modules/audit/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { hashPassword, verifyPassword } from "./password";
import {
  countRecentLoginFailures,
  findActiveSessionByTokenHash,
  findStudentAccountsByCode,
  findUserByEmail,
} from "./repository";
import { checkSessionUsable } from "./session-policy";
import {
  STUDENT_LOGIN_THROTTLE,
  isPlaceholderLoginEmail,
  isThrottled,
  newPasswordProblem,
  pickByStudentCode,
} from "./student-login-policy";
import type { ResolvedRole, SessionUser } from "./types";

export { checkSessionUsable };
export type { SessionRejection } from "./session-policy";

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
  | { ok: false; reason: "invalid_credentials" | "account_inactive" | "throttled" };

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
  // A student account with no address of its own carries a reserved-domain
  // stand-in (see student-login-policy.ts). It is not a way in: the student ID
  // is. Refused through the same path as an unknown address.
  const user = isPlaceholderLoginEmail(email) ? null : await findUserByEmail(email);

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

  // A student's account works only while the student is on roll.
  if (user.studentProfile && user.studentProfile.status !== "ACTIVE") {
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

  return startSession(user, context);
}

/**
 * Opens a session for an account that has just proved who it is. Shared by
 * both ways of signing in, so a session is the same thing however it began:
 * one row per sign-in — a second device signs in beside the first, it does
 * not replace it — a seven-day expiry, and an audit row.
 */
async function startSession(user: UserWithRoles, context: RequestContext): Promise<LoginResult> {
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
  if (!session) return null;
  if (checkSessionUsable(session)) return null;
  return toSessionUser(session.user);
}

/**
 * Signs a student in with their student ID, within one institution.
 *
 * The same checks, in the same order, as `loginService` — the password is
 * verified with the same KDF, an inactive account and an archived student are
 * refused, and every attempt is audited the same way — plus one more: a
 * student ID is short and often sequential, so after
 * `STUDENT_LOGIN_THROTTLE.maxFailures` failed attempts on an account within the
 * window, further attempts are refused without checking the password.
 *
 * The institution comes from the student sign-in link; the ID is looked up
 * within it and nowhere else, so it cannot reach another institution's
 * student.
 */
export async function loginWithStudentIdService(
  institutionId: string,
  studentId: string,
  password: string,
  context: RequestContext = {},
): Promise<LoginResult> {
  const student = pickByStudentCode(studentId, await findStudentAccountsByCode(institutionId, studentId));
  const user = student?.user ?? null;

  if (user) {
    const since = new Date(Date.now() - STUDENT_LOGIN_THROTTLE.windowMs);
    if (isThrottled(await countRecentLoginFailures(user.id, since))) {
      return { ok: false, reason: "throttled" };
    }
  }

  const passwordValid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;

  if (!student || !user || !passwordValid || user.institutionId !== institutionId) {
    await recordAuditLog({
      action: "auth.login.failure",
      entityType: "User",
      entityId: user?.id ?? `student:${institutionId}:${studentId}`,
      institutionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status !== "ACTIVE" || student.status !== "ACTIVE") {
    await recordAuditLog({
      action: "auth.login.failure",
      entityType: "User",
      entityId: user.id,
      actorUserId: user.id,
      institutionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return { ok: false, reason: "account_inactive" };
  }

  return startSession(user, context);
}

export type ChangePasswordResult =
  | { ok: true; otherSessionsEnded: number }
  | { ok: false; error: string };

/**
 * A signed-in person replacing their own password.
 *
 * The current password is checked, the new one is held to
 * `newPasswordProblem`, and only its hash is stored. Every *other* session on
 * the account ends — on a shared student account that signs the other devices
 * out, which is the point of changing a password someone else may know — and
 * the session making the change stays signed in. The audit row says that it
 * happened and how many sessions ended; it carries no password, hash or token.
 */
export async function changeOwnPasswordService(
  userId: string,
  currentRawToken: string,
  input: { current: string; next: string; confirm: string },
): Promise<ChangePasswordResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      institutionId: true,
      passwordHash: true,
      studentProfile: { select: { studentCode: true } },
    },
  });
  if (!user?.passwordHash || !(await verifyPassword(input.current, user.passwordHash))) {
    return { ok: false, error: "The current password is not correct." };
  }

  const problem = newPasswordProblem({ ...input, loginId: user.studentProfile?.studentCode });
  if (problem) return { ok: false, error: problem };

  const passwordHash = await hashPassword(input.next);
  const currentTokenHash = hmacHash(env.AUTH_SECRET, currentRawToken);

  const otherSessionsEnded = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    const ended = await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null, tokenHash: { not: currentTokenHash } },
      data: { revokedAt: new Date() },
    });
    await recordAuditLog(
      {
        action: "user.updated",
        entityType: "User",
        entityId: user.id,
        actorUserId: user.id,
        institutionId: user.institutionId,
        afterJson: { passwordChanged: true, changedBy: "self", otherSessionsEnded: ended.count },
      },
      tx,
    );
    return ended.count;
  });

  return { ok: true, otherSessionsEnded };
}
