"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/modules/auth-tenancy/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: LoginState = {};

const ERROR_ID = "login-error";

/**
 * The sign-in form.
 *
 * Three outcomes, three different things to say:
 *
 *  - *invalid* — the credentials were refused, or the fields did not parse.
 *    Red, and the inputs are marked `aria-invalid` so the fields themselves
 *    carry the failure, not only the sentence above the button.
 *  - *unavailable* — the app could not reach its database. Amber, and phrased
 *    as "try again", because there is nothing for the user to correct. It
 *    must not be red: telling somebody their password is wrong when the
 *    service is down sends them to reset a password that works.
 *  - *pending* — the button reports it and the fields go read-only, so a
 *    second submission cannot race the first.
 *
 * The message is one `role="alert"` region referenced by both inputs, so a
 * screen reader announces the failure once and either field explains it.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(login, initialState);

  const hasError = Boolean(state.error);
  const unavailable = state.kind === "unavailable";
  // Only credential failures belong on the fields. A service outage says
  // nothing about what was typed, so marking the inputs invalid would be a
  // lie the screen reader repeats on every focus.
  const fieldsInvalid = hasError && !unavailable;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate={false}>
      {/* Where to go after signing in. Sanitised on the server that rendered
          it and sanitised again in the action — a hidden field is not a
          trusted one. */}
      <input type="hidden" name="next" value={next} />

      <Field label="Email" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          readOnly={pending}
          aria-invalid={fieldsInvalid || undefined}
          aria-describedby={hasError ? ERROR_ID : undefined}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          readOnly={pending}
          aria-invalid={fieldsInvalid || undefined}
          aria-describedby={hasError ? ERROR_ID : undefined}
        />
      </Field>

      {state.error ? (
        <p
          id={ERROR_ID}
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${
            unavailable
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
