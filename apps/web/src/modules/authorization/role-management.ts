import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requirePermission, requireSameInstitution } from "./service";

export interface AssignRoleInput {
  targetUserId: string;
  roleId: string;
  institutionId: string | null;
  campusId?: string | null;
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
