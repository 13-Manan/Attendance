import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { isPlatformUser, requirePermission, requireSameInstitution } from "./service";
import { ForbiddenError } from "./types";

export interface AssignRoleInput {
  targetUserId: string;
  roleId: string;
  institutionId: string | null;
  campusId?: string | null;
}

/** A `*.own` permission confers nothing over anybody else. See below. */
function isSelfScoped(permission: string): boolean {
  return permission.endsWith(".own");
}

/**
 * You cannot grant authority you do not hold.
 *
 * `role.assign` says an actor may administer roles. It does not say *which*
 * roles, and without this check it meant all of them: an institution admin
 * holding `role.assign` could pass `institutionId: null` — which skips
 * `requireSameInstitution` by construction — together with the
 * PLATFORM_SUPER_ADMIN role id, and mint a platform administrator.
 *
 * Measured before this existed: Greenwood's institution admin successfully
 * granted PLATFORM_SUPER_ADMIN to another user in their own tenant. That is
 * total compromise of every other institution on the platform, reachable by
 * anyone who could already manage their own staff.
 *
 * ## The rule
 *
 * Every permission the role carries must be one the actor already holds.
 * That is the general form — it keeps working as institutions rename or
 * re-scope roles, and it needs no hierarchy table to maintain.
 *
 * ## The exception, and why it is not a hole
 *
 * Self-scoped permissions (`*.own`) are always grantable. They confer
 * nothing over anybody else: `attendanceRecord.read.own` lets the holder read
 * their *own* attendance and no one else's. Without this exception an
 * institution admin could not create a student account, because no
 * administrator holds `student.read.own` — they are not a student. Requiring
 * an admin to hold a permission that is meaningless for an admin would make
 * the rule unusable rather than strict.
 *
 * ## Why the role's own scoping is not the test
 *
 * Every role in this deployment is a *system* role with `institutionId: null`
 * (see `SYSTEM_ROLES`), shared across tenants and specialised per assignment.
 * So "is this role platform-scoped" cannot distinguish PLATFORM_SUPER_ADMIN
 * from FACULTY — both are. What distinguishes them is what they *carry*,
 * which is what this checks. The explicit `platform.` guard below is
 * redundant with the subset rule and kept anyway, because a named refusal
 * reads better in an audit log than a permission diff.
 */
async function assertMayGrantRole(
  actor: SessionUser,
  input: AssignRoleInput,
): Promise<void> {
  const role = await prisma.role.findUnique({
    where: { id: input.roleId },
    select: { id: true, key: true, institutionId: true, permissions: true },
  });
  // Indistinguishable from "you may not grant it": a caller must not be able
  // to probe which role ids exist by watching the error change.
  if (!role) throw new ForbiddenError("role_not_grantable");

  // A role belonging to another institution is never grantable, whatever it
  // carries. Roles with a null institution are the shared system roles and
  // are filtered by their permissions instead.
  if (role.institutionId !== null) {
    requireSameInstitution(actor, role.institutionId);
  }

  const granting = role.permissions.map((row) => row.permission);

  if (granting.some((permission) => permission.startsWith("platform.")) && !isPlatformUser(actor)) {
    throw new ForbiddenError("platform_role_not_grantable");
  }

  const held = new Set<string>(actor.roles.flatMap((assigned) => assigned.permissions));
  const beyond = granting.filter(
    (permission) => !held.has(permission) && !isSelfScoped(permission),
  );
  if (beyond.length > 0) {
    throw new ForbiddenError(`cannot_grant_unheld_permissions:${beyond.join(",")}`);
  }
}

/**
 * The only code path that creates a UserRoleAssignment — always inside a
 * transaction that also writes the "user.role_changed" audit row, mirroring
 * how modules/attendance/service.ts pairs every finalResult mutation with
 * an AttendanceCorrection insert.
 */
export async function assignRole(actor: SessionUser, input: AssignRoleInput) {
  requirePermission(actor, "role.assign");
  if (input.institutionId) {
    requireSameInstitution(actor, input.institutionId);
  }

  await assertMayGrantRole(actor, input);

  return prisma.$transaction(async (tx) => {
    const before = await tx.userRoleAssignment.findMany({
      where: { userId: input.targetUserId },
      include: { role: true },
    });

    const assignment = await tx.userRoleAssignment.create({
      data: {
        userId: input.targetUserId,
        roleId: input.roleId,
        institutionId: input.institutionId,
        campusId: input.campusId ?? null,
      },
    });

    const after = await tx.userRoleAssignment.findMany({
      where: { userId: input.targetUserId },
      include: { role: true },
    });

    await recordAuditLog(
      {
        action: "user.role_changed",
        entityType: "User",
        entityId: input.targetUserId,
        institutionId: input.institutionId,
        actorUserId: actor.userId,
        beforeJson: { roleKeys: before.map((r) => r.role.key) },
        afterJson: { roleKeys: after.map((r) => r.role.key) },
      },
      tx,
    );

    return assignment;
  });
}
