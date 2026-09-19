"use server";

/**
 * Server Action for the institution profile.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file, and nothing here takes an institution id.
 */

import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { ACADEMIC_UNIT_LABEL_KEYS } from "@/modules/institutions/types";
import { updateInstitutionProfileForRequest } from "./service";
import { InstitutionProfileError, labelField } from "./types";

export interface InstitutionProfileActionState {
  error?: string;
  message?: string;
  /**
   * Echoed back so a refused submission does not clear the form. Flat, and
   * including the `label_*` fields, because it is read straight back into
   * `defaultValue` by name.
   */
  values?: Record<string, string>;
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

export async function updateInstitutionProfileAction(
  prev: InstitutionProfileActionState,
  formData: FormData,
): Promise<InstitutionProfileActionState> {
  const actor = await requireUser();
  const attempt = (prev.attempt ?? 0) + 1;

  const input = {
    name: text(formData, "name"),
    timezone: text(formData, "timezone"),
    contactEmail: text(formData, "contactEmail"),
    contactPhone: text(formData, "contactPhone"),
    addressLine: text(formData, "addressLine"),
  };

  const academicUnitLabels: Record<string, string> = {};
  for (const key of ACADEMIC_UNIT_LABEL_KEYS) {
    academicUnitLabels[key] = text(formData, labelField(key));
  }

  const values: Record<string, string> = { ...input };
  for (const key of ACADEMIC_UNIT_LABEL_KEYS) {
    values[labelField(key)] = academicUnitLabels[key];
  }

  try {
    await updateInstitutionProfileForRequest(actor, { ...input, academicUnitLabels });
  } catch (error) {
    if (error instanceof InstitutionProfileError) {
      return { error: error.message, values, attempt };
    }
    if (error instanceof ForbiddenError) {
      return {
        error: "You do not have access to change this institution's profile.",
        values,
        attempt,
      };
    }
    return { error: "The profile could not be saved.", values, attempt };
  }

  // `refresh()` rather than a redirect: the administrator is already on the
  // settings page and should stay on it, with the saved values re-read from
  // the database rather than assumed by the client.
  refresh();
  return { message: "Institution profile saved.", attempt };
}
