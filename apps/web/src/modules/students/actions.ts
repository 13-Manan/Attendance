"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { createStudent as createStudentService, updateStudent as updateStudentService } from "./service";

const createStudentSchema = z.object({
  institutionId: z.string().min(1),
  campusId: z.string().min(1).nullable().optional(),
  studentCode: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().nullable().optional(),
  phone: z.string().min(1).nullable().optional(),
});

export async function createStudent(input: z.infer<typeof createStudentSchema>) {
  const actor = await requireUser();
  const parsed = createStudentSchema.parse(input);
  return createStudentService(actor, parsed);
}

const updateStudentSchema = z.object({
  studentId: z.string().min(1),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().min(1).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "TRANSFERRED", "COMPLETED"]).optional(),
});

export async function updateStudent(input: z.infer<typeof updateStudentSchema>) {
  const actor = await requireUser();
  const parsed = updateStudentSchema.parse(input);
  return updateStudentService(actor, parsed);
}

export interface CreateStudentFormState {
  error?: string;
}

/** Form-bound wrapper for the students/new page's useActionState form. */
export async function createStudentForm(
  _prevState: CreateStudentFormState,
  formData: FormData,
): Promise<CreateStudentFormState> {
  const actor = await requireUser();
  const parsed = createStudentSchema.safeParse({
    institutionId: formData.get("institutionId"),
    studentCode: formData.get("studentCode"),
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    email: formData.get("email") || null,
    phone: formData.get("phone") || null,
  });
  if (!parsed.success) {
    return { error: "Please fill in all required fields." };
  }

  try {
    await createStudentService(actor, parsed.data);
  } catch {
    return { error: "Could not create student. Check the student code is unique for this institution." };
  }

  redirect("/dashboard/students");
}
