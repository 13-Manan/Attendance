"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { createAcademicUnitForRequest } from "./service";

const createSchema = z.object({
  kind: z.enum(["DEPARTMENT", "GRADE", "SEMESTER", "COURSE", "SECTION", "GENERIC"]),
  name: z.string().min(1),
  code: z.string().min(1).optional(),
  parentId: z.string().min(1).nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export interface CreateAcademicUnitFormState {
  error?: string;
}

export async function createAcademicUnitForm(
  _prev: CreateAcademicUnitFormState,
  formData: FormData,
): Promise<CreateAcademicUnitFormState> {
  const actor = await requireUser();
  if (!actor.institutionId) return { error: "Platform accounts cannot create academic units." };

  const parsed = createSchema.safeParse({
    kind: formData.get("kind"),
    name: formData.get("name"),
    code: formData.get("code") || undefined,
    parentId: formData.get("parentId") || null,
    sortOrder: formData.get("sortOrder") || undefined,
  });
  if (!parsed.success) return { error: "Please fill in all required fields." };

  try {
    await createAcademicUnitForRequest(actor, {
      institutionId: actor.institutionId,
      kind: parsed.data.kind,
      name: parsed.data.name,
      code: parsed.data.code ?? null,
      parentId: parsed.data.parentId ?? null,
      sortOrder: parsed.data.sortOrder ?? 0,
    });
  } catch {
    return { error: "Could not create academic unit. Check the kind is valid for this institution." };
  }
  redirect("/dashboard/academic/units");
}
