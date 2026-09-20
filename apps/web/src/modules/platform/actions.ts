"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { createInstitution, setInstitutionSuspended } from "./service";

/**
 * Server Actions for the platform tier.
 *
 * Thin by design. Each one resolves the actor from the session, hands the
 * request to the service, and translates the outcome into a redirect or a
 * form message. No authorization decision is made here — the service owns
 * that, and it owns it for every caller rather than for this form.
 *
 * The actor is never taken from the submitted form. A hidden `institutionId`
 * or `actorId` field would be a value the browser chose, and the whole point
 * of the platform tier is that its callers are the few who may cross tenant
 * boundaries.
 */

export interface PlatformFormState {
  error: string | null;
}

export async function createInstitutionAction(
  _previous: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  const user = await requireUser();

  const name = String(formData.get("name") ?? "");
  const type = String(formData.get("type") ?? "");
  const timezone = String(formData.get("timezone") ?? "").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();

  if (type !== "SCHOOL" && type !== "COLLEGE") {
    return { error: "Choose whether this institution is a school or a college." };
  }
  if (!name.trim()) {
    return { error: "The institution needs a name." };
  }

  let created: { id: string };
  try {
    created = await createInstitution(user, {
      name,
      type,
      timezone: timezone || undefined,
      contactEmail: contactEmail || null,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      // The same message whichever rule refused, so a caller cannot learn
      // which permission they are missing by reading the form.
      return { error: "You do not have permission to create an institution." };
    }
    throw error;
  }

  revalidatePath("/dashboard/platform/institutions");
  redirect(`/dashboard/platform/institutions/${created.id}`);
}

export async function setSuspendedAction(
  _previous: PlatformFormState,
  formData: FormData,
): Promise<PlatformFormState> {
  const user = await requireUser();
  const institutionId = String(formData.get("institutionId") ?? "");
  const suspend = String(formData.get("suspend") ?? "") === "true";
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  const expected = String(formData.get("expectedName") ?? "").trim();

  // Typed confirmation, and only for the destructive direction. Restoring a
  // tenant is not a step anybody needs slowing down; suspending one stops a
  // school being served, and the name is what makes "which one" unambiguous
  // on a page that lists many.
  if (suspend && confirmation !== expected) {
    return { error: `Type the institution's name exactly to suspend it: ${expected}` };
  }

  try {
    await setInstitutionSuspended(user, institutionId, suspend);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to change this institution's status." };
    }
    throw error;
  }

  revalidatePath(`/dashboard/platform/institutions/${institutionId}`);
  revalidatePath("/dashboard/platform/institutions");
  return { error: null };
}
