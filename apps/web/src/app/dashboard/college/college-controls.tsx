"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  addSectionsAction,
  addStudentToSectionAction,
  addStudentsToSectionAction,
  assignHeadAction,
  createCourseAction,
  createDepartmentAction,
  createHeadAction,
  createSemesterAction,
  inviteSectionTeacherAction,
  removeCourseAction,
  removeHeadAction,
  removeSectionAction,
  removeSectionTeacherAction,
  removeSemesterAction,
  removeStudentFromSectionAction,
  renameSectionAction,
  resetHeadPasswordAction,
  setCurrentSemesterAction,
  setHeadActiveAction,
  setSectionTeacherAction,
  updateCourseAction,
  updateDepartmentAction,
  updateSemesterAction,
  type CollegeActionState,
} from "@/modules/college-setup/actions";
import { nextSectionNames } from "@/modules/college-setup/policy";
import {
  MAX_COURSE_CODE,
  MAX_COURSE_NAME,
  MAX_DEPARTMENT_CODE,
  MAX_DEPARTMENT_NAME,
  MAX_SECTIONS,
  MAX_SECTION_NAME,
  MAX_SEMESTER_NAME,
  MAX_SEMESTER_NUMBER,
  type SectionTeacher,
  type StaffChoice,
} from "@/modules/college-setup/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const initialState: CollegeActionState = {};

/**
 * Controls for the college setup screens.
 *
 * Each control holds its own action state, as on the school Classes screens:
 * a refusal belongs next to the thing that was refused. Every id travels as a
 * hidden field the server checks again — through its parents, against the
 * signed-in person's department — before it touches anything.
 */

type Ids = Record<string, string>;

