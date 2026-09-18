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
}
