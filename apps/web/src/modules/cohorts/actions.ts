"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import {
  assignFacultyToCohortForRequest,
  createCohortForRequest,
} from "./service";

const createSchema = z.object({
  academicUnitId: z.string().min(1),
  academicSessionId: z.string().min(1),
  name: z.string().min(1),
  termLabel: z.string().min(1).optional(),
});

export interface CreateCohortFormState {
  error?: string;
}

export async function createCohortForm(
  _prev: CreateCohortFormState,
  formData: FormData,
): Promise<CreateCohortFormState> {
  const actor = await requireUser();
  if (!actor.institutionId) return { error: "Platform accounts cannot create cohorts." };

  const parsed = createSchema.safeParse({
    academicUnitId: formData.get("academicUnitId"),
    academicSessionId: formData.get("academicSessionId"),
    name: formData.get("name"),
    termLabel: formData.get("termLabel") || undefined,
  });
  if (!parsed.success) return { error: "Please fill in all required fields." };

  try {
    await createCohortForRequest(actor, {
      institutionId: actor.institutionId,
      academicUnitId: parsed.data.academicUnitId,
      academicSessionId: parsed.data.academicSessionId,
      name: parsed.data.name,
      termLabel: parsed.data.termLabel ?? null,
    });
  } catch {
    return { error: "Could not create cohort. Check the academic unit and session are in your institution." };
  }
  redirect("/dashboard/academic/cohorts");
}

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
