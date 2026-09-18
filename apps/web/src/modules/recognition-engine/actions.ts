"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { imageBase64Field } from "@/lib/image-validation";
import { runRecognitionForSession } from "./service";
import type { RecognitionRunSummary } from "./types";


const runSchema = z.object({
  sessionId: z.string().min(1),
  images: z
    .array(
      z.object({
        sequenceNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        imageBase64: imageBase64Field(),
      }),
    )
    .min(1)
    .max(3),
});

/**
 * Server Action exposed to the capture wizard. Wraps
 * `runRecognitionForSession` with authentication + input validation only —
 * every authorisation and scoping decision lives in the service so the
 * unit tests exercising it also exercise the production check paths.
 *
 * The returned summary contains NO raw embeddings — it is safe to send to
 * a browser as-is. The per-face and per-student rows carry only metadata
 * plus similarity scores, matching the Phase 5 result shape.
 */
export async function runRecognitionAction(
  input: z.infer<typeof runSchema>,
): Promise<RecognitionRunSummary> {
  const actor = await requireUser();
  const parsed = runSchema.parse(input);
  return runRecognitionForSession(actor, parsed);
}
