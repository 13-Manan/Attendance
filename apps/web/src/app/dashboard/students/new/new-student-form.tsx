"use client";

import { useActionState } from "react";
import { createStudentForm, type CreateStudentFormState } from "@/modules/students/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CreateStudentFormState = {};

export function NewStudentForm({ institutionId }: { institutionId: string }) {
  const [state, formAction, pending] = useActionState(createStudentForm, initialState);

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <input type="hidden" name="institutionId" value={institutionId} />
      <Field label="Student code" htmlFor="studentCode">
        <Input id="studentCode" name="studentCode" required />
      </Field>
      <Field label="First name" htmlFor="firstName">
        <Input id="firstName" name="firstName" required />
      </Field>
      <Field label="Last name" htmlFor="lastName">
        <Input id="lastName" name="lastName" required />
      </Field>
      <Field label="Email (optional)" htmlFor="email">
        <Input id="email" name="email" type="email" />
      </Field>
      <Field label="Phone (optional)" htmlFor="phone">
        <Input id="phone" name="phone" />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create student"}
      </Button>
    </form>
  );
}
