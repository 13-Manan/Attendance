"use server";

/**
 * Server Actions for subjects.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file, and no action here takes an institution id —
 * there is no form field a caller could add to reach another institution's
 * subjects.
 */

import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  createSubjectFromFormForRequest,
  updateSubjectFromFormForRequest,
} from "./directory-service";
import { SubjectError } from "./directory-types";

/** Every field of the subject form, as strings, for redisplay after a refusal. */
export interface SubjectFormValues {
  code: string;
  name: string;
}

export interface SubjectActionState {
  error?: string;
  /** Echoed back so a refused submission does not clear the form. */
  values?: SubjectFormValues;
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof SubjectError) return error.message;
  if (error instanceof ForbiddenError) {
    return "You do not have access to manage subjects.";
  }
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

function readSubjectForm(formData: FormData): SubjectFormValues {
  return { code: text(formData, "code"), name: text(formData, "name") };
}

export async function createSubjectAction(
  prev: SubjectActionState,
  formData: FormData,
): Promise<SubjectActionState> {
  const actor = await requireUser();
  const values = readSubjectForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;

  try {
    await createSubjectFromFormForRequest(actor, values);
  } catch (error) {
    return { error: describe(error, "It could not be created."), values, attempt };
  }

  // Outside the try/catch: redirect() signals by throwing, and catching it
  // here would report a created subject as a failure.
  redirect("/dashboard/academic/subjects?created=1");
}

export async function updateSubjectAction(
  prev: SubjectActionState,
  formData: FormData,
): Promise<SubjectActionState> {
  const actor = await requireUser();
  const values = readSubjectForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;
  const id = text(formData, "id");

  try {
    await updateSubjectFromFormForRequest(actor, id, values);
  } catch (error) {
    return { error: describe(error, "The changes could not be saved."), values, attempt };
  }

  redirect("/dashboard/academic/subjects?saved=1");
}
