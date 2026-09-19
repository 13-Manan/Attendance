"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  archiveAcademicSessionForRequest,
  createAcademicSessionForRequest,
  setAcademicSessionArchivedForRequest,
  setCurrentAcademicSessionForRequest,
  updateAcademicSessionForRequest,
} from "./service";
import { parseSessionDate } from "./policy";
import { AcademicSessionError } from "./types";

const createSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export interface CreateAcademicSessionFormState {
  error?: string;
}

export async function createAcademicSessionForm(
  _prev: CreateAcademicSessionFormState,
  formData: FormData,
): Promise<CreateAcademicSessionFormState> {
  const actor = await requireUser();
  if (!actor.institutionId) return { error: "Platform accounts cannot create academic sessions." };

  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
  });
  if (!parsed.success) return { error: "All fields are required." };

  try {
    await createAcademicSessionForRequest(actor, {
      institutionId: actor.institutionId,
      name: parsed.data.name,
      startDate: parseSessionDate(parsed.data.startDate, "start date"),
      endDate: parseSessionDate(parsed.data.endDate, "end date"),
    });
  } catch (error) {
    // `describe` rather than a fixed sentence: the service refuses with the
    // reason — the dates are the wrong way round, or the name is taken — and
    // dropping it left the form saying "check dates and uniqueness" to someone
    // who had got one of the two right.
    return { error: describe(error, "The academic year could not be created.") };
  }
  redirect("/dashboard/academic/sessions");
}

export async function archiveAcademicSession(id: string) {
  const actor = await requireUser();
  return archiveAcademicSessionForRequest(actor, id);
}

// ---------------------------------------------------------------------------
// Editing a year, making one current, archiving and restoring.
//
// A boundary only: resolve the session user, read the form, call the service,
// shape the result for the page. No action takes an institution id — there is
// no form field a caller could add to reach another tenant's year.
// ---------------------------------------------------------------------------

export interface AcademicSessionActionState {
  error?: string;
  message?: string;
  /** Echoed back so a refused submission does not clear the form. */
  values?: { name: string; startDate: string; endDate: string };
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof AcademicSessionError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have access to manage academic years.";
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

export async function updateAcademicSessionAction(
  prev: AcademicSessionActionState,
  formData: FormData,
): Promise<AcademicSessionActionState> {
  const actor = await requireUser();
  const values = {
    name: text(formData, "name"),
    startDate: text(formData, "startDate"),
    endDate: text(formData, "endDate"),
  };
  const attempt = (prev.attempt ?? 0) + 1;
  const id = text(formData, "id");

  try {
    await updateAcademicSessionForRequest(actor, id, values);
  } catch (error) {
    return { error: describe(error, "The academic year could not be saved."), values, attempt };
  }

  // Outside the try/catch: redirect() signals by throwing, and catching it
  // here would report a successful save as a failure.
  redirect("/dashboard/academic/sessions?saved=1");
}

/**
 * Make a year the current one, from the list.
 *
 * `refresh()` rather than a redirect: the administrator is looking at the rows
 * that just changed — this one and whichever year lost the status — and should
 * keep looking at them, re-read from the database rather than guessed at.
 */
export async function setCurrentAcademicSessionAction(
  _prev: AcademicSessionActionState,
  formData: FormData,
): Promise<AcademicSessionActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  const name = text(formData, "name");

  try {
    await setCurrentAcademicSessionForRequest(actor, id);
    refresh();
    return { message: `${name || "That year"} is now the current academic year.` };
  } catch (error) {
    return { error: describe(error, "That year could not be made current.") };
  }
}

export async function setAcademicSessionArchivedAction(
  _prev: AcademicSessionActionState,
  formData: FormData,
): Promise<AcademicSessionActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  const name = text(formData, "name");
  const archived = text(formData, "archived") === "true";

  try {
    await setAcademicSessionArchivedForRequest(actor, id, archived);
    refresh();
    return {
      message: archived
        ? `${name || "That year"} is archived. Its classes and registers are kept.`
        : `${name || "That year"} is open again.`,
    };
  } catch (error) {
    return { error: describe(error, "That change could not be made.") };
  }
}
