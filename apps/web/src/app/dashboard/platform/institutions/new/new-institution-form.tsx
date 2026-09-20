"use client";

import { useActionState } from "react";
import { createInstitutionAction, type PlatformFormState } from "@/modules/platform/actions";
import { Button } from "@/components/ui/button";

const INITIAL: PlatformFormState = { error: null };

/**
 * A plain form posting a Server Action.
 *
 * No client-side validation beyond `required`: the server validates anyway,
 * and a second copy of the rules in the browser is a second place for them to
 * drift. What the client does own is saying *which* field is wrong without a
 * round trip, which `required` and `type` give for free.
 */
export function NewInstitutionForm() {
  const [state, action, pending] = useActionState(createInstitutionAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">Name</span>
        <input
          name="name"
          required
          maxLength={200}
          autoComplete="organization"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-700">Type</legend>
        <label className="flex items-center gap-2 text-sm text-neutral-800">
          <input type="radio" name="type" value="SCHOOL" required className="h-4 w-4" />
          School — one daily register per class
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-800">
          <input type="radio" name="type" value="COLLEGE" className="h-4 w-4" />
          College — one register per subject session
        </label>
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">Contact email</span>
        <input
          name="contactEmail"
          type="email"
          autoComplete="email"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
        />
        <span className="text-xs text-neutral-500">Optional. The institution&apos;s own address.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">Timezone</span>
        <input
          name="timezone"
          defaultValue="UTC"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
        />
      </label>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create institution"}
        </Button>
      </div>
    </form>
  );
}
