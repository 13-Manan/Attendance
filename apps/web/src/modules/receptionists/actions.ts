"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  createReceptionist,
  resetReceptionistPassword,
  setReceptionistAccess,
  setReceptionistActive,
  updateReceptionist,
} from "./service";
import { ReceptionistError } from "./types";

/**
 * The principal's Receptionists screens, as Server Actions.
 *
 * Each one re-reads the signed-in account and hands it to the service, which
 * decides everything — who may, which school, which receptionist, what access.
 * Nothing the form sends is trusted beyond being a request: an id, some text,
 * and switch names the catalogue either knows or drops.
 */

export interface ReceptionistActionState {
  error?: string;
  message?: string;
  /** Shown once, straight after it is issued. Never readable again. */
  password?: string;
  email?: string;
  receptionistId?: string;
}

function describe(error: unknown, fallback: string): ReceptionistActionState {
  if (error instanceof ReceptionistError) return { error: error.message };
  if (error instanceof ForbiddenError) return { error: "Only the principal can manage receptionists." };
  console.error(
    JSON.stringify({
      log: "receptionists",
      event: "unexpected_error",
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "non-error thrown",
    }),
  );
  return { error: fallback };
}

const text = (formData: FormData, field: string) => String(formData.get(field) ?? "");

export async function createReceptionistAction(
  _prev: ReceptionistActionState,
  formData: FormData,
): Promise<ReceptionistActionState> {
  const actor = await requireUser();
  try {
    const created = await createReceptionist(actor, {
      name: text(formData, "name"),
      email: text(formData, "email"),
      phone: text(formData, "phone"),
    });
    refresh();
    return {
      message: `${created.receptionist.name} can now sign in.`,
      email: created.receptionist.email,
      password: created.password,
      receptionistId: created.receptionist.id,
    };
  } catch (error) {
    return describe(error, "The account could not be created. Try again.");
  }
}

export async function updateReceptionistAction(
  _prev: ReceptionistActionState,
  formData: FormData,
): Promise<ReceptionistActionState> {
  const actor = await requireUser();
  try {
    const updated = await updateReceptionist(actor, text(formData, "id"), {
      name: text(formData, "name"),
      phone: text(formData, "phone"),
    });
    refresh();
    return { message: `Saved ${updated.name}'s details.` };
  } catch (error) {
    return describe(error, "The details could not be saved. Try again.");
  }
}

export async function setReceptionistAccessAction(
  _prev: ReceptionistActionState,
  formData: FormData,
): Promise<ReceptionistActionState> {
  const actor = await requireUser();
  try {
    const access = formData.getAll("access").map((value) => String(value));
    const updated = await setReceptionistAccess(actor, text(formData, "id"), access);
    refresh();
    return { message: `Saved. ${updated.name}'s access changes from their next click.` };
  } catch (error) {
    return describe(error, "The access could not be saved. Try again.");
  }
}

export async function setReceptionistActiveAction(
  _prev: ReceptionistActionState,
  formData: FormData,
): Promise<ReceptionistActionState> {
  const actor = await requireUser();
  const active = text(formData, "active") === "true";
  try {
    const updated = await setReceptionistActive(actor, text(formData, "id"), active);
    refresh();
    return {
      message: active
        ? `${updated.name} can sign in again.`
        : `${updated.name} is switched off and signed out everywhere.`,
    };
  } catch (error) {
    return describe(error, "That could not be changed. Try again.");
  }
}

export async function resetReceptionistPasswordAction(
  _prev: ReceptionistActionState,
  formData: FormData,
): Promise<ReceptionistActionState> {
  const actor = await requireUser();
  try {
    const issued = await resetReceptionistPassword(actor, text(formData, "id"));
    refresh();
    return {
      message: "New temporary password issued. They are signed out everywhere and choose their own at next sign-in.",
      email: issued.email,
      password: issued.password,
    };
  } catch (error) {
    return describe(error, "The password could not be reset. Try again.");
  }
}
