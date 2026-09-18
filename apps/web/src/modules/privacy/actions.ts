"use server";

/**
 * Server Actions for face-data retention.
 *
 * A boundary, not a place where decisions are made: resolve the session user,
 * parse the untrusted form, hand off to `service.ts`, turn the result into
 * something the page can render. Authorization, tenancy and audit all live in
 * the service — which is what makes the rules the same whether a retention
 * sweep is triggered by this button or by whatever eventually runs it on a
 * schedule.
 *
 * Note what these actions do *not* accept: an institution id. The service
 * reads the tenant from the session, so there is no field in any form on this
 * page through which an administrator could name someone else's institution.
 */

import { z } from "zod";
import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  RetentionPolicyError,
  deleteStudentFaceData,
  runRetentionSweep,
  updateRetentionPolicy,
} from "./service";
import { MAX_RETENTION_DAYS } from "./types";

export interface ActionState {
  error?: string;
  message?: string;
}

/**
 * Turns a thrown value into a sentence.
 *
 * `RetentionPolicyError` messages are written for the administrator who is
 * configuring the policy, so they pass through verbatim. Everything else is
 * flattened — a Prisma error names tables and columns, and this is the module
 * where those tables hold biometric data.
 */
function describe(error: unknown, fallback: string): ActionState {
  if (error instanceof RetentionPolicyError) return { error: error.message };
  if (error instanceof ForbiddenError) {
    return { error: "You do not have access to manage face-data retention." };
  }
  return { error: fallback };
}

/**
 * Day fields arrive from `<input type="number">`, which yields a string and an
 * empty string when the box is cleared. An empty box is read as 0 — "no time
 * limit" — matching the convention the whole module uses, and never as a
 * cutoff of today.
 */
const daysField = z.coerce.number().int().min(0).max(MAX_RETENTION_DAYS);

const policySchema = z.object({
  faceTemplateRetentionDays: daysField,
  onStudentInactive: z.string().min(1),
  deactivatedTemplateGraceDays: daysField,
  classroomImageStorage: z.string().min(1),
  classroomImageRetentionDays: daysField,
});

function readDays(value: FormDataEntryValue | null): number {
  const raw = String(value ?? "").trim();
  return raw === "" ? 0 : Number(raw);
}

export async function updateRetentionPolicyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const parsed = policySchema.safeParse({
    faceTemplateRetentionDays: readDays(formData.get("faceTemplateRetentionDays")),
    onStudentInactive: formData.get("onStudentInactive"),
    deactivatedTemplateGraceDays: readDays(formData.get("deactivatedTemplateGraceDays")),
    classroomImageStorage: formData.get("classroomImageStorage"),
    classroomImageRetentionDays: readDays(formData.get("classroomImageRetentionDays")),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        `Retention periods must be whole numbers between 0 and ${MAX_RETENTION_DAYS} days.`,
    };
  }

  try {
    const saved = await updateRetentionPolicy(actor, parsed.data);
    refresh();
    return {
      message:
        saved.classroomImageStorage === "NEVER"
          ? "Retention policy saved. Classroom photographs are not stored."
          : `Retention policy saved. Classroom photographs are kept for ${saved.classroomImageRetentionDays} days.`,
    };
  } catch (error) {
    return describe(error, "The retention policy could not be saved.");
  }
}

/**
 * Applies the policy now.
 *
 * Exposed as a button because no scheduler ships with this build (ADR-0007). A
 * policy that can only be enforced by a cron nobody has installed is a policy
 * that is not enforced, so an administrator can run it by hand and see exactly
 * what it did.
 */
export async function runRetentionSweepAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();

  // An explicit acknowledgement before an irreversible bulk deletion. Like the
  // typed student code on the erasure path this is friction against a misclick
  // rather than a security control — the real one is `faceEmbedding.manage`
  // plus the institution check in the service. It is worth the extra click
  // because a sweep under a shortened policy can destroy a whole cohort's
  // templates, and the only recovery is asking every one of those students to
  // come back and enroll again.
  if (formData.get("acknowledge") !== "on") {
    return {
      error: "Tick the box to confirm you want to apply the policy and delete expired face data.",
    };
  }

  try {
    const summary = await runRetentionSweep(actor);
    refresh();

    const parts: string[] = [];
    const deactivated = summary.deactivatedForInactiveStudent + summary.deactivatedForAge;
    if (deactivated > 0) parts.push(`${deactivated} face template(s) deactivated`);
    if (summary.deletedTemplates > 0) {
      parts.push(`${summary.deletedTemplates} face template(s) permanently deleted`);
    }
    if (summary.deletedClassroomImages > 0) {
      parts.push(`${summary.deletedClassroomImages} stored classroom image(s) deleted`);
    }

    return {
      message:
        parts.length === 0
          ? "Retention sweep complete. Nothing was outside the policy."
          : `Retention sweep complete: ${parts.join(", ")}.`,
    };
  } catch (error) {
    return describe(error, "The retention sweep could not be completed.");
  }
}

const deleteSchema = z.object({
  studentId: z.string().min(1),
  /**
   * A typed confirmation, checked against the student code rendered on the
   * page. This is a guard against a misclick, not a security control — the
   * expected value travels in the same form, so it stops an administrator
   * deleting the wrong student's data, not an administrator who intends to.
   * The actual control is `faceEmbedding.manage` plus the institution check in
   * the service; deletion is irreversible and the student must re-enrol in
   * person, which is what makes the extra friction worth it.
   */
  confirm: z.string().min(1),
});

export async function deleteStudentFaceDataAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireUser();
  const parsed = deleteSchema.safeParse({
    studentId: formData.get("studentId"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { error: "Type the student code to confirm deletion." };
  }

  const expected = String(formData.get("studentCode") ?? "").trim();
  if (expected === "" || parsed.data.confirm.trim() !== expected) {
    return { error: `Type ${expected || "the student code"} exactly to confirm deletion.` };
  }

  try {
    const summary = await deleteStudentFaceData(actor, parsed.data.studentId);
    refresh();
    return {
      message:
        summary.deletedTemplates === 0
          ? "This student had no face data to delete."
          : `Deleted ${summary.deletedTemplates} face template(s). This cannot be undone; the student can enrol again.`,
    };
  } catch (error) {
    return describe(error, "The face data could not be deleted.");
  }
}
