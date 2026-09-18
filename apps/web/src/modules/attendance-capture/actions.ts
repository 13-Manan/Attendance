"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { imageBase64Field } from "@/lib/image-validation";
import {
  analyzeCaptureImage,
  cancelCaptureSession,
  listCapturableCohortsForActor,
  listCohortSubjectsForCapture,
  startOrResumeCaptureSession,
  summarizeCaptureSession,
} from "./service";
import type {
  CaptureImageAnalysis,
  CaptureImageResult,
  CaptureSessionSummary,
  CapturableCohort,
  CapturableCohortSubject,
  StartCaptureSessionResult,
} from "./types";


// ---------------------------------------------------------------------------

export async function listCapturableCohorts(): Promise<CapturableCohort[]> {
  const actor = await requireUser();
  return listCapturableCohortsForActor(actor);
}

const listSubjectsSchema = z.object({ cohortId: z.string().min(1) });

export async function listCohortSubjectsForCaptureAction(
  input: z.infer<typeof listSubjectsSchema>,
): Promise<CapturableCohortSubject[]> {
  const actor = await requireUser();
  const parsed = listSubjectsSchema.parse(input);
  return listCohortSubjectsForCapture(actor, parsed.cohortId);
}

const startSchema = z.object({
  cohortId: z.string().min(1),
  cohortSubjectId: z.string().min(1).nullish(),
});

export async function startCaptureSession(
  input: z.infer<typeof startSchema>,
): Promise<StartCaptureSessionResult> {
  const actor = await requireUser();
  const parsed = startSchema.parse(input);
  return startOrResumeCaptureSession(actor, {
    cohortId: parsed.cohortId,
    cohortSubjectId: parsed.cohortSubjectId ?? null,
  });
}

const analyzeSchema = z.object({
  sessionId: z.string().min(1),
  sequenceNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  // Bounded and format-checked before anything forwards it to a decoder —
  // see lib/image-validation.ts for why "the AI service validates it", which
  // this comment used to claim, was not true of either side of the wire.
  imageBase64: imageBase64Field(),
  acceptedSoFar: z.number().int().min(0).max(3),
});

export async function analyzeCaptureImageAction(
  input: z.infer<typeof analyzeSchema>,
): Promise<CaptureImageResult> {
  const actor = await requireUser();
  const parsed = analyzeSchema.parse(input);
  return analyzeCaptureImage(actor, parsed);
}

const summarizeSchema = z.object({
  sessionId: z.string().min(1),
  analyses: z.array(
    z.object({
      sequenceNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      faceCount: z.number().int().min(0),
      averageDetectionConfidence: z.number().nullable(),
      averageQualityScore: z.number().nullable(),
      modelName: z.string(),
      modelVersion: z.string(),
      productionEligible: z.boolean(),
      qualityLabel: z.enum(["good", "acceptable", "poor", "no_faces"]),
      qualityHint: z.string(),
    }),
  ),
});

export async function summarizeCaptureSessionAction(
  input: z.infer<typeof summarizeSchema>,
): Promise<CaptureSessionSummary> {
  const actor = await requireUser();
  const parsed = summarizeSchema.parse(input);
  return summarizeCaptureSession(actor, {
    sessionId: parsed.sessionId,
    analyses: parsed.analyses as CaptureImageAnalysis[],
  });
}

const cancelSchema = z.object({ sessionId: z.string().min(1) });

export async function cancelCaptureSessionAction(
  input: z.infer<typeof cancelSchema>,
): Promise<{ status: string }> {
  const actor = await requireUser();
  const parsed = cancelSchema.parse(input);
  const updated = await cancelCaptureSession(actor, parsed.sessionId);
  return { status: updated.status };
}
