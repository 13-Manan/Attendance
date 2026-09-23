"use client";

import { useActionState, useId, useState } from "react";
import {
  addSectionAction,
  createClassAction,
  inviteTeacherForSectionAction,
  removeSectionAction,
  removeSectionTeacherAction,
  renameClassAction,
  renameSectionAction,
  setSectionTeacherAction,
  type SchoolSetupActionState,
} from "@/modules/school-setup/actions";
import {
  duplicateNames,
  sectionGroupName,
  sectionKey,
  sectionLabel,
  suggestSectionName,
  tidyName,
} from "@/modules/school-setup/policy";
import {
  MAX_CLASS_NAME,
  MAX_SECTION_NAME,
  MAX_SECTIONS,
  type StaffChoice,
} from "@/modules/school-setup/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/use-confirm";

const initialState: SchoolSetupActionState = {};

/**
 * Controls for the school Classes screens.
 *
 * Each control holds its own action state, for the reason recorded in
 * `faculty/faculty-controls.tsx`: a refusal belongs next to the thing that was
 * refused, not in a banner at the top of the page.
 */

function Banner({ state }: { state: SchoolSetupActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
        {state.message}
      </p>
    );
  }
  return null;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-neutral-500">{children}</p>;
}

function TeacherOptions({ teachers, empty }: { teachers: StaffChoice[]; empty: string }) {
  return (
    <>
      <option value="">{empty}</option>
      {teachers.map((teacher) => (
        <option key={teacher.id} value={teacher.id}>
          {teacher.name} ({teacher.email})
        </option>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add class
// ---------------------------------------------------------------------------

interface Row {
  key: number;
  name: string;
  teacherId: string;
}

function rowsFor(count: number, names: readonly string[]): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    key: index,
    name: names[index] ?? suggestSectionName(index),
    teacherId: "",
  }));
}

/**
 * Add a class: its name, how many sections, what each is called, and —
 * optionally — who teaches each one.
 *
 * One form rather than a wizard: four decisions fit on one screen, and seeing
 * the section names beside the count is what stops "4" meaning A–D when the
 * school says Rose, Lily, Iris, Jasmine. Names are pre-filled A, B, C… as a
 * suggestion and are ordinary text fields.
 *
 * The browser checks duplicates as they are typed so the clash is marked on
 * the row itself; the server checks again, under a lock, before it writes.
 */
export function NewClassForm({
  yearId,
  yearName,
  teachers,
  initialName = "",
  initialSections = [],
}: {
  yearId: string;
  yearName: string;
  teachers: StaffChoice[];
  initialName?: string;
  initialSections?: string[];
}) {
  const [state, formAction, pending] = useActionState(createClassAction, initialState);
  const [className, setClassName] = useState(initialName);
  const startCount = initialSections.length > 0 ? initialSections.length : 1;
  const [countText, setCountText] = useState(String(startCount));
  const [rows, setRows] = useState<Row[]>(() => rowsFor(startCount, initialSections));
  const [nextKey, setNextKey] = useState(startCount);
  const idPrefix = useId();

  const count = Number.parseInt(countText, 10);
  const countValid = Number.isInteger(count) && count >= 1 && count <= MAX_SECTIONS;

  function changeCount(text: string) {
    setCountText(text);
    const next = Number.parseInt(text, 10);
    if (!Number.isInteger(next) || next < 1 || next > MAX_SECTIONS) return;
    if (next > rows.length) {
      const added = Array.from({ length: next - rows.length }, (_, offset) => {
        const index = rows.length + offset;
        return {
          key: nextKey + offset,
          name: initialSections[index] ?? suggestSectionName(index),
          teacherId: "",
        };
      });
      setNextKey(nextKey + added.length);
      setRows([...rows, ...added]);
    } else {
      setRows(rows.slice(0, next));
    }
  }

  function updateRow(key: number, patch: Partial<Row>) {
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  const clashes = new Set(duplicateNames(rows.map((row) => row.name)).map(sectionKey));
  const hasEmpty = rows.some((row) => tidyName(row.name) === "");
  const classNameClean = tidyName(className);
  const preview =
    classNameClean === ""
      ? null
      : rows
          .filter((row) => tidyName(row.name) !== "")
          .map((row) => sectionGroupName(classNameClean, row.name));

  const countError = countValid
    ? undefined
    : `Enter a number from 1 to ${MAX_SECTIONS}.`;

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      <input type="hidden" name="yearId" value={yearId} />
      <Banner state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Class name" htmlFor={`${idPrefix}-class`}>
          <Input
            id={`${idPrefix}-class`}
            name="className"
            required
            maxLength={MAX_CLASS_NAME}
            placeholder="Class 8"
            value={className}
            onChange={(event) => setClassName(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Number of sections" htmlFor={`${idPrefix}-count`} error={countError}>
          <Input
            id={`${idPrefix}-count`}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SECTIONS}
            value={countText}
            aria-invalid={!countValid}
            onChange={(event) => changeCount(event.target.value)}
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-neutral-700">Sections</legend>
        <Note>
          Name each section the way your school does — A, B, C or any other name. Choosing a
          teacher now is optional; you can assign one later.
        </Note>
        <ol className="flex flex-col gap-3">
          {rows.map((row, index) => {
            const duplicate = clashes.has(sectionKey(row.name));
            const empty = tidyName(row.name) === "";
            const nameId = `${idPrefix}-section-${row.key}`;
            const teacherId = `${idPrefix}-teacher-${row.key}`;
            const errorId = `${nameId}-error`;
            return (
              <li
                key={row.key}
                className="grid gap-3 rounded-md border border-neutral-200 p-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-start"
              >
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={nameId} className="text-sm font-medium text-neutral-700">
                    Section {index + 1} name
                  </label>
                  <Input
                    id={nameId}
                    name="sectionName"
                    required
                    maxLength={MAX_SECTION_NAME}
                    value={row.name}
                    aria-invalid={duplicate || empty}
                    aria-describedby={duplicate || empty ? errorId : undefined}
                    onChange={(event) => updateRow(row.key, { name: event.target.value })}
                    autoComplete="off"
                  />
                  {duplicate || empty ? (
                    <p id={errorId} className="text-sm text-red-600">
                      {empty ? "Enter a name." : "Another section already has this name."}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={teacherId} className="text-sm font-medium text-neutral-700">
                    Teacher <span className="font-normal text-neutral-500">(optional)</span>
                  </label>
                  <Select
                    id={teacherId}
                    name="teacherId"
                    value={row.teacherId}
                    onChange={(event) => updateRow(row.key, { teacherId: event.target.value })}
                  >
                    <TeacherOptions teachers={teachers} empty="Assign later" />
                  </Select>
                </div>
              </li>
            );
          })}
        </ol>
        {teachers.length === 0 ? (
          <Note>
            No teachers are available to choose yet. You can add a teacher from each section once
            the class is created.
          </Note>
        ) : null}
      </fieldset>

      {preview && preview.length > 0 ? (
        <p className="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-700" aria-live="polite">
          Will create {preview.length === 1 ? "section" : "sections"}{" "}
          <span className="font-medium text-neutral-900">{preview.join(", ")}</span> for {yearName}.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={pending || !countValid || clashes.size > 0 || hasEmpty || classNameClean === ""}
        >
          {pending ? "Creating…" : "Create class"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Class page
// ---------------------------------------------------------------------------

export function RenameClassForm({
  classId,
  yearId,
  name,
}: {
  classId: string;
  yearId: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(renameClassAction, initialState);
  const id = useId();
  return (
    <form key={state.attempt ?? 0} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="classId" value={classId} />
      <input type="hidden" name="yearId" value={yearId} />
      <Banner state={state} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Class name" htmlFor={id}>
            <Input
              id={id}
              name="name"
              required
              maxLength={MAX_CLASS_NAME}
              defaultValue={state.error ? state.values?.name : name}
              autoComplete="off"
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Rename class"}
        </Button>
      </div>
      <Note>
        The new name shows for every year. Attendance and reports from earlier years keep the
        section names they were taught under.
      </Note>
    </form>
  );
}

export function AddSectionForm({
  classId,
  yearId,
  teachers,
  suggestion,
}: {
  classId: string;
  yearId: string;
  teachers: StaffChoice[];
  suggestion: string;
}) {
  const [state, formAction, pending] = useActionState(addSectionAction, initialState);
  const id = useId();
  return (
    <form key={state.attempt ?? 0} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="classId" value={classId} />
      <input type="hidden" name="yearId" value={yearId} />
      <Banner state={state} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-end">
        <Field label="Section name" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            name="name"
            required
            maxLength={MAX_SECTION_NAME}
            defaultValue={state.error ? state.values?.name : suggestion}
            autoComplete="off"
          />
        </Field>
        <Field label="Teacher (optional)" htmlFor={`${id}-teacher`}>
          <Select
            id={`${id}-teacher`}
            name="teacherId"
            defaultValue={state.error ? (state.values?.teacherId ?? "") : ""}
          >
            <TeacherOptions teachers={teachers} empty="Assign later" />
          </Select>
        </Field>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Adding…" : "Add section"}
        </Button>
      </div>
    </form>
  );
}

/** Assign a teacher from the class page, for a section that has none. */
export function QuickAssignTeacher({
  sectionId,
  sectionName,
  teachers,
}: {
  sectionId: string;
  sectionName: string;
  teachers: StaffChoice[];
}) {
  const [state, formAction, pending] = useActionState(setSectionTeacherAction, initialState);
  const id = useId();
  if (teachers.length === 0) return null;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="sectionId" value={sectionId} />
      {state.error ? <Banner state={state} /> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor={id} className="sr-only">
          Teacher for {sectionLabel(sectionName)}
        </label>
        <Select id={id} name="teacherId" required defaultValue="" className="sm:max-w-xs">
          <TeacherOptions teachers={teachers} empty="Choose a teacher" />
        </Select>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Assigning…" : "Assign teacher"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Section page
// ---------------------------------------------------------------------------

export function SectionTeacherForm({
  sectionId,
  currentTeacherId,
  teachers,
}: {
  sectionId: string;
  currentTeacherId: string | null;
  teachers: StaffChoice[];
}) {
  const [state, formAction, pending] = useActionState(setSectionTeacherAction, initialState);
  const id = useId();
  const choices = teachers.filter((teacher) => teacher.id !== currentTeacherId);
  return (
    <form key={state.attempt ?? 0} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="sectionId" value={sectionId} />
      <Banner state={state} />
      {choices.length === 0 ? (
        <Note>
          There is nobody else to choose. Add a new teacher below, or give an existing member of
          staff a teaching role on the Faculty page.
        </Note>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label={currentTeacherId ? "Change teacher to" : "Assign a teacher"} htmlFor={id}>
              <Select id={id} name="teacherId" required defaultValue="">
                <TeacherOptions teachers={choices} empty="Choose a teacher" />
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : currentTeacherId ? "Change teacher" : "Assign teacher"}
          </Button>
        </div>
      )}
    </form>
  );
}

export function RemoveTeacherButton({
  sectionId,
  teacherName,
}: {
  sectionId: string;
  teacherName: string;
}) {
  const [state, formAction, pending] = useActionState(removeSectionTeacherAction, initialState);
  const [confirming, setConfirming] = useConfirm(true);
  const [returnFocus, setReturnFocus] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      {state.error ? <Banner state={state} /> : null}
      {confirming ? (
        <form
          action={formAction}
          className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3"
        >
          <input type="hidden" name="sectionId" value={sectionId} />
          <p className="text-sm text-amber-900">
            {teacherName} will no longer teach this section. Their account, and any attendance
            they have already taken, stay exactly as they are.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Removing…" : "Remove teacher"}
            </Button>
            {/* Opening lands on the safe choice; keyboard users never start on "Remove". */}
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => {
                setReturnFocus(true);
                setConfirming(false);
              }}
            >
              Keep teacher
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="secondary"
          autoFocus={returnFocus}
          onClick={() => setConfirming(true)}
        >
          Remove teacher
        </Button>
      )}
    </div>
  );
}

function PasswordReveal({ state }: { state: SchoolSetupActionState }) {
  if (!state.password) return null;
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3"
    >
      <p className="text-sm font-medium text-amber-900">{state.passwordLabel}</p>
      <input
        readOnly
        value={state.password}
        aria-label={state.passwordLabel}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900"
      />
      <p className="text-xs text-amber-900">
        Copy it now and give it to the teacher in person — it is shown only once. They will be
        asked to choose their own password when they first sign in. If it is lost, issue a new one
        from the Faculty page.
      </p>
    </div>
  );
}

/**
 * Create a teacher's account and give them this section in one go.
 *
 * Behind a disclosure because it is the less common path — most sections are
 * given to somebody who already has an account — and a four-field form open by
 * default reads as something that has to be filled in.
 */
export function InviteTeacherForm({ sectionId }: { sectionId: string }) {
  const [state, formAction, pending] = useActionState(inviteTeacherForSectionAction, initialState);
  const id = useId();
  const succeeded = Boolean(state.password);
  return (
    <div className="flex flex-col gap-3">
      <PasswordReveal state={state} />
      {succeeded && !state.error ? <Banner state={{ message: state.message }} /> : null}
      <details className="group rounded-md border border-neutral-200 p-3" open={Boolean(state.error)}>
        <summary className="cursor-pointer rounded-sm text-sm font-medium text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900">
          Add a new teacher
        </summary>
        <form
          key={state.attempt ?? 0}
          action={formAction}
          className="mt-3 flex flex-col gap-4"
        >
          <input type="hidden" name="sectionId" value={sectionId} />
          {state.error ? <Banner state={{ error: state.error }} /> : null}
          <Note>
            Creates a teacher account that can take attendance for the sections it is given, and
            gives it this section. The role can be changed later on the Faculty page.
          </Note>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                name="name"
                required
                maxLength={120}
                autoComplete="off"
                defaultValue={state.error ? state.values?.name : undefined}
              />
            </Field>
            <Field label="Work email" htmlFor={`${id}-email`}>
              <Input
                id={`${id}-email`}
                name="email"
                type="email"
                required
                autoComplete="off"
                placeholder="name@school.edu"
                defaultValue={state.error ? state.values?.email : undefined}
              />
            </Field>
            <Field label="Employee code (optional)" htmlFor={`${id}-code`}>
              <Input
                id={`${id}-code`}
                name="employeeCode"
                maxLength={40}
                autoComplete="off"
                defaultValue={state.error ? state.values?.employeeCode : undefined}
              />
            </Field>
          </div>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating account…" : "Create account and assign"}
            </Button>
          </div>
        </form>
      </details>
    </div>
  );
}

export function RenameSectionForm({
  sectionId,
  name,
  sharedAcrossYears,
}: {
  sectionId: string;
  name: string;
  sharedAcrossYears: boolean;
}) {
  const [state, formAction, pending] = useActionState(renameSectionAction, initialState);
  const id = useId();
  return (
    <form key={state.attempt ?? 0} action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="sectionId" value={sectionId} />
      <Banner state={state} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field label="Section name" htmlFor={id}>
            <Input
              id={id}
              name="name"
              required
              maxLength={MAX_SECTION_NAME}
              defaultValue={state.error ? state.values?.name : name}
              autoComplete="off"
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Rename section"}
        </Button>
      </div>
      {sharedAcrossYears ? (
        <Note>Only this year changes. Other years keep the name this section had then.</Note>
      ) : null}
    </form>
  );
}

/**
 * Remove a section — offered only when nothing has happened in it.
 *
 * Asks twice and says exactly what goes: the section, and its teacher
 * assignment. Blocked sections never show the button, only the reasons; the
 * server checks the same reasons again before it removes anything.
 */
export function RemoveSectionControl({
  sectionId,
  yearId,
  sectionName,
  className,
  yearName,
  teacherName,
  lastSection,
}: {
  sectionId: string;
  yearId: string;
  sectionName: string;
  className: string;
  yearName: string;
  teacherName: string | null;
  lastSection: boolean;
}) {
  const [state, formAction, pending] = useActionState(removeSectionAction, initialState);
  const [confirming, setConfirming] = useConfirm(true);
  const [returnFocus, setReturnFocus] = useState(false);
  return (
    <div className="flex flex-col items-start gap-3">
      {state.error ? <Banner state={state} /> : null}
      {confirming ? (
        <form
          action={formAction}
          className="flex w-full flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-3"
        >
          <input type="hidden" name="sectionId" value={sectionId} />
          <input type="hidden" name="yearId" value={yearId} />
          <p className="text-sm text-red-900">
            {sectionLabel(sectionName)} will be removed from {className} for {yearName}.
            {teacherName ? ` ${teacherName} will no longer be assigned to it.` : ""} It has no
            students, attendance or subjects, so nothing else is affected.
            {lastSection
              ? ` It is the only section of ${className} this year, so ${className} will no longer be listed for ${yearName}.`
              : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Removing…" : `Remove ${sectionLabel(sectionName)}`}
            </Button>
            {/* Opening lands on the safe choice; keyboard users never start on "Remove". */}
            <Button
              type="button"
              variant="secondary"
              autoFocus
              onClick={() => {
                setReturnFocus(true);
                setConfirming(false);
              }}
            >
              Keep section
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="secondary"
          autoFocus={returnFocus}
          onClick={() => setConfirming(true)}
        >
          Remove section
        </Button>
      )}
    </div>
  );
}
