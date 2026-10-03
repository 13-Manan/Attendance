"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  declareKnownTwinPairAction,
  withdrawKnownTwinPairAction,
  type KnownTwinFormState,
} from "@/modules/twin-confirmation/actions";
import type { TwinStudentOption } from "@/modules/twin-confirmation/types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/**
 * Marking two students as known twins or lookalikes, and removing the mark.
 *
 * Presentation only. The forms post two student ids, or a pair's key, and —
 * on a department's page — the department; the service decides who may, which
 * students, and records one declaration however often it is asked.
 */

const INITIAL: KnownTwinFormState = { error: null, message: null, done: 0 };

export const KNOWN_PAIR_WARNING =
  "These students will be treated as a known visually similar pair during face enrollment and attendance recognition. This does not allow either student to be automatically marked Present when the system cannot distinguish them.";

const SELECT =
  "min-h-11 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900";

function fullName(student: { firstName: string; lastName: string }): string {
  return `${student.firstName} ${student.lastName}`.trim();
}

function classesOf(student: TwinStudentOption): string {
  return student.classes.length > 0 ? student.classes.join(", ") : "Not in a class";
}

function Messages({ state }: { state: KnownTwinFormState }) {
  return (
    <>
      {state.message ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {state.message}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
    </>
  );
}

/** Students grouped by their first current class, classes in natural order. */
function groupByClass(students: readonly TwinStudentOption[]): Array<{ label: string; students: TwinStudentOption[] }> {
  const groups = new Map<string, TwinStudentOption[]>();
  for (const student of students) {
    const label = student.classes[0] ?? "Not in a class";
    groups.set(label, [...(groups.get(label) ?? []), student]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Not in a class" ? 1 : b === "Not in a class" ? -1 : a.localeCompare(b, "en", { numeric: true })))
    .map(([label, members]) => ({ label, students: members.sort((x, y) => fullName(x).localeCompare(fullName(y))) }));
}

function StudentSelect({
  id,
  label,
  value,
  onChange,
  groups,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  groups: Array<{ label: string; students: TwinStudentOption[] }>;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={SELECT}>
        <option value="">Choose a student…</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.students.map((student) => (
              <option key={student.studentId} value={student.studentId}>
                {fullName(student)} ({student.studentCode})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

function ChosenStudent({ label, student }: { label: string; student: TwinStudentOption }) {
  return (
    <dl className="flex min-w-0 flex-col gap-1 rounded-md border border-neutral-200 bg-white p-3 text-sm">
      <dt className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd className="font-medium text-neutral-900">{fullName(student)}</dd>
      <dd className="text-neutral-700">
        Student ID <span className="font-mono">{student.studentCode}</span>
      </dd>
      <dd className="text-neutral-700">Class / section: {classesOf(student)}</dd>
    </dl>
  );
}

function DeclareSteps({
  students,
  departmentId,
  initialStudentId,
  startOpen,
  formAction,
  pending,
}: {
  students: TwinStudentOption[];
  departmentId: string | null;
  initialStudentId: string | null;
  startOpen: boolean;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  const id = useId();
  const groups = useMemo(() => groupByClass(students), [students]);
  const byId = useMemo(() => new Map(students.map((student) => [student.studentId, student])), [students]);
  const [open, setOpen] = useState(startOpen);
  const [first, setFirst] = useState(initialStudentId && byId.has(initialStudentId) ? initialStudentId : "");
  const [second, setSecond] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // The question replaces the form; whoever is using a keyboard or a screen
  // reader lands on it rather than on a control that no longer exists.
  useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);

  if (!open) {
    return (
      <div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          + Mark known twin/lookalike
        </Button>
      </div>
    );
  }

  const a = byId.get(first);
  const b = byId.get(second);

  if (confirming && a && b) {
    return (
      <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
        <input type="hidden" name="studentA" value={a.studentId} />
        <input type="hidden" name="studentB" value={b.studentId} />
        {departmentId ? <input type="hidden" name="departmentId" value={departmentId} /> : null}
        <h3 ref={headingRef} tabIndex={-1} className="text-base font-semibold text-neutral-900 focus:outline-none">
          Mark these students as known twins/lookalikes?
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <ChosenStudent label="Student 1" student={a} />
          <ChosenStudent label="Student 2" student={b} />
        </div>
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{KNOWN_PAIR_WARNING}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Marking…" : "Mark as known twin/lookalike"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <StudentSelect
          id={`${id}-first`}
          label="Student 1"
          value={first}
          onChange={(value) => {
            setFirst(value);
            setProblem(null);
          }}
          groups={groups}
        />
        <StudentSelect
          id={`${id}-second`}
          label="Student 2"
          value={second}
          onChange={(value) => {
            setSecond(value);
            setProblem(null);
          }}
          groups={groups}
        />
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => {
            if (!a || !b) return setProblem("Choose two students.");
            if (a.studentId === b.studentId) return setProblem("Choose two different students.");
            setConfirming(true);
          }}
        >
          Continue
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setProblem(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * "+ Mark known twin/lookalike": two students, then the question, then the
 * mark. Opened already, with the first student chosen, when a student's
 * record sent the reviewer here.
 */
export function DeclareKnownPairForm({
  students,
  departmentId,
  initialStudentId,
}: {
  students: TwinStudentOption[];
  departmentId: string | null;
  initialStudentId: string | null;
}) {
  const [state, formAction, pending] = useActionState(declareKnownTwinPairAction, INITIAL);
  return (
    <div id="declare" className="flex scroll-mt-24 flex-col gap-3">
      <Messages state={state} />
      {students.length < 2 ? (
        <p className="text-sm text-neutral-500">You need at least two students on roll to mark a pair.</p>
      ) : (
        <DeclareSteps
          // A fresh, empty form after every mark.
          key={state.done}
          students={students}
          departmentId={departmentId}
          initialStudentId={state.done === 0 ? initialStudentId : null}
          startOpen={state.done === 0 ? initialStudentId !== null : true}
          formAction={formAction}
          pending={pending}
        />
      )}
    </div>
  );
}

/**
 * Known pairs, each with "Remove declaration" behind a question. One action
 * state for the whole list, so the result is still on screen after the row
 * it was about has gone.
 */
export function KnownPairRows({
  rows,
  departmentId,
  empty,
}: {
  rows: Array<{ pair: string; names: string; content: ReactNode }>;
  departmentId: string | null;
  empty: ReactNode;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  // The question closes once the server has answered, not on submit — which
  // would take the form away while its request is still on its way.
  const [state, formAction, pending] = useActionState(
    async (previous: KnownTwinFormState, formData: FormData) => {
      const result = await withdrawKnownTwinPairAction(previous, formData);
      setAsking(null);
      return result;
    },
    INITIAL,
  );
  return (
    <div className="flex flex-col gap-3">
      <Messages state={state} />
      {rows.length === 0 ? (
        empty
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100">
          {rows.map((row) => (
            <li key={row.pair} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">{row.content}</div>
              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                {asking === row.pair ? (
                  <form
                    action={formAction}
                    role="group"
                    aria-label={`Remove the declaration for ${row.names}?`}
                    className="flex max-w-sm flex-col gap-2 rounded-md bg-neutral-50 p-3"
                  >
                    <input type="hidden" name="pair" value={row.pair} />
                    {departmentId ? <input type="hidden" name="departmentId" value={departmentId} /> : null}
                    <p className="text-sm text-neutral-800">
                      Remove this declaration? They are treated like any other two students again: if their faces match,
                      face enrollment stops until somebody reviews the pair. No face sample or attendance record is
                      changed.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" onClick={() => setAsking(null)} disabled={pending}>
                        Cancel
                      </Button>
                      <Button type="submit" variant="danger" disabled={pending}>
                        {pending ? "Removing…" : "Remove declaration"}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Button type="button" variant="secondary" onClick={() => setAsking(row.pair)} disabled={pending}>
                    Remove declaration
                    <span className="sr-only"> for {row.names}</span>
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
