"use server";

/**
 * Server Actions for the academic structure.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file, and no action here takes an institution id —
 * there is no form field a caller could add to reach another institution's
 * structure.
 */

import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  createUnitFromFormForRequest,
  updateUnitFromFormForRequest,
} from "./directory-service";
import { AcademicStructureError } from "./directory-types";

/** Every field of the unit form, as strings, for redisplay after a refusal. */
export interface UnitFormValues {
  name: string;
  code: string;
  sortOrder: string;
  kind: string;
  parentId: string;
  campusId: string;
}

export interface UnitActionState {
  error?: string;
  message?: string;
  /** Echoed back so a refused submission does not clear the form. */
  values?: UnitFormValues;
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof AcademicStructureError) return error.message;
  if (error instanceof ForbiddenError) {
    return "You do not have access to manage the academic structure.";
  }
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

function readUnitForm(formData: FormData): UnitFormValues {
  return {
    name: text(formData, "name"),
    code: text(formData, "code"),
    sortOrder: text(formData, "sortOrder"),
    kind: text(formData, "kind"),
    parentId: text(formData, "parentId"),
    campusId: text(formData, "campusId"),
  };
}

export async function createUnitAction(
  prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const actor = await requireUser();
  const values = readUnitForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;

  try {
    await createUnitFromFormForRequest(actor, values);
  } catch (error) {
    return { error: describe(error, "It could not be created."), values, attempt };
  }

  // Outside the try/catch: redirect() signals by throwing, and catching it
  // here would report a created unit as a failure.
  redirect("/dashboard/academic/units?created=1");
}

export async function updateUnitAction(
  prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const actor = await requireUser();
  const values = readUnitForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;
  const id = text(formData, "id");

  try {
    await updateUnitFromFormForRequest(actor, id, values);
  } catch (error) {
    return { error: describe(error, "The changes could not be saved."), values, attempt };
  }

  redirect("/dashboard/academic/units?saved=1");
}
