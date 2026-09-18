"use server";

/**
 * Server Actions for API keys and webhook endpoints.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen below this file.
 *
 * ## The secret in the action state
 *
 * `createApiKeyAction` and `createWebhookAction` return the plaintext secret in
 * their result so the page can show it once. That value goes to the browser
 * that submitted the form and nowhere else — it is never written to the
 * database, never audited, and never logged. It disappears from the page on
 * the next navigation, which is the intended lifetime.
 *
 * No action here takes an institution id.
 */

import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  createWebhook,
  deactivateWebhook,
  issueApiKey,
  revokeApiKey,
  updateWebhook,
} from "./service";
import { CredentialError } from "./types";

export interface CredentialActionState {
  error?: string;
  message?: string;
  /** Shown once, immediately after creation. Never re-readable. */
  secret?: string;
  secretNotice?: string;
  /** What the secret belongs to, so the reveal panel can label itself. */
  secretLabel?: string;
}

function describe(error: unknown, fallback: string): CredentialActionState {
  if (error instanceof CredentialError) return { error: error.message };
  if (error instanceof ForbiddenError) {
    return { error: "You do not have access to manage integration credentials." };
  }
  return { error: fallback };
}

function checkedValues(formData: FormData, field: string): string[] {
  return formData.getAll(field).map((value) => String(value));
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export async function createApiKeyAction(
  _prev: CredentialActionState,
  formData: FormData,
): Promise<CredentialActionState> {
  const actor = await requireUser();
  try {
    const issued = await issueApiKey(actor, {
      name: String(formData.get("name") ?? ""),
      scopes: checkedValues(formData, "scopes"),
    });
    refresh();
    return {
      message: `Key "${issued.key.name}" issued with ${issued.key.scopes.length} scope(s).`,
      secret: issued.secret,
      secretNotice: issued.notice,
      secretLabel: `API key for ${issued.key.name}`,
    };
  } catch (error) {
    return describe(error, "The key could not be issued.");
  }
}

export async function revokeApiKeyAction(
  _prev: CredentialActionState,
  formData: FormData,
): Promise<CredentialActionState> {
  const actor = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (id === "") return { error: "Choose a key to revoke." };
  try {
    const revoked = await revokeApiKey(actor, id);
    refresh();
    return {
      message: `Key "${revoked.name}" is revoked. Any system still using it will now be refused.`,
    };
  } catch (error) {
    return describe(error, "The key could not be revoked.");
  }
}

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

export async function createWebhookAction(
  _prev: CredentialActionState,
  formData: FormData,
): Promise<CredentialActionState> {
  const actor = await requireUser();
  try {
    const created = await createWebhook(actor, {
      url: String(formData.get("url") ?? ""),
      eventTypes: checkedValues(formData, "eventTypes"),
    });
    refresh();
    return {
      message: `Endpoint registered for ${created.endpoint.eventTypes.length} event type(s).`,
      secret: created.secret,
      secretNotice: created.notice,
      secretLabel: `Signing secret for ${created.endpoint.url}`,
    };
  } catch (error) {
    return describe(error, "The endpoint could not be registered.");
  }
}

export async function updateWebhookAction(
  _prev: CredentialActionState,
  formData: FormData,
): Promise<CredentialActionState> {
  const actor = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (id === "") return { error: "Choose an endpoint to update." };
  try {
    const updated = await updateWebhook(actor, id, {
      url: String(formData.get("url") ?? ""),
      eventTypes: checkedValues(formData, "eventTypes"),
      isActive: formData.get("isActive") === "on",
    });
    refresh();
    return {
      message: updated.isActive
        ? "Endpoint saved and receiving events."
        : "Endpoint saved. It is stopped, so nothing will be delivered to it.",
    };
  } catch (error) {
    return describe(error, "The endpoint could not be saved.");
  }
}

export async function stopWebhookAction(
  _prev: CredentialActionState,
  formData: FormData,
): Promise<CredentialActionState> {
  const actor = await requireUser();
  const id = String(formData.get("id") ?? "");
  if (id === "") return { error: "Choose an endpoint to stop." };
  try {
    const stopped = await deactivateWebhook(actor, id);
    refresh();
    return {
      message: `Delivery to ${stopped.url} is stopped. Its history is kept, and it can be started again.`,
    };
  } catch (error) {
    return describe(error, "The endpoint could not be stopped.");
  }
}
