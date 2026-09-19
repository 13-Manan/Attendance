"use client";

import { useActionState } from "react";
import {
  createSubjectAction,
  updateSubjectAction,
  type SubjectActionState,
} from "@/modules/subjects/directory-actions";
import {
  MAX_SUBJECT_CODE,
  MAX_SUBJECT_NAME,
  type SubjectRow,
} from "@/modules/subjects/directory-types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: SubjectActionState = {};

/**
 * Add a subject, or correct one.
 *
 * One form for both, so a field cannot be added to one and forgotten on the
 * other. Both fields are editable in both modes: a subject's code is a label on
 * a timetable and nothing joins on it, so correcting a typo is a correction
 * rather than a new subject.
 *
 * Every field is keyed on `attempt`, because React resets a form when its
 * action completes: without the key a refused submission would clear what was
 * typed and quietly restore the stored values.
 *
 * The institution is not a field. It is read from the session below this
 * component, so there is nothing here a crafted submission could point at
 * another institution.
 */
export function SubjectForm({
  mode,
  subject,
}: {
  mode: "create" | "edit";
  subject?: SubjectRow;
}) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createSubjectAction : updateSubjectAction,
    initialState,
  );
  const key = state.attempt ?? 0;
  const values = state.values;

  return (
    <form action={formAction} className="flex w-full max-w-2xl flex-col gap-5">
      {subject ? <input type="hidden" name="id" value={subject.id} /> : null}

      <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr]">
        <Field label="Code" htmlFor="code">
          <Input
            key={`code-${key}`}
            id="code"
            name="code"
            required
            autoComplete="off"
            maxLength={MAX_SUBJECT_CODE}
            defaultValue={values?.code ?? subject?.code ?? ""}
            placeholder="PHY301"
          />
        </Field>
        <Field label="Name" htmlFor="name">
          <Input
            key={`name-${key}`}
            id="name"
            name="name"
            required
            autoComplete="off"
            maxLength={MAX_SUBJECT_NAME}
            defaultValue={values?.name ?? subject?.name ?? ""}
            placeholder="Quantum Mechanics"
          />
        </Field>
      </div>

      <p className="text-xs text-neutral-500">
        The code is written exactly as you type it — it is not upper-cased for you, because your
        timetable is the authority on how your codes are written. Two subjects in this college
        cannot share one.
      </p>

      {mode === "edit" && subject && subject.cohortCount > 0 ? (
        <p className="text-xs text-neutral-500">
          {subject.cohortCount.toLocaleString()}{" "}
          {subject.cohortCount === 1 ? "class offers" : "classes offer"} this subject. Renaming it
          changes what they show — the attendance already taken for it is not affected.
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? mode === "create"
              ? "Adding…"
              : "Saving…"
            : mode === "create"
              ? "Add subject"
              : "Save changes"}
        </Button>
        <p className="text-xs text-neutral-500">Recorded in the audit log against your name.</p>
      </div>
    </form>
  );
}
