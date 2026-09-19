"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { assignFacultyToCohortForRequest } from "./service";

/**
 * Creating a class used to live here too. It now lives in
 * `directory-actions.ts#createCohortAction`, which validates in sentences
 * rather than in a single "fill in all required fields", redisplays what was
 * typed after a refusal, and lands on the class it just made. This file kept
 * only the faculty assignment.
 */

const assignSchema = z.object({
  cohortId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["PRIMARY", "ASSISTANT"]),
});

export interface AssignFacultyFormState {
  error?: string;
}

export async function assignCohortFacultyForm(
  _prev: AssignFacultyFormState,
  formData: FormData,
): Promise<AssignFacultyFormState> {
  const actor = await requireUser();
  const parsed = assignSchema.safeParse({
    cohortId: formData.get("cohortId"),
    userId: formData.get("userId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: "Please fill in all fields." };

  try {
    await assignFacultyToCohortForRequest(actor, parsed.data);
  } catch {
    return { error: "Could not assign faculty. Check the user belongs to your institution." };
  }
  return {};
}
