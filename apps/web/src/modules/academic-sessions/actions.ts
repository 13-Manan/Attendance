"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import {
  archiveAcademicSessionForRequest,
  createAcademicSessionForRequest,
} from "./service";

const createSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export interface CreateAcademicSessionFormState {
  error?: string;
}

export async function createAcademicSessionForm(
  _prev: CreateAcademicSessionFormState,
  formData: FormData,
): Promise<CreateAcademicSessionFormState> {
  const actor = await requireUser();
  if (!actor.institutionId) return { error: "Platform accounts cannot create academic sessions." };

  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
  });
  if (!parsed.success) return { error: "All fields are required." };

  try {
    await createAcademicSessionForRequest(actor, {
      institutionId: actor.institutionId,
      name: parsed.data.name,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
    });
  } catch {
    return { error: "Could not create academic session. Check dates and uniqueness." };
  }
  redirect("/dashboard/academic/sessions");
}

export async function archiveAcademicSession(id: string) {
  const actor = await requireUser();
  return archiveAcademicSessionForRequest(actor, id);
}
