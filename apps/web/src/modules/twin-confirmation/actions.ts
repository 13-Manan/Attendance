"use server";

import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { CollegeSetupError } from "@/modules/college-setup/types";
import { decideTwinConfirmation, declareKnownTwinPair, withdrawKnownTwinPair } from "./service";
import { TwinConfirmationError, type TwinDecision, type TwinStudentSummary } from "./types";

export interface TwinDecisionFormState {
  error: string | null;
}

/** The list a decision returns to, on the page it was made from. */
function listHref(departmentId: string | null): string {
  return departmentId
    ? `/dashboard/college/departments/${encodeURIComponent(departmentId)}/students/twin-confirmations`
    : "/dashboard/students/twin-confirmations";
}

/**
 * Records a reviewer's decision about one pair.
 *
 * The form carries the pair's key, the decision and — on a department's page —
 * the department. None of them is trusted: the service resolves who the
 * reviewer is from the session, which two students the key names from the
 * conflict the enrollment check recorded, and whether this reviewer has
 * authority over both. A department that is not the reviewer's is refused
 * there, and a student, a teacher who is not their class teacher, or a
 * department's faculty never get past it.
 */
export async function decideTwinConfirmationAction(
  _previous: TwinDecisionFormState,
  formData: FormData,
): Promise<TwinDecisionFormState> {
  const actor = await requireUser();
  const pair = formData.get("pair");
  const decision = formData.get("decision");
  const department = formData.get("departmentId");
  const departmentId = typeof department === "string" && department !== "" ? department : null;

  if (decision === "confirmed" && formData.get("checked") !== "on") {
    return { error: "Tick the box to say you have checked in person that these are two different people." };
  }

  let state: TwinDecision;
  try {
    ({ state } = await decideTwinConfirmation(
      actor,
      { pair: typeof pair === "string" ? pair : "", decision: decision as TwinDecision },
      departmentId ? { departmentId } : {},
    ));
  } catch (error) {
    if (error instanceof TwinConfirmationError || error instanceof CollegeSetupError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return {
        error:
          "Only a class teacher, principal, head of department or director with authority over both students can decide this.",
      };
    }
    throw error;
  }

  const list = listHref(departmentId);
  revalidatePath(list);
  redirect(`${list}?decided=${state}`);
}

// ---------------------------------------------------------------------------
// Known pairs, declared in advance
// ---------------------------------------------------------------------------

export interface KnownTwinFormState {
  error: string | null;
  message: string | null;
  /** Bumped on every success, so the form can start again empty. */
  done: number;
}

const NOT_AUTHORISED =
  "Only a class teacher, principal, head of department or director with authority over both students can do this.";

const fullName = (student: TwinStudentSummary) => `${student.firstName} ${student.lastName}`.trim();

function departmentOf(formData: FormData): { departmentId?: string } {
  const value = formData.get("departmentId");
  return typeof value === "string" && value !== "" ? { departmentId: value } : {};
}

function refused(error: unknown, previous: KnownTwinFormState): KnownTwinFormState {
  if (error instanceof TwinConfirmationError || error instanceof CollegeSetupError) {
    return { error: error.message, message: null, done: previous.done };
  }
  if (error instanceof ForbiddenError) return { error: NOT_AUTHORISED, message: null, done: previous.done };
  throw error;
}

/**
 * Marks two students as known twins or lookalikes.
 *
 * The form carries two student ids and, on a department's page, the
 * department. None of them is trusted: the service works out who is asking
 * from the session, whether both students are theirs to pair and on roll,
 * and records at most one declaration for the pair however often — or by
 * however many people at once — it is asked.
 */
export async function declareKnownTwinPairAction(
  previous: KnownTwinFormState,
  formData: FormData,
): Promise<KnownTwinFormState> {
  const actor = await requireUser();
  try {
    const result = await declareKnownTwinPair(
      actor,
      { studentIds: [formData.get("studentA"), formData.get("studentB")] },
      departmentOf(formData),
    );
    const names = `${fullName(result.students[0])} and ${fullName(result.students[1])}`;
    refresh();
    if (!result.changed) {
      return {
        error: null,
        message:
          result.source === "declared"
            ? `Already marked as known twin/lookalike: ${names}.`
            : `${names} were already confirmed as different people in a review, so nothing more needs marking.`,
        done: previous.done + 1,
      };
    }
    return { error: null, message: `Marked as known twin/lookalike: ${names}.`, done: previous.done + 1 };
  } catch (error) {
    return refused(error, previous);
  }
}

/** Removes a declaration. Same trust rules: the pair's key and the department are only a request. */
export async function withdrawKnownTwinPairAction(
  previous: KnownTwinFormState,
  formData: FormData,
): Promise<KnownTwinFormState> {
  const actor = await requireUser();
  try {
    const { changed } = await withdrawKnownTwinPair(actor, { pair: formData.get("pair") }, departmentOf(formData));
    refresh();
    return {
      error: null,
      message: changed ? "Declaration removed." : "These two are not marked as known twins/lookalikes.",
      done: previous.done + 1,
    };
  } catch (error) {
    return refused(error, previous);
  }
}
