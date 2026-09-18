"use client";

import { useActionState } from "react";
import { createCohortForm, type CreateCohortFormState } from "@/modules/cohorts/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CreateCohortFormState = {};

interface Props {
  units: { id: string; label: string }[];
  sessions: { id: string; label: string }[];
}

export function NewCohortForm({ units, sessions }: Props) {
  const [state, formAction, pending] = useActionState(createCohortForm, initialState);
  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <Field label="Academic unit" htmlFor="academicUnitId">
        <select
          id="academicUnitId"
          name="academicUnitId"
          required
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Academic session" htmlFor="academicSessionId">
        <select
          id="academicSessionId"
          name="academicSessionId"
          required
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Cohort name (e.g. 10-A, BCA-Sem3-A)" htmlFor="name">
        <Input id="name" name="name" required />
      </Field>
      <Field label="Term label (optional)" htmlFor="termLabel">
        <Input id="termLabel" name="termLabel" />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create cohort"}
      </Button>
    </form>
  );
}
