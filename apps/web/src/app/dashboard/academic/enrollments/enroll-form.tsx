"use client";

import { useActionState } from "react";
import { enrollStudentInCohortForm, type EnrollFormState } from "@/modules/enrollment/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

const initialState: EnrollFormState = {};

interface Props {
  cohorts: { id: string; label: string }[];
  students: { id: string; label: string }[];
}

export function EnrollForm({ cohorts, students }: Props) {
  const [state, formAction, pending] = useActionState(enrollStudentInCohortForm, initialState);
  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <Field label="Cohort" htmlFor="cohortId">
        <select
          id="cohortId"
          name="cohortId"
          required
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Student" htmlFor="studentId">
        <select
          id="studentId"
          name="studentId"
          required
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {state.ok && <p className="text-sm text-green-700">Student enrolled.</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Enrolling…" : "Enroll student"}
      </Button>
    </form>
  );
}
