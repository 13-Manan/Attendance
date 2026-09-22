"use client";

import { useActionState, useState } from "react";
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
 *
 * After a failure the address is put back and the cursor goes to the password
 * box. React clears a form once its action completes, which is right for the
 * password and wrong for the email — on a phone, retyping an address to try a
 * password again is most of the work of signing in.
 *
 * Phase 4 additions (presentation only): a password visibility toggle keyed
 * off local state, an inline spinner on the submit button, and semantic-token
 * error surfaces. The server action, aria wiring, `attempt` remount trick,
 * `autoFocus` policy and `readOnly` gating are unchanged from what shipped.
 */
export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);

  const hasError = Boolean(state.error);
  const unavailable = state.kind === "unavailable";
  // Only credential failures belong on the fields. A service outage says
  // nothing about what was typed, so marking the inputs invalid would be a
  // lie the screen reader repeats on every focus.
  const fieldsInvalid = hasError && !unavailable;
  // Remounts both fields after a submission so `defaultValue` is applied
  // again; without it a second failure on the same address leaves the box
  // empty, because an uncontrolled input ignores a later defaultValue.
  const attempt = state.attempt ?? 0;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate={false}>
      {/* Where to go after signing in. Sanitised on the server that rendered
          it and sanitised again in the action — a hidden field is not a
          trusted one. */}
      <input type="hidden" name="next" value={next} />

      <Field label="Email" htmlFor="email">
        <Input
          key={`email-${attempt}`}
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.email ?? ""}
          placeholder="you@institution.edu"
          // On arrival, the cursor belongs here. After a failure it belongs in
          // the password box below, which is the field there is any point
          // changing.
          autoFocus={!hasError}
          readOnly={pending}
          aria-invalid={fieldsInvalid || undefined}
          aria-describedby={hasError ? ERROR_ID : undefined}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          key={`password-${attempt}`}
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          required
          autoFocus={hasError}
          readOnly={pending}
          aria-invalid={fieldsInvalid || undefined}
          aria-describedby={hasError ? ERROR_ID : undefined}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              // `aria-pressed` announces the *toggle state*; the visible label
              // announces the *action*. A user hears "Show password, toggle,
              // pressed" and knows both what will happen and what happened.
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
              // Not a submit — a nested button in a form must be explicit or
              // it becomes the default submit on Enter.
              tabIndex={0}
              disabled={pending}
              className="inline-flex size-9 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent"
            >
              <EyeIcon open={!showPassword} />
            </button>
          }
        />
      </Field>

      {state.error ? (
        <p
          id={ERROR_ID}
          role="alert"
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
            unavailable
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          <span aria-hidden className="mt-0.5 shrink-0">
            {unavailable ? <AlertTriangleIcon /> : <AlertCircleIcon />}
          </span>
          <span className="min-w-0">{state.error}</span>
        </p>
      ) : null}

      <Button type="submit" disabled={pending} aria-busy={pending || undefined} className="w-full">
        {pending ? (
          <>
            <Spinner />
            <span>Signing in…</span>
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}

/**
 * The three inline SVGs below are kept local rather than pulled in as a full
 * icon library — a login form is not worth a dependency, and inlining keeps
 * the icon's stroke consistent with the current typography weight. They are
 * decorative (`aria-hidden` at every use site) so no title is emitted.
 *
 * `EyeIcon` renders one of two shapes: an eye when the password is currently
 * masked (so tapping will reveal), an eye-with-slash when it is currently
 * shown (so tapping will hide) — the same mental model native password
 * managers use.
 */
function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17.94 17.94A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a19.9 19.9 0 0 1 4.22-5.06" />
      <path d="M9.9 4.24A9.5 9.5 0 0 1 12 4c6.5 0 10 7 10 7a19.7 19.7 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

function AlertCircleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

function AlertTriangleIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin motion-reduce:hidden"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
