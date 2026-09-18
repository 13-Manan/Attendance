"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { assignRole as assignRoleService } from "./role-management";

const inputSchema = z.object({
  targetUserId: z.string().min(1),
  roleId: z.string().min(1),
  institutionId: z.string().min(1).nullable(),
  campusId: z.string().min(1).nullable().optional(),
});

export async function assignRole(input: z.infer<typeof inputSchema>) {
  const actor = await requireUser();
  const parsed = inputSchema.parse(input);
  return assignRoleService(actor, parsed);
}
