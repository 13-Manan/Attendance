import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { RecordAuditLogInput } from "./types";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Thin insert into the generic AuditLog table. Callers that mutate data
 * inside a `prisma.$transaction` should pass that transaction client as
 * `tx` so the audit row commits atomically with the mutation it describes —
 * the same discipline modules/attendance/service.ts already uses for
 * AttendanceCorrection.
 */
export async function recordAuditLog(input: RecordAuditLogInput, tx: Client = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      institutionId: input.institutionId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorApiKeyId: input.actorApiKeyId ?? null,
      beforeJson: input.beforeJson as Prisma.InputJsonValue,
      afterJson: input.afterJson as Prisma.InputJsonValue,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
