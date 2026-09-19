"use client";

import { useActionState, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import {
  assignClassTeacherAction,
  deactivateFacultyAction,
  inviteFacultyAction,
  reactivateFacultyAction,
  removeClassTeacherAction,
  resetPasswordAction,
  setSubjectFacultyAction,
  updateFacultyAction,
  type FacultyActionState,
} from "@/modules/faculty/directory-actions";
import {
  FACULTY_ROLE_DESCRIPTIONS,
  FACULTY_ROLE_KEYS,
  type AssignableMember,
  type CohortOption,
  type CohortSubjectOption,
  type DepartmentOption,
  type FacultyMember,
} from "@/modules/faculty/directory-types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";

const initialState: FacultyActionState = {};

/**
 * Controls for the faculty screen.
 *
 * Local copies of the small primitives, for the reason recorded in
 * `institutions/settings/retention-form.tsx`: they are a handful of lines, and
 * sharing them would couple screens that must be able to change apart.
 *
 * Every control has its own action state. On a page listing forty teachers, a
 * refusal has to appear on the row it belongs to — a single banner at the top
 * saying "that account is already stopped" is a message about nobody.
 */
function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 ${className}`}
      {...props}
    />
  );
}

function Banner({ state }: { state: FacultyActionState }) {
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

/**
 * One outcome from the stop/restore pair, kept on screen only while it is
 * still true of the row.
 *
 * Each half holds its own action state, and a state outlives the click that
 * produced it. An error always belongs on screen: it explains a row that did
 * not change. A success message belongs there only while the row still matches
 * it — otherwise stopping somebody leaves the green "can sign in again" from
 * the restore before it sitting directly under the word "Stopped".
 */
function stillTrue(state: FacultyActionState, matchesRow: boolean): FacultyActionState {
  if (state.error) return state;
  return matchesRow ? state : {};
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-neutral-500">{children}</p>;
}

/**
 * The temporary password, shown once.
 *
 * Rendered from the action's return value, which came back in the same
 * response as the request that set it. Nothing stored it in a readable form,
 * so there is no "show it again" in this product and the panel says as much
 * rather than letting an administrator navigate away expecting to find it.
 */
function PasswordReveal({ state }: { state: FacultyActionState }) {
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
      <p className="text-xs text-amber-900">{state.passwordNotice}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * The department control, rendered only where departments exist.
 *
 * A school has none, and the field is then absent from the form rather than
 * present and empty — the action reads "absent" as "leave it alone", so a
 * school's edit can never clear a column it was never shown. See
 * `optionalText` in `directory-actions.ts`.
 */
function DepartmentField({
  departments,
  id,
  defaultValue = "",
}: {
  departments: DepartmentOption[];
  id: string;
  defaultValue?: string;
}) {
  if (departments.length === 0) return null;
  return (
    <Field label="Department (optional)" htmlFor={id}>
      <Select id={id} name="departmentId" defaultValue={defaultValue}>
        <option value="">Not recorded</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {department.name}
            {department.code ? ` (${department.code})` : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function InviteFacultyForm({ departments }: { departments: DepartmentOption[] }) {
  const [state, formAction, pending] = useActionState(inviteFacultyAction, initialState);
  const [open, setOpen] = useState(false);

  if (!open && !state.password) {
    return (
      <div className="flex flex-col gap-3">
        <Banner state={state} />
        <div>
          <Button type="button" onClick={() => setOpen(true)}>
            + Add a staff account
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Panel
      title="Add a staff account"
      description="Creates the account and issues a temporary password, shown once on this screen."
      action={
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Banner state={state} />
        <PasswordReveal state={state} />

        <form action={formAction} className="flex max-w-2xl flex-col gap-4">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" required maxLength={120} placeholder="R Sharma" />
          </Field>

          <Field label="Work email" htmlFor="email">
            <Input
              id="email"
              name="email"
              required
              type="email"
              placeholder="r.sharma@example.edu"
            />
          </Field>
          <Note>
            This is what they sign in with, so it has to be an address they can reach. It is stored
            in lower case, and one address can belong to only one account.
          </Note>

          <Field label="Employee code (optional)" htmlFor="employeeCode">
            <Input id="employeeCode" name="employeeCode" maxLength={40} placeholder="T-14" />
          </Field>

          <DepartmentField departments={departments} id="departmentId" />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-neutral-700">What may they do?</legend>
            {FACULTY_ROLE_KEYS.map((key, index) => (
              <label key={key} className="flex items-start gap-2 text-sm text-neutral-700">
                <input
                  type="radio"
                  name="roleKey"
                  value={key}
                  defaultChecked={index === 0}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium text-neutral-900">{key}</span>{" "}
                  {FACULTY_ROLE_DESCRIPTIONS[key]}
                </span>
              </label>
            ))}
          </fieldset>
          <Note>
            Administrator access is not granted here. Promoting someone to run the institution is a
            different decision with a much larger reach, and this screen does not make it by
            accident.
          </Note>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create account"}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}

/**
 * Edit, reset, stop and restore for one person.
 *
 * Three separate actions because they are three separate decisions, and
 * because a hurried "stop this account" should not require getting the name
 * field right first. Stopping asks for confirmation and says what it does and
 * does not erase; that sentence is the whole reason the confirm step exists.
 *
 * Stopping and restoring hold one `useActionState` each rather than sharing
 * one whose action is picked from `member.status`. A row that has just been
 * stopped re-renders in place, and `useActionState` keeps the action it was
 * mounted with: the shared version left "Restore access" wired to the stop
 * action, so the click that was meant to undo the stop came back "that account
 * is already stopped" and the person stayed locked out. Two constant actions
 * cannot drift that way.
 */
export function MemberActions({
  member,
  departments,
}: {
  member: FacultyMember;
  departments: DepartmentOption[];
}) {
  const [editState, editAction, editing] = useActionState(updateFacultyAction, initialState);
  const [resetState, resetAction, resetting] = useActionState(resetPasswordAction, initialState);
  const [stopState, stopAction, stopping] = useActionState(deactivateFacultyAction, initialState);
  const [restoreState, restoreAction, restoring] = useActionState(
    reactivateFacultyAction,
    initialState,
  );
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useConfirm(member.status === "ACTIVE");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </Button>

        <form action={resetAction}>
          <input type="hidden" name="id" value={member.id} />
          <input type="hidden" name="email" value={member.email} />
          <Button type="submit" variant="secondary" disabled={resetting}>
            {resetting ? "Issuing…" : "New password"}
          </Button>
        </form>

        {member.status === "ACTIVE" ? (
          confirming ? null : (
            <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
              Stop access
            </Button>
          )
        ) : (
          <form action={restoreAction}>
            <input type="hidden" name="id" value={member.id} />
            <Button type="submit" disabled={restoring}>
              {restoring ? "Restoring…" : "Restore access"}
            </Button>
          </form>
        )}
      </div>

      {confirming ? (
        <form action={stopAction} className="flex flex-col items-start gap-1.5">
          <input type="hidden" name="id" value={member.id} />
          <p className="text-xs text-neutral-600">
            {member.name} will be signed out now and unable to sign in. The registers they took and
            the corrections they made are kept, and so is their name on them.
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={stopping}>
              {stopping ? "Stopping…" : "Stop access"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <Banner state={stillTrue(stopState, member.status !== "ACTIVE")} />
      <Banner state={stillTrue(restoreState, member.status === "ACTIVE")} />
      <Banner state={resetState} />
      <PasswordReveal state={resetState} />

      {open ? (
        <form action={editAction} className="flex max-w-md flex-col gap-3">
          <Banner state={editState} />
          <input type="hidden" name="id" value={member.id} />
          <Field label="Name" htmlFor={`name-${member.id}`}>
            <Input
              id={`name-${member.id}`}
              name="name"
              required
              maxLength={120}
              defaultValue={member.name}
            />
          </Field>
          <Field label="Employee code" htmlFor={`code-${member.id}`}>
            <Input
              id={`code-${member.id}`}
              name="employeeCode"
              maxLength={40}
              defaultValue={member.employeeCode ?? ""}
            />
          </Field>
          <DepartmentField
            departments={departments}
            id={`department-${member.id}`}
            defaultValue={member.departmentId ?? ""}
          />
          <Note>
            The email address is not editable here. Changing what somebody signs in with is an
            account move, not an edit, and doing it in place would silently break their sessions
            and detach them from their own audit trail.
          </Note>
          <div>
            <Button type="submit" disabled={editing}>
              {editing ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export function AssignClassTeacherForm({
  cohorts,
  members,
}: {
  cohorts: CohortOption[];
  /** Everyone assignable, not the page of the table on screen. */
  members: AssignableMember[];
}) {
  const [state, formAction, pending] = useActionState(assignClassTeacherAction, initialState);
  const active = members.filter((member) => member.status === "ACTIVE");

  if (cohorts.length === 0) {
    return (
      <Note>
        There are no classes yet. Create one under Academic management, then come back to say who
        teaches it.
      </Note>
    );
  }

  if (active.length === 0) {
    // An empty dropdown next to an Assign button is a trap: it looks usable and
    // cannot succeed. Say which half is missing instead.
    return (
      <Note>
        There is nobody to assign. Every staff account is stopped — add one, or restore an existing
        account, and it will appear here.
      </Note>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Banner state={state} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Class" htmlFor="cohortId">
          <Select id="cohortId" name="cohortId" required>
            {cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name}
                {cohort.termLabel ? ` · ${cohort.termLabel}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Teacher" htmlFor="userId">
          <Select id="userId" name="userId" required>
            {active.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="As" htmlFor="role">
          <Select id="role" name="role" defaultValue="PRIMARY">
            <option value="PRIMARY">Class teacher</option>
            <option value="ASSISTANT">Additional teacher</option>
          </Select>
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Assigning…" : "Assign"}
        </Button>
      </div>
    </form>
  );
}

