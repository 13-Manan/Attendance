"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { CollegeSetupError } from "@/modules/college-setup/types";
import { decideTwinConfirmation } from "./service";
import { TwinConfirmationError, type TwinDecision } from "./types";

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
