"use client";

import { useActionState } from "react";
import { createAcademicSessionForm, type CreateAcademicSessionFormState } from "@/modules/academic-sessions/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CreateAcademicSessionFormState = {};

export function NewAcademicSessionForm() {
  const [state, formAction, pending] = useActionState(createAcademicSessionForm, initialState);
  return (
    // Keyed on the attempt so a refused submission remounts the fields with
    // what was typed, rather than React clearing them after the action.
    <form key={state.attempt ?? 0} action={formAction} className="flex max-w-md flex-col gap-4">
      <Field label="Name (e.g. 2026-27)" htmlFor="name">
        <Input id="name" name="name" required defaultValue={state.values?.name} />
      </Field>
      <Field label="Start date" htmlFor="startDate">
        <Input
          id="startDate"
          name="startDate"
          type="date"
          required
          defaultValue={state.values?.startDate}
        />
      </Field>
      <Field label="End date" htmlFor="endDate">
        <Input id="endDate" name="endDate" type="date" required defaultValue={state.values?.endDate} />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create academic year"}
      </Button>
    </form>
  );
}