export function RemoveClassLinkButton({ linkId }: { linkId: string }) {
  const [state, formAction, pending] = useActionState(removeClassTeacherAction, initialState);
  if (state.error) {
    return (
      <span role="alert" className="text-xs text-red-700">
        {state.error}
      </span>
    );
  }
  return (
    <form action={formAction}>
      <input type="hidden" name="linkId" value={linkId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-neutral-600 underline underline-offset-4 disabled:text-neutral-400"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
    </form>
  );
}

/**
 * Who teaches one subject in one class.
 *
 * "Nobody yet" is a real option, not an omission: a subject with no teacher is
 * the normal state in the week before term. What it means is that no register
 * can be opened for it, which the page states rather than leaving someone to
 * discover on the first day.
 */
export function SubjectFacultySelect({
  offering,
  members,
}: {
  offering: CohortSubjectOption;
  members: AssignableMember[];
}) {
  const [state, formAction, pending] = useActionState(setSubjectFacultyAction, initialState);
  const active = members.filter(
    (member) => member.status === "ACTIVE" || member.id === offering.facultyId,
  );

  return (
    <form action={formAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="cohortSubjectId" value={offering.cohortSubjectId} />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          name="facultyId"
          defaultValue={offering.facultyId ?? ""}
          aria-label={`Teacher for ${offering.subjectCode} in ${offering.cohortName}`}
          className="max-w-56"
        >
          <option value="">Nobody yet</option>
          {active.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
              {member.status === "ACTIVE" ? "" : " (stopped)"}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <Banner state={state} />
    </form>
  );
}
