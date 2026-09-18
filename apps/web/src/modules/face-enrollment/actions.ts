"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { imageBase64Field } from "@/lib/image-validation";
import {
  deactivateFaceEmbeddingRequest,
  enrollFaceForStudentRequest,
  enrollOwnFaceRequest,
} from "./service";
import type { FaceEnrollmentResult } from "./types";

// `imageBase64Field()` bounds the payload *and* checks that the bytes are
// actually a JPEG/PNG/WebP. This file previously said the Python service was
// the authoritative validator of image bytes; it was not, and nothing else
// was either. See lib/image-validation.ts.

const enrollForStudentSchema = z.object({
  studentId: z.string().min(1),
  imageBase64: imageBase64Field(),
});

export async function enrollFaceForStudent(
  input: z.infer<typeof enrollForStudentSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  const parsed = enrollForStudentSchema.parse(input);
  return enrollFaceForStudentRequest(actor, parsed);
}

const enrollOwnSchema = z.object({
  imageBase64: imageBase64Field(),
});

export async function enrollOwnFace(
  input: z.infer<typeof enrollOwnSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  const parsed = enrollOwnSchema.parse(input);
  return enrollOwnFaceRequest(actor, parsed);
}

const deactivateSchema = z.object({ embeddingId: z.string().min(1) });

export async function deactivateFaceEmbedding(
  input: z.infer<typeof deactivateSchema>,
): Promise<{ ok: true }> {
  const actor = await requireUser();
  const parsed = deactivateSchema.parse(input);
  await deactivateFaceEmbeddingRequest(actor, parsed.embeddingId);
  return { ok: true };
}
