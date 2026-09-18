"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import {
  enrollStudentInCohortForRequest,
  unenrollStudentFromCohortForRequest,
} from "./service";

const enrollSchema = z.object({
  studentId: z.string().min(1),
  cohortId: z.string().min(1),
});

export interface EnrollFormState {
  error?: string;
  ok?: boolean;
}

export async function enrollStudentInCohortForm(
  _prev: EnrollFormState,
  formData: FormData,
): Promise<EnrollFormState> {
  const actor = await requireUser();
  const parsed = enrollSchema.safeParse({
    studentId: formData.get("studentId"),
    cohortId: formData.get("cohortId"),
  });
  if (!parsed.success) return { error: "Both a student and a cohort are required." };

  try {
    await enrollStudentInCohortForRequest(actor, parsed.data);
  } catch (e) {
    if (e instanceof Error && e.message === "cross_institution_enrollment") {
      return { error: "That student belongs to a different institution and cannot be enrolled here." };
    }
    return { error: "Could not enroll student." };
  }
  return { ok: true };
}

export async function unenrollStudent(input: z.infer<typeof enrollSchema>) {
  const actor = await requireUser();
  const parsed = enrollSchema.parse(input);
  return unenrollStudentFromCohortForRequest(actor, parsed);
}
