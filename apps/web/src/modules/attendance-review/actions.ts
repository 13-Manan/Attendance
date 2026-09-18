"use server";

import { z } from "zod";
import { requireUser } from "@/modules/auth-tenancy/session";
import { imageBase64Field } from "@/lib/image-validation";
import { runRecognitionForSession } from "@/modules/recognition-engine/service";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import {
  applyReviewDecision,
  confirmAttendance,
  generateAttendanceCandidates,
  getAttendanceReviewBoard,
  getOwnAttendance,
} from "./service";
import type { GenerateAttendanceCandidatesResult } from "./service";
import type {
  AttendanceReviewBoard,
  ReviewDecisionResult,
  StudentAttendanceView,
} from "./types";


const processSchema = z.object({
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

export interface ProcessSessionAttendanceResult {
  recognition: RecognitionRunSummary;
  generation: GenerateAttendanceCandidatesResult;
}

/**
 * The capture wizard's "Process" step, server side, in one call.
 *
 * Recognition and candidate generation MUST stay in the same server-side
 * action. If the browser ran recognition and then posted the results back
 * for persistence, a client could simply claim that everyone was matched —
 * attendance would be asserted by the device, not measured. Here the
 * advisory summary returned to the browser is display-only; what gets
 * written is what this process computed.
 */
export async function processSessionAttendanceAction(
  input: z.infer<typeof processSchema>,
): Promise<ProcessSessionAttendanceResult> {
  const actor = await requireUser();
  const parsed = processSchema.parse(input);

  const recognition = await runRecognitionForSession(actor, parsed);
  const generation = await generateAttendanceCandidates(actor, {
    sessionId: parsed.sessionId,
    recognition,
  });
  return { recognition, generation };
}

const sessionIdSchema = z.object({ sessionId: z.string().min(1) });

/**
 * The fallback when recognition is unavailable: build the register with
 * every enrolled student in Needs Review, so the faculty member can call
 * the roll manually. Nothing is presumed present or absent.
 */
export async function startManualRollCallAction(
  input: z.infer<typeof sessionIdSchema>,
): Promise<GenerateAttendanceCandidatesResult> {
  const actor = await requireUser();
  const { sessionId } = sessionIdSchema.parse(input);
  return generateAttendanceCandidates(actor, { sessionId, recognition: null });
}

export async function getAttendanceReviewBoardAction(
  input: z.infer<typeof sessionIdSchema>,
): Promise<AttendanceReviewBoard> {
  const actor = await requireUser();
  const { sessionId } = sessionIdSchema.parse(input);
  return getAttendanceReviewBoard(actor, sessionId);
}

const decisionSchema = z.object({
  attendanceRecordId: z.string().min(1),
  newResult: z.enum(["PRESENT", "ABSENT", "NEEDS_REVIEW"]),
  reason: z.string().max(500).optional(),
});

export async function submitReviewDecisionAction(
  input: z.infer<typeof decisionSchema>,
): Promise<ReviewDecisionResult> {
  const actor = await requireUser();
  const parsed = decisionSchema.parse(input);
  return applyReviewDecision(actor, parsed);
}

export async function confirmAttendanceAction(input: z.infer<typeof sessionIdSchema>) {
  const actor = await requireUser();
  const { sessionId } = sessionIdSchema.parse(input);
  return confirmAttendance(actor, sessionId);
}

/**
 * The student portal's refetch. Takes no arguments on purpose — the student
 * is the session's own user, so there is no id a caller could substitute.
 */
export async function getOwnAttendanceAction(): Promise<StudentAttendanceView | null> {
  const actor = await requireUser();
  return getOwnAttendance(actor);
}
