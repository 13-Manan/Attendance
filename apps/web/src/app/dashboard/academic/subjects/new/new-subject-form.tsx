"use client";

import { useActionState } from "react";
import { createSubjectForm, type CreateSubjectFormState } from "@/modules/subjects/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CreateSubjectFormState = {};

export function NewSubjectForm() {
  const [state, formAction, pending] = useActionState(createSubjectForm, initialState);
  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <Field label="Subject code (e.g. CS301)" htmlFor="code">
        <Input id="code" name="code" required />
      </Field>
      <Field label="Subject name (e.g. Database Management)" htmlFor="name">
        <Input id="name" name="name" required />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create subject"}
      </Button>
    </form>
  );
}
