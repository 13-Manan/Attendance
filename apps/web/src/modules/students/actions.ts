"use server";

/**
 * The typed, non-form entry points for student writes.
 *
 * The screens under /dashboard/students use `directory-actions.ts`, which reads
 * a FormData and returns a sentence. These two stay because they are the shape
 * a programmatic caller wants — an object in, the student out, errors thrown —
 * and both go through the service, so permission, tenancy, audit and the
 * webhook apply to them exactly as they do to everything else.
 */

import { z } from "zod";
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
