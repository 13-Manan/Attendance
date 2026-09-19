"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import {
  attachSubjectToCohortForRequest,
  enrollStudentInSubjectForRequest,
} from "./service";

/**
 * Creating a subject used to live here too. It now lives in
 * `directory-actions.ts#createSubjectAction`, which validates in sentences
 * rather than in a single "fill in all fields", names the subject already using
 * a code instead of guessing at a unique-constraint failure, and redisplays
 * what was typed after a refusal.
 */

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
