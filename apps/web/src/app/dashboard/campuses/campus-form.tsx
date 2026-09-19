"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  createCampusAction,
  updateCampusAction,
  type CampusActionState,
} from "@/modules/campuses/actions";
import { MAX_CAMPUS_ADDRESS, MAX_CAMPUS_CODE, MAX_CAMPUS_NAME } from "@/modules/campuses/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CampusActionState = {};

/**
 * One form for adding and for editing.
 *
 * The two differ in exactly three ways — the action, the hidden id, and the
 * wording of the button — so they are one component. Two near-identical forms
 * is how the add screen ends up with a field the edit screen quietly drops.
 *
 * ## Why the fields are keyed
 *
 * React resets a form once its action completes, which would wipe what the
 * administrator typed the moment the server refused it. The server echoes the
 * submitted values back in `state.values` along with an `attempt` counter; the
 * counter changes on every submission, so keying the inputs on it remounts
 * them with the refused text still in place. Without the key the remount never
 * happens and the new `defaultValue` is ignored.
 *
 * ## Why there is no institution field
 *
 * There is nowhere to put one. The action takes the institution from the
 * session — see the tenancy note in `modules/campuses/service.ts` — so no
 * hidden input, crafted request or edited DOM can aim this form at another
 * institution.
 */
export function CampusForm({
  campus,
}: {
  /** Absent when adding. */
  campus?: { id: string; name: string; code: string; address: string | null };
}) {
  const [state, formAction, pending] = useActionState(
    campus ? updateCampusAction : createCampusAction,
    initialState,
  );

  const values = state.values ?? {
    name: campus?.name ?? "",
    code: campus?.code ?? "",
    address: campus?.address ?? "",
  };
  const attempt = state.attempt ?? 0;

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      {campus ? <input type="hidden" name="id" value={campus.id} /> : null}

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <Field label="Name" htmlFor="name">
        <Input
          key={`name-${attempt}`}
          id="name"
          name="name"
          required
          maxLength={MAX_CAMPUS_NAME}
          defaultValue={values.name}
          placeholder="North Campus"
          autoComplete="off"
        />
      </Field>

      <Field label="Short code" htmlFor="code">
        <Input
          key={`code-${attempt}`}
          id="code"
          name="code"
          required
          maxLength={MAX_CAMPUS_CODE}
          defaultValue={values.code}
          placeholder="NORTH"
          autoComplete="off"
          className="font-mono uppercase"
        />
      </Field>
      <p className="-mt-2 text-xs text-neutral-500">
        Letters, digits, hyphens and underscores. Stored in capitals, so NORTH and north are the
        same code and an institution cannot end up with two campuses nobody can tell apart.
      </p>

      <Field label="Address (optional)" htmlFor="address">
        <textarea
          key={`address-${attempt}`}
          id="address"
          name="address"
          rows={3}
          maxLength={MAX_CAMPUS_ADDRESS}
          defaultValue={values.address}
          placeholder="12 Nehru Road, Pune 411001"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : campus ? "Save changes" : "Add campus"}
        </Button>
        <Link
          href="/dashboard/campuses"
          className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
