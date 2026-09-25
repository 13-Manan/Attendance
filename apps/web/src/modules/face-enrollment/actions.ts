"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { imageBase64Field } from "@/lib/image-validation";
import {
  deactivateFaceEmbeddingRequest,
  enrollFaceForStudentRequest,
  enrollOwnFaceRequest,
  replaceFaceEnrollmentRequest,
} from "./service";
import type { FaceEnrollmentResult } from "./types";

/**
 * The Server Action boundary for enrollment.
 *
 * Thin by design: parse, resolve the session, call the service. No decision
 * about who may enrol whom is made here, because a decision made in an action
 * is a decision that exists once per action — and there are four of them.
 *
 * `imageBase64Field()` bounds the payload *and* checks that the bytes are
 * actually a JPEG/PNG/WebP before they travel any further. This file used to
 * say the Python service was the authoritative validator of image bytes; it
 * was not, and nothing else was either. See lib/image-validation.ts.
 *
 * ## Why `captureSource` is trusted
 *
 * The client says whether the bytes came from the camera or from a file, and
 * the server records it without being able to verify it. That is acceptable
 * precisely because nothing branches on it: both values traverse identical
 * validation, identical quality gating and identical duplicate checks. It is
 * provenance for an investigation, not a permission, and a client that lies
 * about it gains nothing but a misleading row in its own institution's log.
 */

const captureSourceField = z.enum(["CAMERA", "UPLOAD"]);

const enrollForStudentSchema = z.object({
  studentId: z.string().min(1),
  imageBase64: imageBase64Field(),
  captureSource: captureSourceField,
  // Staff confirmation that a `duplicate_identity` collision is two different
  // people (identical twins). Bound to the one student it names; see
  // EnrollFaceForStudentInput. Deliberately absent from `enrollOwnSchema`.
  confirmDistinctFromStudentId: z.string().min(1).optional(),
});

export async function enrollFaceForStudent(
  input: z.infer<typeof enrollForStudentSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  const parsed = enrollForStudentSchema.parse(input);
  return enrollFaceForStudentRequest(actor, parsed);
}

export async function replaceFaceEnrollment(
  input: z.infer<typeof enrollForStudentSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  const parsed = enrollForStudentSchema.parse(input);
  return replaceFaceEnrollmentRequest(actor, parsed);
}

const enrollOwnSchema = z.object({
  imageBase64: imageBase64Field(),
  captureSource: captureSourceField,
});

export async function enrollOwnFace(
  input: z.infer<typeof enrollOwnSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  const parsed = enrollOwnSchema.parse(input);
  // No studentId is accepted here and none is read from the session beyond the
  // user id: the service resolves the caller's own linked Student profile.
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
