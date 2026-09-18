"use server";

/**
 * Server Actions for faculty administration.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file, and no action here takes an institution id.
 *
 * ## The password in the action state
 *
 * `inviteFacultyAction` and `resetPasswordAction` return a plaintext temporary
 * password so the page can show it once. It goes to the browser that submitted
 * the form and nowhere else: it is not stored, not audited, not logged, and it
 * is gone on the next navigation. That lifetime is the point — see
 * `directory-service.ts`.
 *
 * Class-teacher *assignment* is delegated to `modules/cohorts/service.ts`,
 * which has done exactly that since Phase 2 with its own tenant checks and its
 * own audit row. Reimplementing it here to keep one module tidy would be two
 * code paths for one fact.
 */

import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { assignFacultyToCohortForRequest } from "@/modules/cohorts/service";
import {
  deactivateFaculty,
  inviteFaculty,
  reactivateFaculty,
  removeClassTeacher,
  resetFacultyPassword,
  setSubjectFaculty,
  updateFacultyDetails,
} from "./directory-service";
import { FacultyError } from "./directory-types";

export interface FacultyActionState {
  error?: string;
  message?: string;
  /** Shown once, immediately after it is issued. Never re-readable. */
  password?: string;
  passwordNotice?: string;
  passwordLabel?: string;
}

function describe(error: unknown, fallback: string): FacultyActionState {
  if (error instanceof FacultyError) return { error: error.message };
  if (error instanceof ForbiddenError) {
    return { error: "You do not have access to manage staff accounts." };
  }
  // The cohort service signals with `new Error("cohort_not_found")` and
  // friends. Those are codes, not sentences, so they are translated rather
  // than shown — an administrator should not be reading our identifiers.
  if (error instanceof Error) {
    const known: Record<string, string> = {
      cohort_not_found: "That class no longer exists.",
      user_not_found: "That account no longer exists.",
      cross_institution_user: "That person is not a member of staff at this institution.",
    };
    const message = known[error.message];
    if (message) return { error: message };
  }
  return { error: fallback };
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

export async function inviteFacultyAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  try {
    const invited = await inviteFaculty(actor, {
      name: text(formData, "name"),
      email: text(formData, "email"),
      employeeCode: text(formData, "employeeCode"),
      roleKey: text(formData, "roleKey"),
    });
    refresh();
    return {
      message: `${invited.member.name} can now sign in with ${invited.member.email}.`,
      password: invited.password,
      passwordNotice: invited.notice,
      passwordLabel: `Temporary password for ${invited.member.email}`,
    };
  } catch (error) {
    return describe(error, "The account could not be created.");
  }
}

export async function updateFacultyAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  if (id === "") return { error: "Choose an account to update." };
  try {
    const updated = await updateFacultyDetails(actor, id, {
      name: text(formData, "name"),
      employeeCode: text(formData, "employeeCode"),
    });
    refresh();
    return { message: `Saved. ${updated.name}'s details are updated.` };
  } catch (error) {
    return describe(error, "The account could not be saved.");
  }
}

export async function deactivateFacultyAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  if (id === "") return { error: "Choose an account to stop." };
  try {
    const stopped = await deactivateFaculty(actor, id);
    refresh();
    return {
      message: `${stopped.name} can no longer sign in. Their past registers and corrections are kept.`,
    };
  } catch (error) {
    return describe(error, "The account could not be stopped.");
  }
}

export async function reactivateFacultyAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  if (id === "") return { error: "Choose an account to restore." };
  try {
    const restored = await reactivateFaculty(actor, id);
    refresh();
    return {
      message: `${restored.name} can sign in again. If they have lost their password, issue a new one.`,
    };
  } catch (error) {
    return describe(error, "The account could not be restored.");
  }
}

export async function resetPasswordAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  const email = text(formData, "email");
  if (id === "") return { error: "Choose an account." };
  try {
    const issued = await resetFacultyPassword(actor, id);
    refresh();
    return {
      message: "A new password is issued. The old one, and any open session, stopped working now.",
      password: issued.password,
      passwordNotice: issued.notice,
      passwordLabel: email === "" ? "Temporary password" : `Temporary password for ${email}`,
    };
  } catch (error) {
    return describe(error, "A new password could not be issued.");
  }
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function assignClassTeacherAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const cohortId = text(formData, "cohortId");
  const userId = text(formData, "userId");
  const role = text(formData, "role") === "ASSISTANT" ? "ASSISTANT" : "PRIMARY";
  if (cohortId === "" || userId === "") return { error: "Choose both a class and a person." };
  try {
    await assignFacultyToCohortForRequest(actor, { cohortId, userId, role });
    refresh();
    return {
      message:
        role === "PRIMARY"
          ? "Assigned as the class teacher."
          : "Assigned as an additional teacher for the class.",
    };
  } catch (error) {
    return describe(error, "The assignment could not be saved.");
  }
}

export async function removeClassTeacherAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const linkId = text(formData, "linkId");
  if (linkId === "") return { error: "Choose an assignment to remove." };
  try {
    await removeClassTeacher(actor, linkId);
    refresh();
    return { message: "Removed. They keep access to registers they already took." };
  } catch (error) {
    return describe(error, "The assignment could not be removed.");
  }
}

export async function setSubjectFacultyAction(
  _prev: FacultyActionState,
  formData: FormData,
): Promise<FacultyActionState> {
  const actor = await requireUser();
  const cohortSubjectId = text(formData, "cohortSubjectId");
  const facultyId = text(formData, "facultyId");
  if (cohortSubjectId === "") return { error: "Choose a subject." };
  try {
    await setSubjectFaculty(actor, cohortSubjectId, facultyId === "" ? null : facultyId);
    refresh();
    return {
      message:
        facultyId === ""
          ? "Cleared. Nobody can open a register for this subject until someone is assigned."
          : "Saved. They can now open registers for this subject.",
    };
  } catch (error) {
    return describe(error, "The subject assignment could not be saved.");
  }
}
