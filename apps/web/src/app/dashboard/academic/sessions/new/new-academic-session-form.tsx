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
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <Field label="Name (e.g. 2026-27)" htmlFor="name">
        <Input id="name" name="name" required />
      </Field>
      <Field label="Start date" htmlFor="startDate">
        <Input id="startDate" name="startDate" type="date" required />
      </Field>
      <Field label="End date" htmlFor="endDate">
        <Input id="endDate" name="endDate" type="date" required />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create academic session"}
      </Button>
    </form>
  );
}
