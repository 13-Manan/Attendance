"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import {
  attachSubjectToCohortForRequest,
  createSubjectForRequest,
  enrollStudentInSubjectForRequest,
} from "./service";

const createSubjectSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});

export interface CreateSubjectFormState {
  error?: string;
}

export async function createSubjectForm(
  _prev: CreateSubjectFormState,
  formData: FormData,
): Promise<CreateSubjectFormState> {
  const actor = await requireUser();
  if (!actor.institutionId) return { error: "Platform accounts cannot create subjects." };

  const parsed = createSubjectSchema.safeParse({
    code: formData.get("code"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { error: "Please fill in all fields." };

  try {
    await createSubjectForRequest(actor, {
      institutionId: actor.institutionId,
      code: parsed.data.code,
      name: parsed.data.name,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "subjects_are_college_only") {
      return { error: "Subjects can only be created for a COLLEGE institution." };
    }
    return { error: "Could not create subject. Check the code is unique for this institution." };
  }
  redirect("/dashboard/academic/subjects");
}

const attachSchema = z.object({
  cohortId: z.string().min(1),
  subjectId: z.string().min(1),
  facultyId: z.string().min(1).optional(),
});

export async function attachSubjectToCohort(input: z.infer<typeof attachSchema>) {
  const actor = await requireUser();
  const parsed = attachSchema.parse(input);
  return attachSubjectToCohortForRequest(actor, {
    cohortId: parsed.cohortId,
    subjectId: parsed.subjectId,
    facultyId: parsed.facultyId ?? null,
  });
}

const enrollSchema = z.object({
  studentId: z.string().min(1),
  cohortSubjectId: z.string().min(1),
});

export async function enrollStudentInSubject(input: z.infer<typeof enrollSchema>) {
  const actor = await requireUser();
  const parsed = enrollSchema.parse(input);
  return enrollStudentInSubjectForRequest(actor, parsed);
}
