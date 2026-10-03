import type { SessionUser } from "@/modules/auth-tenancy/types";
import { ForbiddenError } from "./types";
import type { PermissionKey } from "./permissions";

const PLATFORM_ROLE_KEY = "PLATFORM_SUPER_ADMIN";

// Pure — no Prisma import, deliberately, so this is unit-testable against
// plain fixtures without a live database (see service.test.ts).
export function hasPermission(user: SessionUser, permission: PermissionKey): boolean {
  return user.roles.some((role) => role.permissions.includes(permission));
}

export function requirePermission(user: SessionUser, permission: PermissionKey): void {
  if (!hasPermission(user, permission)) {
    throw new ForbiddenError(permission);
  }
}

/** Holds `permission`, or one of its narrower `alternatives` (see permissions.ts). */
export function hasAnyPermission(
  user: SessionUser,
  permission: PermissionKey,
  ...alternatives: PermissionKey[]
): boolean {
  return hasPermission(user, permission) || alternatives.some((key) => hasPermission(user, key));
}

/**
 * `requirePermission`, accepting a narrower alternative too. A refusal still
 * names the primary permission, so callers and their tests see the same
 * ForbiddenError they always did.
 */
export function requireAnyPermission(
  user: SessionUser,
  permission: PermissionKey,
  ...alternatives: PermissionKey[]
): void {
  if (!hasAnyPermission(user, permission, ...alternatives)) {
    throw new ForbiddenError(permission);
  }
}

export function isPlatformUser(user: SessionUser): boolean {
  return user.roles.some((role) => role.key === PLATFORM_ROLE_KEY);
}

/**
 * Cross-institution guard (product requirement: "cross-institution data
 * access" must be denied). Platform-level users bypass this by definition —
 * everyone else must match the institution they belong to.
 */
export function requireSameInstitution(user: SessionUser, institutionId: string): void {
  if (isPlatformUser(user)) return;
  if (user.institutionId !== institutionId) {
    throw new ForbiddenError("cross_institution");
  }
}
