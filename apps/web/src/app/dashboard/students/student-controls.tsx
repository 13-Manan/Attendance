"use client";

import { useActionState, useState } from "react";
import {
  assignStudentClassAction,
  removeStudentClassAction,
  setStudentStatusAction,
  type StudentActionState,
} from "@/modules/students/directory-actions";
import {
  STUDENT_STATUS_DESCRIPTION,
  STUDENT_STATUS_LABEL,
  type CohortChoice,
  type StudentClassLink,
  type StudentDetail,
} from "@/modules/students/directory-types";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/use-confirm";

const initialState: StudentActionState = {};

/** The three ways of not being on roll, for the confirmation step. */
const LEAVING_STATUSES = ["INACTIVE", "TRANSFERRED", "COMPLETED"] as const;

function Feedback({ state }: { state: StudentActionState }) {
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
 * Take a student off roll, or bring one back.
 *
 * ## Why archiving asks twice, and asks what kind
 *
 * It is the destructive-looking control on this screen, and the confirmation
 * step carries the sentence that matters: nothing is deleted. It also asks
 * which kind of leaving this is, because "left for another school" and
 * "finished the course" are different facts that a single Archive button would
 * flatten into one — and the register a year from now is read by somebody who
 * needs the difference.
 *
 * Bringing a student back is a single click. It is reversible, it takes
 * nothing away, and asking somebody to confirm an undo teaches them to click
 * through dialogs. The confirmation is scoped to the student being on roll, so
 * bringing them back does not bring the leaving question with it — see
 * `useConfirm`.
 */
export function StudentStatusControl({ student }: { student: StudentDetail }) {
  const [state, formAction, pending] = useActionState(setStudentStatusAction, initialState);
  const [confirming, setConfirming] = useConfirm(student.status === "ACTIVE");

  const placements =
    student.classes.length === 0
      ? "They are not in any class."
      : `They are in ${student.classes.map((link) => link.cohortName).join(", ")}.`;

  if (student.status !== "ACTIVE") {
    return (
      <div className="flex flex-col items-start gap-2">
        <form action={formAction}>
          <input type="hidden" name="id" value={student.id} />
          <input type="hidden" name="status" value="ACTIVE" />
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Restoring…" : "Bring back on roll"}
          </Button>
        </form>
        <p className="max-w-md text-xs text-neutral-500">
          {STUDENT_STATUS_DESCRIPTION[student.status]}
        </p>
        <Feedback state={state} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {confirming ? (
        <form action={formAction} className="flex max-w-md flex-col items-start gap-2">
          <input type="hidden" name="id" value={student.id} />
          <p className="text-xs text-neutral-600">
            {placements} Taking them off roll keeps every register they appear in and every mark
            already recorded — it stops them being listed for new ones. You can bring them back.
          </p>
          <label className="flex w-full flex-col gap-1 text-xs font-medium text-neutral-600">
            Why are they leaving?
            <Select name="status" defaultValue="INACTIVE" className="px-2.5 py-1.5">
              {LEAVING_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STUDENT_STATUS_LABEL[status]}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Taking off roll…" : "Take off roll"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
          Take off roll
        </Button>
      )}
      <Feedback state={state} />
    </div>
  );
}

/**
 * Place this student in a class.
 *
 * The dropdown lists every class in the institution with its academic year,
 * current year first, and leaves out the ones they are already in — an option
 * whose only outcome is the refusal "already in that class" is an option that
 * should not be offered.
 */
export function AssignStudentClassControl({
  student,
  cohorts,
}: {
  student: StudentDetail;
  cohorts: CohortChoice[];
}) {
  const [state, formAction, pending] = useActionState(assignStudentClassAction, initialState);
  const taken = new Set(student.classes.map((link) => link.cohortId));
  const available = cohorts.filter((cohort) => !taken.has(cohort.id));

  if (available.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        {cohorts.length === 0
          ? "No classes exist yet. Create one under Academic management first."
          : "They are already in every class this institution has."}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="studentId" value={student.id} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-neutral-600">
          Class
          <Select name="cohortId" defaultValue="" required className="px-2.5 py-1.5">
            <option value="" disabled>
              Choose a class
            </option>
            {available.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name}
                {cohort.termLabel ? ` · ${cohort.termLabel}` : ""} — {cohort.academicSessionName}
                {cohort.academicSessionIsCurrent ? " (current year)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Placing…" : "Place in class"}
        </Button>
      </div>
      {student.status !== "ACTIVE" ? (
        <p className="text-xs text-amber-700">
          This student is not on roll. Placing them in a class does not put them back —
          bring them back on roll as well, or they will not appear on the register.
        </p>
      ) : null}
      <Feedback state={state} />
    </form>
  );
}

/**
 * Take a student out of one class.
 *
 * Two steps, because the sentence matters: the registers already taken in that
 * class still name them, and an administrator who expects a removal to erase
 * the child from a term of attendance should find out here rather than later.
 */
export function RemoveStudentClassControl({
  student,
  link,
}: {
  student: StudentDetail;
  link: StudentClassLink;
}) {
  const [state, formAction, pending] = useActionState(removeStudentClassAction, initialState);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-start gap-1.5">
      {confirming ? (
        <form action={formAction} className="flex max-w-sm flex-col items-start gap-1.5">
          <input type="hidden" name="studentId" value={student.id} />
          <input type="hidden" name="cohortId" value={link.cohortId} />
          <p className="text-xs text-neutral-600">
            Taking them out of {link.cohortName} stops them appearing on its register from now on.
            Every register already taken there still names them, with the marks unchanged.
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Removing…" : "Take out of class"}
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
      <Feedback state={state} />
    </div>
  );
}
