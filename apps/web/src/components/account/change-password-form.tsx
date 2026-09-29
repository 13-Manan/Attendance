"use client";

import { useActionState } from "react";
import {
  changePasswordAction,
  type ChangePasswordState,
} from "@/modules/auth-tenancy/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const INITIAL: ChangePasswordState = {};
const ERROR_ID = "change-password-error";

/**
 * Current password, new password, the new one again.
 *
 * The fields are remounted after every submission (the `attempt` key), so a
 * password never lingers in a box after the server has answered — right or
 * wrong, it has to be typed again.
 *
 * Also the form a student replaces a temporary password with, before the
 * portal opens: the same fields and rules, another action, other words.
 */
export function ChangePasswordForm({
  hint = "At least 8 characters. Not the same as the student ID.",
  action = changePasswordAction,
  currentLabel = "Current password",
  submitLabel = "Change password",
  pendingLabel = "Changing…",
}: {
  /** The rule under the new-password box, in the words of whoever is signed in. */
  hint?: string;
  /** The action the fields go to — the Account page's change, unless the page says otherwise. */
  action?: (state: ChangePasswordState, formData: FormData) => Promise<ChangePasswordState>;
  currentLabel?: string;
  submitLabel?: string;
  pendingLabel?: string;
} = {}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const attempt = state.attempt ?? 0;
  const invalid = Boolean(state.error);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label={currentLabel} htmlFor="currentPassword">
        <Input
          key={`current-${attempt}`}
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          readOnly={pending}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? ERROR_ID : undefined}
        />
      </Field>
      <Field label="New password" htmlFor="newPassword">
        <Input
          key={`new-${attempt}`}
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          readOnly={pending}
          aria-invalid={invalid || undefined}
          aria-describedby="new-password-hint"
        />
      </Field>
      <p id="new-password-hint" className="-mt-2 text-xs text-neutral-500">
        {hint}
      </p>
      <Field label="Confirm new password" htmlFor="confirmPassword">
        <Input
          key={`confirm-${attempt}`}
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          readOnly={pending}
          aria-invalid={invalid || undefined}
        />
      </Field>

      {state.error ? (
        <p
          id={ERROR_ID}
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {state.error}
        </p>
      ) : null}
      {state.changed ? (
        <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Password changed.{" "}
          {state.changed.otherSessionsEnded === 0
            ? "No other device was signed in."
            : `${state.changed.otherSessionsEnded} other ${
                state.changed.otherSessionsEnded === 1 ? "device was" : "devices were"
              } signed out and will need the new password.`}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
