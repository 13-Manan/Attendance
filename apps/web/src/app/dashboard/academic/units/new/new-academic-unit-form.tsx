"use client";

import { useActionState } from "react";
import type { AcademicUnitKind } from "@prisma/client";
import { createAcademicUnitForm, type CreateAcademicUnitFormState } from "@/modules/academic-structure/actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CreateAcademicUnitFormState = {};

interface Props {
  allowedKinds: AcademicUnitKind[];
  parents: { id: string; label: string }[];
}

export function NewAcademicUnitForm({ allowedKinds, parents }: Props) {
  const [state, formAction, pending] = useActionState(createAcademicUnitForm, initialState);
  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <Field label="Kind" htmlFor="kind">
        <select
          id="kind"
          name="kind"
          required
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          {allowedKinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Parent (optional)" htmlFor="parentId">
        <select
          id="parentId"
          name="parentId"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
        >
          <option value="">(no parent)</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name" htmlFor="name">
        <Input id="name" name="name" required />
      </Field>
      <Field label="Code (optional)" htmlFor="code">
        <Input id="code" name="code" />
      </Field>
      <Field label="Sort order" htmlFor="sortOrder">
        <Input id="sortOrder" name="sortOrder" type="number" defaultValue={0} />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create unit"}
      </Button>
    </form>
  );
}
