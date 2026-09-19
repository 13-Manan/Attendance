"use server";

/**
 * Server Actions for class administration.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file, and no action here takes an institution id —
 * there is no form field a caller could add to reach another tenant's classes.
 *
 * Staffing a class is deliberately absent. Assignment already lives in
 * `modules/faculty/directory-actions.ts#assignClassTeacherAction` and removal in
 * `#removeClassTeacherAction`, both of which call the same services with the
 * same checks; the class screen imports them rather than growing a second pair
 * that would have to be kept in step.
 */

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  attachSubjectForRequest,
  createCohortFromFormForRequest,
  updateCohortFromFormForRequest,
} from "./directory-service";
import { CohortError } from "./directory-types";

/** Every field of the class form, as strings, for redisplay after a refusal. */
export interface CohortFormValues {
  name: string;
  termLabel: string;
  academicUnitId: string;
  academicSessionId: string;
}

export interface CohortActionState {
  error?: string;
  message?: string;
  /** Echoed back so a refused submission does not clear the form. */
  values?: CohortFormValues;
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof CohortError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have access to manage classes.";
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

function readCohortForm(formData: FormData): CohortFormValues {
  return {
    name: text(formData, "name"),
    termLabel: text(formData, "termLabel"),
    academicUnitId: text(formData, "academicUnitId"),
    academicSessionId: text(formData, "academicSessionId"),
  };
}

export async function createCohortAction(
  prev: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const actor = await requireUser();
  const values = readCohortForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;

  let cohortId: string;
  try {
    const cohort = await createCohortFromFormForRequest(actor, values);
    cohortId = cohort.id;
  } catch (error) {
    return { error: describe(error, "The class could not be created."), values, attempt };
  }

  // Outside the try/catch: redirect() signals by throwing, and catching it here
  // would report a created class as a failure.
  //
  // To the class itself rather than back to the list: the next thing somebody
  // does is give it a teacher and put students in it, and both are there.
  redirect(`/dashboard/academic/cohorts/${cohortId}?created=1`);
}

export async function updateCohortAction(
  prev: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const actor = await requireUser();
  const values = readCohortForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;
  const id = text(formData, "id");

  try {
    await updateCohortFromFormForRequest(actor, id, values);
  } catch (error) {
    return { error: describe(error, "The changes could not be saved."), values, attempt };
  }

  redirect(`/dashboard/academic/cohorts/${id}?saved=1`);
}

/**
 * Offer a subject to a class.
 *
 * `refresh()` rather than a redirect: whoever is building a semester's
 * timetable adds six subjects in a row, and each one should land back on the
 * same page with the list a row longer.
 */
export async function attachSubjectAction(
  _prev: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const actor = await requireUser();
  const cohortId = text(formData, "cohortId");
  const subjectId = text(formData, "subjectId");
  const facultyId = text(formData, "facultyId");

  try {
    const { cohortName } = await attachSubjectForRequest(actor, {
      cohortId,
      subjectId,
      facultyId,
    });
    refresh();
    return {
      message:
        facultyId === ""
          ? `Added to ${cohortName}. Nobody can open a register for it until someone is assigned to teach it.`
          : `Added to ${cohortName}.`,
    };
  } catch (error) {
    return { error: describe(error, "The subject could not be added.") };
  }
}
