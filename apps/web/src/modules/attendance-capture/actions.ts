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
  // The three-capture cap, expressed structurally. A session cannot hold a
  // fourth distinct capture because there is no fourth sequence number, so
  // nothing has to trust a counter the browser maintains.
  sequenceNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  // Bounded and format-checked before anything forwards it to a decoder —
  // see lib/image-validation.ts for why "the AI service validates it", which
  // this comment used to claim, was not true of either side of the wire.
  imageBase64: imageBase64Field(),
});

export async function analyzeCaptureImageAction(
  input: z.infer<typeof analyzeSchema>,
): Promise<CaptureImageResult> {
  const actor = await requireUser();
  const parsed = analyzeSchema.parse(input);
  return analyzeCaptureImage(actor, parsed);
}

const summarizeSchema = z.object({ sessionId: z.string().min(1) });

/**
 * The summary takes only a session id.
 *
 * It used to take the per-capture verdicts as well, which meant the screen
 * reporting "3 photos, 41 faces detected" was reporting whatever the browser
 * had said. The server recorded those verdicts when it analysed the images;
 * it reads its own copy.
 */
export async function summarizeCaptureSessionAction(
  input: z.infer<typeof summarizeSchema>,
): Promise<CaptureSessionSummary> {
  const actor = await requireUser();
  const parsed = summarizeSchema.parse(input);
  return summarizeCaptureSession(actor, { sessionId: parsed.sessionId });
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
