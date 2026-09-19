"use client";

import { useActionState } from "react";
import {
  createCohortAction,
  updateCohortAction,
  type CohortActionState,
} from "@/modules/cohorts/directory-actions";
import {
  COHORT_WORDS,
  MAX_COHORT_NAME,
  MAX_TERM_LABEL,
  type CohortDetail,
  type CohortFormOptions,
} from "@/modules/cohorts/directory-types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const initialState: CohortActionState = {};

/**
 * Create a class, or rename one.
 *
 * One form for both, so a field cannot be added to one and forgotten on the
 * other. What differs is stated rather than implied: where the class sits in
 * the structure and which academic year it belongs to are chosen once, at
 * creation, and are shown as facts afterwards.
 *
 * That is a domain decision, not a missing feature. Those two fields are what
 * the class *is* — every enrollment, every register and every face review
 * already points at this row on that understanding — so moving "Grade 8 A,
 * 2026-27" into 2027-28 would silently re-file a year of attendance. A class in
 * the wrong year is created again in the right one and the wrong one is left to
 * its history.
 *
 * Every field is keyed on `attempt`, because React resets a form when its
 * action completes: without the key a refused submission would clear what was
 * typed and quietly restore the stored values.
 *
 * The institution is not a field. It is read from the session below this
 * component, so there is nothing here a crafted submission could point at
 * another institution.
 */
export function CohortForm({
  mode,
  cohort,
  options,
}: {
  mode: "create" | "edit";
  cohort?: CohortDetail;
  options: CohortFormOptions;
}) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createCohortAction : updateCohortAction,
    initialState,
  );
  const key = state.attempt ?? 0;
  const values = state.values;
  const words = COHORT_WORDS[options.institutionType];
  const isCollege = options.institutionType === "COLLEGE";

  const ready = options.units.length > 0 && options.sessions.length > 0;

  if (mode === "create" && !ready) {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">
          A {words.singular} needs somewhere to sit before it can be created.
        </p>
        <ul className="list-disc pl-5">
          {options.units.length === 0 ? (
            <li>
              Nothing exists in the academic structure yet — add{" "}
              {isCollege ? "a department and a programme" : "a grade"} under Structure first.
            </li>
          ) : null}
          {options.sessions.length === 0 ? (
            <li>No academic year has been created yet — add one under Academic years first.</li>
          ) : null}
        </ul>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-2xl flex-col gap-5">
      {cohort ? <input type="hidden" name="id" value={cohort.id} /> : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">
          What it is called
        </legend>

        <Field label={`${words.Singular} name`} htmlFor="name">
          <Input
            key={`name-${key}`}
            id="name"
            name="name"
            required
            autoComplete="off"
            maxLength={MAX_COHORT_NAME}
            defaultValue={values?.name ?? cohort?.name ?? ""}
            placeholder={isCollege ? "Section A" : "8-A"}
          />
          <p className="mt-1 text-xs text-neutral-500">
            {isCollege
              ? "What this section is called on your own lists — the registers, the notice board, the timetable."
              : "What the class is called on your own lists. Whatever appears on the register is the right answer."}
          </p>
        </Field>

        <Field label="Term (optional)" htmlFor="termLabel">
          <Input
            key={`termLabel-${key}`}
            id="termLabel"
            name="termLabel"
            autoComplete="off"
            maxLength={MAX_TERM_LABEL}
            defaultValue={values?.termLabel ?? cohort?.termLabel ?? ""}
            placeholder={isCollege ? "Odd semester" : "Term 1"}
          />
          <p className="mt-1 text-xs text-neutral-500">
            Only if the year is split and it helps tell two {words.plural} apart. Leave it empty
            otherwise.
          </p>
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Where it belongs</legend>

        {mode === "create" ? (
          <>
            <Field label="Part of the structure" htmlFor="academicUnitId">
              <Select
                key={`academicUnitId-${key}`}
                id="academicUnitId"
                name="academicUnitId"
                required
                defaultValue={values?.academicUnitId ?? ""}
              >
                <option value="">Choose one…</option>
                {options.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                    {unit.code ? ` (${unit.code})` : ""} — {unit.kind.toLowerCase()}
                    {unit.campusName ? ` · ${unit.campusName}` : ""}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Academic year" htmlFor="academicSessionId">
              <Select
                key={`academicSessionId-${key}`}
                id="academicSessionId"
                name="academicSessionId"
                required
                defaultValue={
                  values?.academicSessionId ??
                  options.sessions.find((session) => session.isCurrent)?.id ??
                  ""
                }
              >
                <option value="">Choose one…</option>
                {options.sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                    {session.isCurrent ? " (current)" : ""}
                    {session.isActive ? "" : " — archived"}
                  </option>
                ))}
              </Select>
            </Field>

            <p className="text-xs text-neutral-500">
              Both are fixed once the {words.singular} exists. The attendance taken for it is filed
              under them, so a {words.singular} in the wrong year is created again in the right one
              rather than moved.
            </p>
          </>
        ) : (
          <>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">
                  Part of the structure
                </dt>
                <dd className="text-neutral-900">
                  {cohort?.academicUnitName}
                  {cohort?.academicUnitCode ? ` (${cohort.academicUnitCode})` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Academic year</dt>
                <dd className="text-neutral-900">{cohort?.academicSessionName}</dd>
              </div>
            </dl>
            <p className="text-xs text-neutral-500">
              Neither can be changed. They are what this {words.singular} is, and{" "}
              {cohort && cohort.attendanceSessionCount > 0
                ? `${cohort.attendanceSessionCount.toLocaleString()} register${cohort.attendanceSessionCount === 1 ? " is" : "s are"} already filed under them`
                : "the attendance taken for it will be filed under them"}
              .
            </p>
          </>
        )}
      </fieldset>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? mode === "create"
              ? "Creating…"
              : "Saving…"
            : mode === "create"
              ? `Create ${words.singular}`
              : "Save changes"}
        </Button>
        <p className="text-xs text-neutral-500">Recorded in the audit log against your name.</p>
      </div>
    </form>
  );
}
