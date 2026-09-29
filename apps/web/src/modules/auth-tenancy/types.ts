import type { PermissionKey } from "@/modules/authorization/permissions";

// A role as resolved onto the current session — flattened from
// UserRoleAssignment -> Role -> RolePermission so callers never need to
// re-join the RBAC tables themselves.
export interface ResolvedRole {
  key: string;
  name: string;
  institutionId: string | null;
  campusId: string | null;
  permissions: PermissionKey[];
}

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
  // Null only for a platform-level user (see User.institutionId in schema.prisma).
  institutionId: string | null;
  campusId: string | null;
  roles: ResolvedRole[];
  /**
   * True while the account's password is one somebody else issued — a new
   * student login, or a reset — and its holder has not replaced it. Such a
   * session is good for choosing a password and nothing else: `requireUser`
   * sends it to the password change, and `getCurrentUser` answers null.
   */
  mustChangePassword?: boolean;
}
