"use client";

import { useActionState } from "react";
import {
  updateAcademicSessionAction,
  type AcademicSessionActionState,
} from "@/modules/academic-sessions/actions";
import { MAX_SESSION_NAME, type AcademicSession } from "@/modules/academic-sessions/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: AcademicSessionActionState = {};

/** The `value` an `<input type="date">` wants, from a UTC-midnight Date. */
function dateValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Rename an academic year or move its dates.
 *
 * The fields are keyed on `attempt` so a refused submission redisplays what
 * was typed: React resets a form when its action completes, which would
 * otherwise throw the administrator's edit away and silently restore the
 * stored values.
 *
 * The year's id is a hidden field and the institution is not a field at all —
 * the service reads the tenant from the session and scopes the update to it,
 * so an id from another institution's URL matches no row.
 */
export function AcademicSessionForm({ session }: { session: AcademicSession }) {
  const [state, formAction, pending] = useActionState(updateAcademicSessionAction, initialState);
  const key = state.attempt ?? 0;

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <input type="hidden" name="id" value={session.id} />

      <Field label="Name" htmlFor="name">
        <Input
          key={`name-${key}`}
          id="name"
          name="name"
          required
          maxLength={MAX_SESSION_NAME}
          defaultValue={state.values?.name ?? session.name}
        />
      </Field>

      <Field label="Start date" htmlFor="startDate">
        <Input
          key={`startDate-${key}`}
          id="startDate"
          name="startDate"
          type="date"
          required
          defaultValue={state.values?.startDate ?? dateValue(session.startDate)}
        />
      </Field>

      <Field label="End date" htmlFor="endDate">
        <Input
          key={`endDate-${key}`}
          id="endDate"
          name="endDate"
          type="date"
          required
          defaultValue={state.values?.endDate ?? dateValue(session.endDate)}
        />
      </Field>

      <p className="text-xs text-neutral-500">
        Moving the dates does not change a register that has already been taken. Nothing is
        deleted, and the change is recorded in the audit log against your name.
      </p>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save year"}
        </Button>
      </div>
    </form>
  );
}
