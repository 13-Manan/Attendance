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