function Hidden({ ids }: { ids: Ids }) {
  return (
    <>
      {Object.entries(ids).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function Feedback({ state }: { state: CollegeActionState }) {
  return (
    <>
      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {state.message}
        </p>
      ) : null}
      {state.details && state.details.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-neutral-700">
          {state.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {state.password ? <PasswordOnce label={state.passwordLabel ?? "Temporary password"} password={state.password} /> : null}
    </>
  );
}

/**
 * A temporary password, shown once. It came back in this form's action state
 * and lives nowhere else: reloading the page does not bring it back, and there
 * is no screen that can show the current one.
 */
function PasswordOnce({ label, password }: { label: string; password: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  if (dismissed) return null;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-3">
      <p className="text-sm font-medium text-emerald-900">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded border border-emerald-200 bg-white px-2 py-1.5 font-mono text-sm text-neutral-900">
          {password}
        </code>
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy password"}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied ? "Password copied" : ""}
        </span>
      </div>
      <p className="text-xs text-emerald-900">
        Copy this now — it is shown once and cannot be recovered. Hand it over in person or by a channel you trust.
        They can choose their own password under My account once signed in.
      </p>
      <div>
        <Button type="button" variant="secondary" onClick={() => setDismissed(true)}>
          Done
        </Button>
      </div>
    </div>
  );
}

function TeacherOptions({ teachers, empty }: { teachers: readonly StaffChoice[]; empty: string }) {
  const inDepartment = teachers.filter((teacher) => teacher.inDepartment);
  const others = teachers.filter((teacher) => !teacher.inDepartment);
  const option = (teacher: StaffChoice) => (
    <option key={teacher.id} value={teacher.id}>
      {teacher.name} ({teacher.email})
    </option>
  );
  return (
    <>
      <option value="">{empty}</option>
      {inDepartment.length > 0 && others.length > 0 ? (
        <>
          <optgroup label="In this department">{inDepartment.map(option)}</optgroup>
          <optgroup label="Other staff">{others.map(option)}</optgroup>
        </>
      ) : (
        teachers.map(option)
      )}
    </>
  );
}

/**
 * A destructive button that asks once more, in place, before it submits.
 *
 * Opening the question moves focus to Cancel — the safe answer — so a
 * keyboard user lands on it rather than behind it; Escape and Cancel close it
 * and put focus back on the button that opened it.
 */
function ConfirmForm({
  action,
  ids,
  label,
  confirmLabel,
  question,
  pendingLabel,
  variant = "danger",
  labelDetail,
}: {
  action: (state: CollegeActionState, formData: FormData) => Promise<CollegeActionState>;
  ids: Ids;
  label: string;
  confirmLabel: string;
  question: string;
  pendingLabel: string;
  variant?: "danger" | "secondary";
  /** Read out after the label, for a button repeated down a list: "Remove from section (Aman Kumar)". */
  labelDetail?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [confirming, setConfirming] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const questionId = useId();
  // A finished action closes the confirmation, leaving its result on screen.
  // Without this, Disable and Enable — one control, swapped in place when the
  // page refreshes — would show Enable already half-confirmed.
  const [settled, setSettled] = useState(state.attempt);
  if (state.attempt !== settled) {
    setSettled(state.attempt);
    if (!state.error) setConfirming(false);
  }
  useEffect(() => {
    const target = confirming ? "[data-confirm-cancel]" : refocus ? "[data-confirm-open]" : null;
    if (target) box.current?.querySelector<HTMLElement>(target)?.focus();
  }, [confirming, refocus]);
  const close = () => {
    setConfirming(false);
    setRefocus(true);
  };
  return (
    <div ref={box} className="flex flex-col gap-2">
      {confirming ? (
        <form
          action={formAction}
          role="group"
          aria-labelledby={questionId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          className="flex flex-col gap-3 rounded-md border border-red-200 bg-red-50 p-3"
        >
          <Hidden ids={ids} />
          <p id={questionId} className="text-sm text-neutral-800">
            {question}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant={variant} disabled={pending}>
              {pending ? pendingLabel : confirmLabel}
            </Button>
            <Button type="button" variant="secondary" data-confirm-cancel="" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button
            type="button"
            variant="secondary"
            data-confirm-open=""
            onClick={() => {
              setRefocus(false);
              setConfirming(true);
            }}
          >
            {label}
            {labelDetail ? <span className="sr-only"> ({labelDetail})</span> : null}
          </Button>
        </div>
      )}
      <Feedback state={state} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export function NewDepartmentForm() {
  const [state, formAction, pending] = useActionState(createDepartmentAction, initialState);
  const key = state.attempt ?? 0;
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
        <Field label="Department name" htmlFor="department-name">
          <Input
            key={`name-${key}`}
            id="department-name"
            name="name"
            required
            maxLength={MAX_DEPARTMENT_NAME}
            placeholder="Computer Science"
            defaultValue={state.values?.name ?? ""}
            autoComplete="off"
          />
        </Field>
        <Field label="Code" htmlFor="department-code">
          <Input
            key={`code-${key}`}
            id="department-code"
            name="code"
            required
            maxLength={MAX_DEPARTMENT_CODE}
            placeholder="CSE"
            defaultValue={state.values?.code ?? ""}
            autoComplete="off"
            className="uppercase"
          />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add department"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function EditDepartmentForm({ departmentId, name, code }: { departmentId: string; name: string; code: string }) {
  const [state, formAction, pending] = useActionState(updateDepartmentAction, initialState);
  const key = state.attempt ?? 0;
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden ids={{ departmentId }} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
        <Field label="Department name" htmlFor="edit-department-name">
          <Input
            key={`name-${key}`}
            id="edit-department-name"
            name="name"
            required
            maxLength={MAX_DEPARTMENT_NAME}
            defaultValue={state.values?.name ?? name}
          />
        </Field>
        <Field label="Code" htmlFor="edit-department-code">
          <Input
            key={`code-${key}`}
            id="edit-department-code"
            name="code"
            required
            maxLength={MAX_DEPARTMENT_CODE}
            defaultValue={state.values?.code ?? code}
            className="uppercase"
          />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save department"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Head of department
// ---------------------------------------------------------------------------

/**
 * Everything an administrator does about a department's head, in one place
 * that stays mounted while the department page refreshes around it.
 *
 * It has to: creating a head's account changes the panel from "no head yet"
 * to the head's details, and a form that lived only in the first of those
 * would be unmounted by the refresh — taking the one-time password with it
 * before anyone could read it. So the action states live here, and the
 * password is shown above whichever layout applies.
 */
export function HeadControls({
  departmentId,
  hasHead,
  headId,
  headActive,
  candidates,
}: {
  departmentId: string;
  hasHead: boolean;
  headId: string | null;
  headActive: boolean;
  candidates: readonly StaffChoice[];
}) {
  const [assignState, assignAction, assigning] = useActionState(assignHeadAction, initialState);
  const [createState, createAction, creating] = useActionState(createHeadAction, initialState);
  const others = candidates.filter((person) => person.id !== headId);

  return (
    <div className="flex flex-col gap-4">
      <Feedback state={createState} />
      <Feedback state={assignState} />
      {hasHead ? (
        <>
          <p className="text-xs text-neutral-500">
            A password is never shown again after it is issued. Reset password issues a new temporary one, once.
          </p>
          <HeadAccountActions departmentId={departmentId} active={headActive} />
          <details className="rounded-md border border-neutral-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-neutral-900">Choose a different head</summary>
            <div className="mt-3">
              <AssignHeadFields
                departmentId={departmentId}
                candidates={others}
                action={assignAction}
                pending={assigning}
                label="Make head instead"
              />
            </div>
          </details>
        </>
      ) : (
        <>
          <AssignHeadFields departmentId={departmentId} candidates={candidates} action={assignAction} pending={assigning} />
          <details className="rounded-md border border-neutral-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-neutral-900">
              Or create a new account for the head
            </summary>
            <div className="mt-3">
              <CreateHeadFields departmentId={departmentId} action={createAction} pending={creating} state={createState} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function AssignHeadFields({
  departmentId,
  candidates,
  action,
  pending,
  label = "Make head of department",
}: {
  departmentId: string;
  candidates: readonly StaffChoice[];
  action: (formData: FormData) => void;
  pending: boolean;
  label?: string;
}) {
  const id = useId();
  if (candidates.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        Nobody on the teaching staff can be chosen yet. Create a new account for the head, or add staff on the Faculty
        page first.
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <Hidden ids={{ departmentId }} />
      <Field label="Choose a member of staff" htmlFor={`${id}-head`}>
        <Select id={`${id}-head`} name="userId" required defaultValue="">
          <TeacherOptions teachers={candidates} empty="Choose…" />
        </Select>
      </Field>
      <p className="text-xs text-neutral-500">
        They keep their login and password. Their teaching role becomes Head of Department: they can still teach and
        take attendance, and can manage this department — and only this one.
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : label}
        </Button>
      </div>
    </form>
  );
}

function CreateHeadFields({
  departmentId,
  action,
  pending,
  state,
}: {
  departmentId: string;
  action: (formData: FormData) => void;
  pending: boolean;
  state: CollegeActionState;
}) {
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3">
      <Hidden ids={{ departmentId }} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor={`${id}-name`}>
          <Input key={`name-${key}`} id={`${id}-name`} name="name" required defaultValue={state.values?.name ?? ""} />
        </Field>
        <Field label="Work email (their login)" htmlFor={`${id}-email`}>
          <Input
            key={`email-${key}`}
            id={`${id}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            defaultValue={state.values?.email ?? ""}
          />
        </Field>
        <Field label="Employee code (optional)" htmlFor={`${id}-code`}>
          <Input key={`code-${key}`} id={`${id}-code`} name="employeeCode" defaultValue={state.values?.employeeCode ?? ""} />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create head's account"}
        </Button>
      </div>
    </form>
  );
}

/** Reset password, stop or restore sign-in, and step down — for the department's head. */
export function HeadAccountActions({ departmentId, active }: { departmentId: string; active: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ConfirmForm
        action={resetHeadPasswordAction}
        ids={{ departmentId }}
        label="Reset password"
        confirmLabel="Issue new password"
        question="The current password stops working and every device is signed out."
        pendingLabel="Issuing…"
        variant="secondary"
      />
      {active ? (
        <ConfirmForm
          action={setHeadActiveAction}
          ids={{ departmentId, active: "0" }}
          label="Disable account"
          confirmLabel="Disable account"
          question="They can't sign in until the account is enabled again."
          pendingLabel="Disabling…"
        />
      ) : (
        <ConfirmForm
          action={setHeadActiveAction}
          ids={{ departmentId, active: "1" }}
          label="Enable account"
          confirmLabel="Enable account"
          question="They can sign in again with their current password."
          pendingLabel="Enabling…"
          variant="secondary"
        />
      )}
      <ConfirmForm
        action={removeHeadAction}
        ids={{ departmentId }}
        label="Remove as head"
        confirmLabel="Remove as head"
        question="They stay on the staff with an ordinary teaching role."
        pendingLabel="Removing…"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------

export function NewSemesterForm({ departmentId, suggestedNumber }: { departmentId: string; suggestedNumber: number }) {
  const [state, formAction, pending] = useActionState(createSemesterAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden ids={{ departmentId }} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
        <Field label="Semester number" htmlFor={`${id}-number`}>
          <Input
            key={`number-${key}-${suggestedNumber}`}
            id={`${id}-number`}
            name="number"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SEMESTER_NUMBER}
            required
            defaultValue={state.values?.number ?? String(Math.min(suggestedNumber, MAX_SEMESTER_NUMBER))}
          />
        </Field>
        <Field label="Name (optional)" htmlFor={`${id}-name`}>
          <Input
            key={`name-${key}`}
            id={`${id}-name`}
            name="name"
            maxLength={MAX_SEMESTER_NAME}
            placeholder="Named from the number if left empty"
            defaultValue={state.values?.name ?? ""}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add semester"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function EditSemesterForm({
  departmentId,
  semesterId,
  number,
  name,
}: {
  departmentId: string;
  semesterId: string;
  number: number;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(updateSemesterAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden ids={{ departmentId, semesterId }} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)]">
        <Field label="Semester number" htmlFor={`${id}-number`}>
          <Input
            key={`number-${key}`}
            id={`${id}-number`}
            name="number"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_SEMESTER_NUMBER}
            required
            defaultValue={state.values?.number ?? String(number)}
          />
        </Field>
        <Field label="Name" htmlFor={`${id}-name`}>
          <Input
            key={`name-${key}`}
            id={`${id}-name`}
            name="name"
            maxLength={MAX_SEMESTER_NAME}
            defaultValue={state.values?.name ?? name}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save semester"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function CurrentSemesterButton({
  departmentId,
  semesterId,
  isCurrent,
}: {
  departmentId: string;
  semesterId: string;
  isCurrent: boolean;
}) {
  const [state, formAction, pending] = useActionState(setCurrentSemesterAction, initialState);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Hidden ids={{ departmentId, semesterId: isCurrent ? "" : semesterId }} />
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : isCurrent ? "Unmark current" : "Make current semester"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveSemesterButton({ departmentId, semesterId }: { departmentId: string; semesterId: string }) {
  return (
    <ConfirmForm
      action={removeSemesterAction}
      ids={{ departmentId, semesterId }}
      label="Remove semester"
      confirmLabel="Remove semester"
      question="Only a semester with no courses can be removed."
      pendingLabel="Removing…"
    />
  );
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

export function NewCourseForm({
  departmentId,
  semesterId,
  sessionId,
}: {
  departmentId: string;
  semesterId: string;
  sessionId: string;
}) {
  const [state, formAction, pending] = useActionState(createCourseAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden ids={{ departmentId, semesterId, sessionId }} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <Field label="Course code" htmlFor={`${id}-code`}>
          <Input
            key={`code-${key}`}
            id={`${id}-code`}
            name="code"
            required
            maxLength={MAX_COURSE_CODE}
            placeholder="PHY401"
            defaultValue={state.values?.code ?? ""}
            autoComplete="off"
            className="uppercase"
          />
        </Field>
        <Field label="Course name" htmlFor={`${id}-name`}>
          <Input
            key={`name-${key}`}
            id={`${id}-name`}
            name="name"
            required
            maxLength={MAX_COURSE_NAME}
            placeholder="Physics"
            defaultValue={state.values?.name ?? ""}
          />
        </Field>
      </div>
      <p className="text-xs text-neutral-500">
        The code is what registers and the student portal show. Codes are unique across the college.
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add course"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * A course added from the Courses page: its name, its code and which of the
 * department's semesters it belongs to — the current one unless another is
 * chosen. Only the semester travels; the server finds its department and
 * checks it is the head's own.
 */
export function AddCourseForm({
  semesters,
  defaultSemesterId,
  sessionId,
}: {
  semesters: readonly { id: string; name: string; isCurrent: boolean }[];
  defaultSemesterId: string | null;
  sessionId: string;
}) {
  const [state, formAction, pending] = useActionState(createCourseAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Hidden ids={{ sessionId }} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,12rem)]">
        <Field label="Course name" htmlFor={`${id}-name`}>
          <Input
            key={`name-${key}`}
            id={`${id}-name`}
            name="name"
            required
            maxLength={MAX_COURSE_NAME}
            placeholder="Physics"
            defaultValue={state.values?.name ?? ""}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <Field label="Course code" htmlFor={`${id}-code`}>
          <Input
            key={`code-${key}`}
            id={`${id}-code`}
            name="code"
            required
            maxLength={MAX_COURSE_CODE}
            placeholder="PHY401"
            defaultValue={state.values?.code ?? ""}
            autoComplete="off"
            className="uppercase"
          />
        </Field>
        <Field label="Semester" htmlFor={`${id}-semester`}>
          <Select
            key={`semester-${key}`}
            id={`${id}-semester`}
            name="semesterId"
            required
            defaultValue={state.values?.semesterId ?? defaultSemesterId ?? ""}
          >
            {defaultSemesterId ? null : <option value="">Choose…</option>}
            {semesters.map((semester) => (
              <option key={semester.id} value={semester.id}>
                {semester.name}
                {semester.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-neutral-500">
        The code is what registers and the student portal show. Codes are unique across the college.
      </p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create course"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function EditCourseForm({
  ids,
  code,
  name,
  sessionId,
}: {
  ids: { departmentId: string; semesterId: string; courseId: string };
  code: string;
  name: string;
  sessionId: string;
}) {
  const [state, formAction, pending] = useActionState(updateCourseAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden ids={{ ...ids, sessionId }} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <Field label="Course code" htmlFor={`${id}-code`}>
          <Input
            key={`code-${key}`}
            id={`${id}-code`}
            name="code"
            required
            maxLength={MAX_COURSE_CODE}
            defaultValue={state.values?.code ?? code}
            className="uppercase"
          />
        </Field>
        <Field label="Course name" htmlFor={`${id}-name`}>
          <Input
            key={`name-${key}`}
            id={`${id}-name`}
            name="name"
            required
            maxLength={MAX_COURSE_NAME}
            defaultValue={state.values?.name ?? name}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save course"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveCourseButton({ ids }: { ids: { departmentId: string; semesterId: string; courseId: string } }) {
  return (
    <ConfirmForm
      action={removeCourseAction}
      ids={ids}
      label="Remove course"
      confirmLabel="Remove course"
      question="Only a course that has never had a section can be removed."
      pendingLabel="Removing…"
    />
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Adds one section to a course for the session: its name — the next free
 * letter, which anyone can type over — and, optionally, its teacher. The form
 * stays open and suggests the next letter, so A, B and C are three quick
 * submissions.
 */
export function AddSectionForm({
  ids,
  sessionId,
  courseLabel,
  existingNames,
  teachers,
  noTeachersHint,
}: {
  ids: { departmentId: string; semesterId: string; courseId: string };
  sessionId: string;
  /** "Physics (PHY401)". */
  courseLabel: string;
  existingNames: readonly string[];
  teachers: readonly StaffChoice[];
  noTeachersHint: string;
}) {
  const [state, formAction, pending] = useActionState(addSectionsAction, initialState);
  const [suggested = ""] = nextSectionNames(existingNames, 1);
  const id = useId();
  const key = `${state.attempt ?? 0}-${suggested}`;
  const retry = state.error ? state.values : undefined;

  if (existingNames.length >= MAX_SECTIONS) {
    return <p className="text-sm text-neutral-600">This course already has the most sections a course can have in a session.</p>;
  }
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Hidden ids={{ ...ids, sessionId }} />
      <p className="text-sm text-neutral-600">
        Course: <span className="font-medium text-neutral-900">{courseLabel}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <Field label="Section name" htmlFor={`${id}-name`}>
          <Input
            key={`name-${key}`}
            id={`${id}-name`}
            name="sectionName"
            required
            maxLength={MAX_SECTION_NAME}
            defaultValue={retry?.sectionName ?? suggested}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <Field label="Teacher" htmlFor={`${id}-teacher`}>
          <Select key={`teacher-${key}`} id={`${id}-teacher`} name="teacherId" defaultValue={retry?.teacherId ?? ""}>
            <TeacherOptions teachers={teachers} empty="Assign later" />
          </Select>
        </Field>
      </div>
      {teachers.length === 0 ? <p className="text-xs text-neutral-500">{noTeachersHint}</p> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create section"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

type SectionIds = { departmentId: string; semesterId: string; courseId: string; sectionId: string };

/** Choose or change the section's teacher. */
export function SectionTeacherForm({
  ids,
  teachers,
  currentId,
  compact = false,
}: {
  ids: SectionIds;
  teachers: readonly StaffChoice[];
  currentId: string | null;
  compact?: boolean;
}) {
  const [state, formAction, pending] = useActionState(setSectionTeacherAction, initialState);
  const id = useId();
  const choices = teachers.filter((teacher) => teacher.id !== currentId);
  if (choices.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        {currentId ? "Nobody else can be given this section." : "No teacher can be given this section yet."}
      </p>
    );
  }
  return (
    <form action={formAction} className={compact ? "flex flex-wrap items-end gap-2" : "flex flex-col gap-2"}>
      <Hidden ids={ids} />
      <Field label={currentId ? "Change teacher" : "Assign a teacher"} htmlFor={`${id}-teacher`}>
        <Select id={`${id}-teacher`} name="teacherId" required defaultValue="">
          <TeacherOptions teachers={choices} empty="Choose…" />
        </Select>
      </Field>
      <div>
        <Button type="submit" variant={currentId ? "secondary" : "primary"} disabled={pending}>
          {pending ? "Saving…" : currentId ? "Change teacher" : "Assign teacher"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * The section's teacher, with the way to change it: "Change teacher" (or
 * "Assign teacher", for a section that needs one) opens the choice in place,
 * and focus moves to it. The list holds only the teachers the viewer may
 * give the section to — for a head of department, their own department's.
 */
export function TeacherEditor({
  ids,
  teachers,
  current,
  canInvite = false,
  compact = false,
}: {
  ids: SectionIds;
  teachers: readonly StaffChoice[];
  current: SectionTeacher | null;
  /** An administrator may also create a new teacher's account from here. */
  canInvite?: boolean;
  /**
   * On a course's section card: only "Assign teacher", for a section that
   * needs one, and the choice alone — no removal, no new account. The card
   * keeps it mounted once a teacher is set, so the confirmation stays on
   * screen until it is closed.
   */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = open ? "select" : refocus ? "[data-teacher-open]" : null;
    if (target) box.current?.querySelector<HTMLElement>(target)?.focus();
  }, [open, refocus]);
  const openLabel = current ? "Change teacher" : "Assign teacher";
  if (compact && current && !open) return null;

  return (
    <div ref={box}>
      {open ? (
        <div className="flex flex-col gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <SectionTeacherForm ids={ids} teachers={teachers} currentId={current?.userId ?? null} />
          {!compact && current ? <RemoveSectionTeacherButton ids={ids} /> : null}
          {!compact && canInvite ? (
            <details className="rounded-md border border-neutral-200 bg-white p-3">
              <summary className="cursor-pointer text-sm font-medium text-neutral-900">
                Or create a new teacher&apos;s account for this section
              </summary>
              <div className="mt-3">
                <InviteSectionTeacherForm ids={ids} />
              </div>
            </details>
          ) : null}
          <div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                setRefocus(true);
              }}
            >
              Close
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant={current ? "secondary" : "primary"}
          data-teacher-open=""
          onClick={() => {
            setRefocus(false);
            setOpen(true);
          }}
        >
          {openLabel}
        </Button>
      )}
    </div>
  );
}

export function RemoveSectionTeacherButton({ ids }: { ids: SectionIds }) {
  return (
    <ConfirmForm
      action={removeSectionTeacherAction}
      ids={ids}
      label="Remove teacher"
      confirmLabel="Remove teacher"
      question="Attendance for this section can't be taken until a teacher is assigned."
      pendingLabel="Removing…"
    />
  );
}

export function InviteSectionTeacherForm({ ids }: { ids: SectionIds }) {
  const [state, formAction, pending] = useActionState(inviteSectionTeacherAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Hidden ids={ids} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor={`${id}-name`}>
          <Input key={`name-${key}`} id={`${id}-name`} name="name" required defaultValue={state.values?.name ?? ""} />
        </Field>
        <Field label="Work email (their login)" htmlFor={`${id}-email`}>
          <Input
            key={`email-${key}`}
            id={`${id}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            defaultValue={state.values?.email ?? ""}
          />
        </Field>
        <Field label="Employee code (optional)" htmlFor={`${id}-code`}>
          <Input key={`code-${key}`} id={`${id}-code`} name="employeeCode" defaultValue={state.values?.employeeCode ?? ""} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Creating…" : "Create account and assign"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function RenameSectionForm({ ids, name }: { ids: SectionIds; name: string }) {
  const [state, formAction, pending] = useActionState(renameSectionAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <Hidden ids={ids} />
      <Field label="Section name" htmlFor={`${id}-name`}>
        <Input
          key={`name-${key}`}
          id={`${id}-name`}
          name="name"
          required
          maxLength={MAX_SECTION_NAME}
          defaultValue={state.values?.name ?? name}
          className="sm:max-w-40"
        />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Rename"}
      </Button>
      <div className="w-full">
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function RemoveSectionButton({ ids }: { ids: SectionIds }) {
  return (
    <ConfirmForm
      action={removeSectionAction}
      ids={ids}
      label="Remove section"
      confirmLabel="Remove section"
      question="Its course link and teacher are removed with it."
      pendingLabel="Removing…"
    />
  );
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

/** Several existing students at once, by their student IDs — for a class list pasted in. */
export function AddStudentsByIdForm({ ids }: { ids: SectionIds }) {
  const [state, formAction, pending] = useActionState(addStudentsToSectionAction, initialState);
  const key = state.attempt ?? 0;
  const id = useId();
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Hidden ids={ids} />
      <Field label="Student IDs" htmlFor={`${id}-codes`}>
        <Input
          key={`codes-${key}`}
          id={`${id}-codes`}
          name="studentCodes"
          required
          autoComplete="off"
          placeholder="e.g. CSE2601, CSE2602"
          defaultValue={state.values?.studentCodes ?? ""}
        />
      </Field>
      <p className="text-xs text-neutral-500">
        Separate several IDs with commas or spaces. A student can be in sections of several courses.
      </p>
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Adding…" : "Add these students"}
        </Button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

/**
 * "Add to section" on one search result. The page it posts from comes back
 * with the student marked as in the section, so only a refusal is shown here.
 */
export function AddToSectionButton({
  ids,
  studentId,
  name,
  query,
}: {
  ids: SectionIds;
  studentId: string;
  name: string;
  /** The search, kept so the results are still there afterwards. */
  query: string;
}) {
  const [state, formAction, pending] = useActionState(addStudentToSectionAction, initialState);
  return (
    <form action={formAction} className="flex flex-col items-start gap-2 sm:items-end">
      <Hidden ids={{ ...ids, studentId, q: query }} />
      <Button type="submit" disabled={pending}>
        {pending ? (
          "Adding…"
        ) : (
          <>
            Add to section<span className="sr-only"> ({name})</span>
          </>
        )}
      </Button>
      {state.error ? (
        <p role="alert" className="max-w-xs text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Takes a student out of this section, after asking. Only their place here
 * ends: the student, their login, their face and every register they are on
 * stay, and so do their other courses' sections.
 */
export function RemoveStudentButton({
  ids,
  studentId,
  name,
  sectionName,
}: {
  ids: SectionIds;
  studentId: string;
  name: string;
  /** "Physics — Section A". */
  sectionName: string;
}) {
  return (
    <ConfirmForm
      action={removeStudentFromSectionAction}
      ids={{ ...ids, studentId }}
      label="Remove from section"
      labelDetail={name}
      confirmLabel="Remove from section"
      question={`Remove ${name} from ${sectionName}? Only their place in this section ends — the student, their face enrolment, their attendance history and their other courses are all kept.`}
      pendingLabel="Removing…"
    />
  );
}
