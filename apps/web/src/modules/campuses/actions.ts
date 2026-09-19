"use server";

/**
 * Server Actions for campus administration.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file, and no action here takes an institution id —
 * there is no form field a caller could add to reach another tenant.
 */

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  createCampusForRequest,
  setCampusOpenForRequest,
  updateCampusForRequest,
} from "./service";
import { CampusError } from "./types";

export interface CampusActionState {
  error?: string;
  message?: string;
  /** Echoed back so a refused submission does not clear the form. */
  values?: { name: string; code: string; address: string };
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof CampusError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have access to manage campuses.";
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

function readCampusForm(formData: FormData) {
  return {
    name: text(formData, "name"),
    code: text(formData, "code"),
    address: text(formData, "address"),
  };
}

export async function createCampusAction(
  prev: CampusActionState,
  formData: FormData,
): Promise<CampusActionState> {
  const actor = await requireUser();
  const values = readCampusForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;

  try {
    await createCampusForRequest(actor, values);
  } catch (error) {
    return { error: describe(error, "The campus could not be created."), values, attempt };
  }

  // Outside the try/catch: redirect() signals by throwing, and catching it
  // here would report a successful create as a failure.
  redirect("/dashboard/campuses?created=1");
}

export async function updateCampusAction(
  prev: CampusActionState,
  formData: FormData,
): Promise<CampusActionState> {
  const actor = await requireUser();
  const values = readCampusForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;
  const id = text(formData, "id");

  try {
    await updateCampusForRequest(actor, id, values);
  } catch (error) {
    return { error: describe(error, "The campus could not be saved."), values, attempt };
  }

  redirect("/dashboard/campuses?saved=1");
}

/**
 * Close or reopen, from the list.
 *
 * `refresh()` rather than a redirect: the administrator is looking at the row
 * they just changed and should keep looking at it, with the counts and the
 * status re-read from the database rather than guessed at by the client.
 */
export async function setCampusOpenAction(
  _prev: CampusActionState,
  formData: FormData,
): Promise<CampusActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  const isActive = text(formData, "isActive") === "true";

  try {
    const campus = await setCampusOpenForRequest(actor, id, isActive);
    refresh();
    return {
      message: isActive
        ? `${campus.name} is open again.`
        : `${campus.name} is closed. Its records are kept.`,
    };
  } catch (error) {
    return { error: describe(error, "That change could not be made.") };
  }
}
