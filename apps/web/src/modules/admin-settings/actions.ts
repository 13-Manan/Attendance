"use server";

/**
 * Server Actions for institution settings.
 *
 * A boundary, not a place where decisions are made: resolve the session user,
 * parse the untrusted form, hand off to `service.ts`, turn the result into
 * something the page can render. Authorization, tenancy, validation and audit
 * all live below this file, which is what makes the rules identical whether a
 * threshold is changed from this form or from anywhere else that ever calls
 * the service.
 *
 * No action here accepts an institution id. The service reads the tenant from
 * the session.
 */

import { z } from "zod";
import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  updateAttendanceSettings,
  updateFacePolicy,
  updateSelfEnrollmentPolicy,
} from "./service";
import { AdminSettingsError, MAX_CORRECTION_WINDOW_DAYS } from "./types";

export interface ActionState {
  error?: string;
  message?: string;
  /** Non-blocking notes about the policy that is now in force. */
  warnings?: string[];
}

/**
 * Turns a thrown value into a sentence.
 *
 * `AdminSettingsError` messages are written for the administrator holding the
 * form — they name the field and the range — so they pass through verbatim.
 * Everything else is flattened: a Prisma error names tables and columns, and
 * an administrator cannot act on either.
 */
function describe(error: unknown, fallback: string): ActionState {
  if (error instanceof AdminSettingsError) return { error: error.message };
  if (error instanceof ForbiddenError) {
    return { error: "You do not have access to change institution settings." };
  }
  return { error: fallback };
}

/**
 * `<input type="number">` yields a string, and an empty string when the box is
 * cleared. Each caller decides what an empty box means, because the answers
 * differ: an empty correction window is "no limit" (0), an empty threshold is
 * a mistake and must not silently become 0.
 */
function readNumber(value: FormDataEntryValue | null, whenEmpty: number | null): number {
  const raw = String(value ?? "").trim();
  if (raw === "") return whenEmpty ?? Number.NaN;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// ---------------------------------------------------------------------------
// Attendance settings
// ---------------------------------------------------------------------------

const attendanceSchema = z.object({
  attendanceMode: z.string().min(1),
  lowAttendanceThreshold: z.number().min(0).max(100),
  correctionWindowDays: z.number().int().min(0).max(MAX_CORRECTION_WINDOW_DAYS),
  requireReasonAfterFinalization: z.boolean(),
});

export async function updateAttendanceSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const parsed = attendanceSchema.safeParse({
    attendanceMode: formData.get("attendanceMode"),
    lowAttendanceThreshold: readNumber(formData.get("lowAttendanceThreshold"), null),
    correctionWindowDays: readNumber(formData.get("correctionWindowDays"), 0),
    requireReasonAfterFinalization: formData.get("requireReasonAfterFinalization") === "on",
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Check the attendance settings: the threshold is a percentage and the correction window is a whole number of days.",
    };
  }

  try {
    const saved = await updateAttendanceSettings(actor, parsed.data);
    refresh();
    const window =
      saved.policy.correctionWindowDays === 0
        ? "Finalized registers can be corrected with no time limit."
        : `Finalized registers can be corrected for ${saved.policy.correctionWindowDays} day(s).`;
    return { message: `Attendance settings saved. ${window}` };
  } catch (error) {
    return describe(error, "The attendance settings could not be saved.");
  }
}

// ---------------------------------------------------------------------------
// Face recognition policy
// ---------------------------------------------------------------------------

const faceSchema = z.object({
  presentMin: z.number(),
  reviewMin: z.number(),
  ambiguityMargin: z.number(),
  minDetectionConfidence: z.number(),
});

/**
 * Saving the recognition thresholds.
 *
 * The typed acknowledgement is checked here rather than in the service on
 * purpose: it is friction against a misclick, not a security control. The real
 * control is `institution.update` plus the range validation in `policy.ts`,
 * both of which run below this file and cannot be skipped by a caller that
 * does not go through this form. What the checkbox buys is that nobody changes
 * the number that decides whether a student is marked present without a human
 * having read one sentence saying so.
 */
export async function updateFacePolicyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();

  if (formData.get("acknowledge") !== "on") {
    return {
      error:
        "Tick the box to confirm you understand these values change how attendance is decided.",
    };
  }

  const parsed = faceSchema.safeParse({
    presentMin: readNumber(formData.get("presentMin"), null),
    reviewMin: readNumber(formData.get("reviewMin"), null),
    ambiguityMargin: readNumber(formData.get("ambiguityMargin"), null),
    minDetectionConfidence: readNumber(formData.get("minDetectionConfidence"), null),
  });
  if (!parsed.success) {
    return { error: "Every recognition value must be a number between 0 and 1." };
  }

  try {
    const saved = await updateFacePolicy(actor, parsed.data);
    refresh();
    return {
      message:
        `Recognition policy saved: present at ${saved.policy.presentMin}, review at ` +
        `${saved.policy.reviewMin}. The change is recorded in the audit log.`,
      warnings: saved.warnings,
    };
  } catch (error) {
    return describe(error, "The recognition policy could not be saved.");
  }
}

// ---------------------------------------------------------------------------
// Who may enrol a face
// ---------------------------------------------------------------------------

/**
 * Turning student self-enrollment on or off.
 *
 * No acknowledgement checkbox, unlike the thresholds above. The two directions
 * are not symmetrically risky and neither is irreversible: turning it *off*
 * removes a way for biometric data to enter the system, and turning it *on*
 * only lets a student enrol their own face — a face the institution is already
 * entitled to enrol on their behalf. The audit row is what makes the change
 * accountable, and it is written either way.
 *
 * An absent checkbox means off. That is how an unchecked HTML checkbox arrives,
 * and reading it any other way would make the control impossible to switch off.
 */
export async function updateSelfEnrollmentPolicyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const enabled = formData.get("selfEnrollmentEnabled") === "on";

  try {
    await updateSelfEnrollmentPolicy(actor, { selfEnrollmentEnabled: enabled });
    refresh();
    return {
      message: enabled
        ? "Students can now enrol their own face from the student portal. The change is recorded in the audit log."
        : "Student self-enrollment is off. Faces are enrolled by staff only, and the student portal says so. The change is recorded in the audit log.",
    };
  } catch (error) {
    return describe(error, "The enrollment policy could not be saved.");
  }
}
