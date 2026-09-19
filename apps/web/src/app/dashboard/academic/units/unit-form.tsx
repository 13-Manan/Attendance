"use client";

import { useActionState } from "react";
import {
  createUnitAction,
  updateUnitAction,
  type UnitActionState,
} from "@/modules/academic-structure/directory-actions";
import {
  MAX_SORT_ORDER,
  MAX_UNIT_CODE,
  MAX_UNIT_NAME,
  type UnitFormOptions,
  type UnitRow,
} from "@/modules/academic-structure/directory-types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const initialState: UnitActionState = {};

/** "— — Semester 3", so a flat dropdown can still be read as a tree. */
function indent(depth: number): string {
  return depth === 0 ? "" : `${"— ".repeat(depth)}`;
}

/**
 * Add a part of the academic structure, or rename one.
 *
 * One form for both, so a field cannot be added to one and forgotten on the
 * other. What differs is stated rather than implied: what kind of thing it is,
 * what it sits inside and which campus it is at are chosen once, at creation,
 * and are shown as facts afterwards.
 *
 * That is a domain decision. Those three decide where every class underneath
 * sits, and every register taken for those classes is filed accordingly —
 * moving a grade to another campus would quietly re-file a year of attendance.
 * Something in the wrong place is created again in the right one.
 *
 * Every field is keyed on `attempt`, because React resets a form when its
 * action completes: without the key a refused submission would clear what was
 * typed and quietly restore the stored values.
 *
 * The institution is not a field. It is read from the session below this
 * component, so there is nothing here a crafted submission could point at
 * another institution.
 */
export function UnitForm({
  mode,
  unit,
  options,
}: {
  mode: "create" | "edit";
  unit?: UnitRow;
  options: UnitFormOptions;
}) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createUnitAction : updateUnitAction,
    initialState,
  );
  const key = state.attempt ?? 0;
  const values = state.values;

  return (
    <form action={formAction} className="flex w-full max-w-2xl flex-col gap-5">
      {unit ? <input type="hidden" name="id" value={unit.id} /> : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">What it is</legend>

        {mode === "create" ? (
          <Field label="Kind" htmlFor="kind">
            <Select
              key={`kind-${key}`}
              id="kind"
              name="kind"
              required
              defaultValue={values?.kind ?? options.allowedKinds[0] ?? ""}
            >
              {options.allowedKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {options.labels[kind] ?? kind}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-neutral-500">
              Only the kinds a {options.institutionType === "COLLEGE" ? "college" : "school"} can
              have are listed, and this cannot be changed afterwards.
            </p>
          </Field>
        ) : (
          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-500">Kind</p>
            <p className="text-sm text-neutral-900">
              {unit ? (options.labels[unit.kind] ?? unit.kind) : ""}
            </p>
          </div>
        )}

        <Field label="Name" htmlFor="name">
          <Input
            key={`name-${key}`}
            id="name"
            name="name"
            required
            autoComplete="off"
            maxLength={MAX_UNIT_NAME}
            defaultValue={values?.name ?? unit?.name ?? ""}
            placeholder={options.institutionType === "COLLEGE" ? "Computer Science" : "Grade 8"}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code (optional)" htmlFor="code">
            <Input
              key={`code-${key}`}
              id="code"
              name="code"
              autoComplete="off"
              maxLength={MAX_UNIT_CODE}
              defaultValue={values?.code ?? unit?.code ?? ""}
              placeholder={options.institutionType === "COLLEGE" ? "CSE" : "VIII"}
            />
          </Field>
          <Field label="Order" htmlFor="sortOrder">
            <Input
              key={`sortOrder-${key}`}
              id="sortOrder"
              name="sortOrder"
              type="number"
              min={0}
              max={MAX_SORT_ORDER}
              step={1}
              defaultValue={values?.sortOrder ?? String(unit?.sortOrder ?? 0)}
            />
            <p className="mt-1 text-xs text-neutral-500">
              Lower shows first. Leave it at 0 if the order does not matter.
            </p>
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Where it sits</legend>

        {mode === "create" ? (
          <>
            <Field label="Inside (optional)" htmlFor="parentId">
              <Select
                key={`parentId-${key}`}
                id="parentId"
                name="parentId"
                defaultValue={values?.parentId ?? ""}
              >
                <option value="">Nothing — it sits at the top</option>
                {options.parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {indent(parent.depth)}
                    {parent.name} ({options.labels[parent.kind] ?? parent.kind})
                  </option>
                ))}
              </Select>
            </Field>

            {options.campuses.length > 0 ? (
              <Field label="Campus (optional)" htmlFor="campusId">
                <Select
                  key={`campusId-${key}`}
                  id="campusId"
                  name="campusId"
                  defaultValue={values?.campusId ?? ""}
                >
                  <option value="">No campus</option>
                  {options.campuses.map((campus) => (
                    <option key={campus.id} value={campus.id}>
                      {campus.name} ({campus.code}){campus.isActive ? "" : " — closed"}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <p className="text-xs text-neutral-500">
              Both are fixed once it exists. Every class created underneath is filed against them,
              so something in the wrong place is created again in the right one rather than moved.
            </p>
          </>
        ) : (
          <>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Inside</dt>
                <dd className="text-neutral-900">
                  {unit?.parentName ?? <span className="text-neutral-400">Nothing</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Campus</dt>
                <dd className="text-neutral-900">
                  {unit?.campusName ?? <span className="text-neutral-400">No campus</span>}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-neutral-500">
              Neither can be changed.{" "}
              {unit && unit.cohortCount > 0
                ? `${unit.cohortCount.toLocaleString()} ${unit.cohortCount === 1 ? "class is" : "classes are"} already filed under this, along with the attendance taken for them.`
                : `Classes created under this will be filed against them.`}
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
              ? "Adding…"
              : "Saving…"
            : mode === "create"
              ? "Add to the structure"
              : "Save changes"}
        </Button>
        <p className="text-xs text-neutral-500">Recorded in the audit log against your name.</p>
      </div>
    </form>
  );
}
