"use client";

import { useActionState, useState } from "react";
import {
  assignClassTeacherAction,
  removeClassTeacherAction,
  setSubjectFacultyAction,
  type FacultyActionState,
} from "@/modules/faculty/directory-actions";
import { attachSubjectAction, type CohortActionState } from "@/modules/cohorts/directory-actions";
import {
  COHORT_FACULTY_ROLE_LABEL,
  type CohortSubjectRow,
  type CohortTeacher,
  type StaffChoice,
  type SubjectChoice,
} from "@/modules/cohorts/directory-types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

const facultyInitial: FacultyActionState = {};
const cohortInitial: CohortActionState = {};

function Notice({ state }: { state: { error?: string; message?: string } }) {
  if (state.error) {
    return (
      <p role="alert" className="text-xs text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="text-xs text-green-800">
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * Put somebody in front of this class.
 *
 * The action is `modules/faculty/directory-actions.ts#assignClassTeacherAction`
 * — the same one the faculty screen uses — rather than a second one written for
 * this page. It calls `assignFacultyToCohortForRequest`, which upserts, so
 * picking a person who is already assigned changes their role instead of
 * failing on the unique constraint.
 */
export function AssignTeacherControl({
  cohortId,
  staff,
}: {
  cohortId: string;
  staff: StaffChoice[];
}) {
  const [state, formAction, pending] = useActionState(assignClassTeacherAction, facultyInitial);

  if (staff.length === 0) {
    return (
      <p className="text-sm text-amber-700">
        No active staff accounts yet. Invite somebody under Staff, then come back and assign them.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="cohortId" value={cohortId} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
        <Field label="Person" htmlFor="assign-userId">
          <Select id="assign-userId" name="userId" required defaultValue="">
            <option value="">Choose somebody…</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} — {person.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="As" htmlFor="assign-role">
          <Select id="assign-role" name="role" defaultValue="PRIMARY">
            <option value="PRIMARY">{COHORT_FACULTY_ROLE_LABEL.PRIMARY}</option>
            <option value="ASSISTANT">{COHORT_FACULTY_ROLE_LABEL.ASSISTANT}</option>
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Assigning…" : "Assign"}
        </Button>
      </div>
      <Notice state={state} />
    </form>
  );
}

/**
 * Take somebody off this class.
 *
 * Asks twice, and the confirmation carries the one sentence that matters: this
 * removes the assignment going forward and takes nothing away from the
 * registers they already took. Somebody reading "remove" on a staff row has no
 * way of knowing that without being told.
 */
export function RemoveTeacherControl({
  teacher,
  cohortName,
}: {
  teacher: CohortTeacher;
  cohortName: string;
}) {
  const [state, formAction, pending] = useActionState(removeClassTeacherAction, facultyInitial);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-start gap-1.5">
      {confirming ? (
        <form action={formAction} className="flex flex-col items-start gap-1.5">
          <input type="hidden" name="linkId" value={teacher.linkId} />
          <p className="max-w-xs text-xs text-neutral-600">
            {teacher.name} stops being listed for {cohortName} and will not be able to open new
            registers for it. Every register they have already taken, and every correction they
            made, is kept.
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Removing…" : "Remove"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      )}
      <Notice state={state} />
    </div>
  );
}

/**
 * Offer a subject to this section, and optionally say who teaches it.
 *
 * Subjects already offered are left out of the dropdown rather than shown and
 * refused — the service refuses them anyway, but a list you cannot pick the
 * wrong thing from is better than a message explaining that you did.
 */
export function AttachSubjectControl({
  cohortId,
  subjects,
  staff,
  attached,
}: {
  cohortId: string;
  subjects: SubjectChoice[];
  staff: StaffChoice[];
  attached: CohortSubjectRow[];
}) {
  const [state, formAction, pending] = useActionState(attachSubjectAction, cohortInitial);

  const taken = new Set(attached.map((offering) => offering.subjectId));
  const available = subjects.filter((subject) => !taken.has(subject.id));

  if (subjects.length === 0) {
    return (
      <p className="text-sm text-amber-700">
        No subjects exist yet. Add them under Subjects, then offer them to this section.
      </p>
    );
  }

  if (available.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Every subject in the institution is already offered to this section.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="cohortId" value={cohortId} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <Field label="Subject" htmlFor="attach-subjectId">
          <Select id="attach-subjectId" name="subjectId" required defaultValue="">
            <option value="">Choose a subject…</option>
            {available.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.code} — {subject.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Taught by (optional)" htmlFor="attach-facultyId">
          <Select id="attach-facultyId" name="facultyId" defaultValue="">
            <option value="">Decide later</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add subject"}
        </Button>
      </div>
      <Notice state={state} />
    </form>
  );
}

/**
 * Who teaches one subject in this section.
 *
 * Its own action state per row, so that on a section offering eight subjects a
 * refusal appears against the subject it belongs to rather than at the top of
 * the page where it could be read as belonging to any of them.
 *
 * Clearing it is allowed and is not a destructive action worth confirming — it
 * removes nobody's history, it only means no register can be opened for that
 * subject until somebody is named. The message says so.
 */
export function SubjectFacultyControl({
  offering,
  staff,
}: {
  offering: CohortSubjectRow;
  staff: StaffChoice[];
}) {
  const [state, formAction, pending] = useActionState(setSubjectFacultyAction, facultyInitial);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1.5">
      <input type="hidden" name="cohortSubjectId" value={offering.cohortSubjectId} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`faculty-${offering.cohortSubjectId}`}>
          Who teaches {offering.code}
        </label>
        <Select
          id={`faculty-${offering.cohortSubjectId}`}
          name="facultyId"
          defaultValue={offering.facultyId ?? ""}
          className="min-w-[12rem]"
        >
          <option value="">Nobody yet</option>
          {staff.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <Notice state={state} />
    </form>
  );
}
