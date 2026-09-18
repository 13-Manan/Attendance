"use client";

import { useActionState, type ReactNode, type SelectHTMLAttributes } from "react";
import { updateAttendanceSettingsAction, type ActionState } from "@/modules/admin-settings/actions";
import {
  FIXED_ATTENDANCE_RULES,
  MAX_CORRECTION_WINDOW_DAYS,
  type AttendancePolicySettings,
} from "@/modules/admin-settings/types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: ActionState = {};

/**
 * Local copies of the three small controls this folder's other form also has
 * — see the note in `retention-form.tsx`. Kept per-folder on purpose so a
 * change to one settings screen cannot break another.
 */
function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500 ${className}`}
      {...props}
    />
  );
}

function Banner({ state }: { state: ActionState }) {
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

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-neutral-500">{children}</p>;
}

/**
 * Attendance settings: how a register is taken, when it counts as low, and how
 * long a finalized one stays correctable.
 *
 * ## Why each control names the code that reads it
 *
 * A settings screen earns trust by being checkable. Every field here states
 * which engine consults it, so an administrator who doubts that a change took
 * effect can find the place that reads it rather than guessing. The rule this
 * module is built on — no control that changes nothing — is only visible to
 * the person using the screen if the screen says so.
 *
 * The form carries no institution id; the action reads the tenant from the
 * session.
 */
export function AttendanceSettingsForm({
  attendanceMode,
  lowAttendanceThreshold,
  policy,
}: {
  attendanceMode: string;
  lowAttendanceThreshold: number;
  policy: AttendancePolicySettings;
}) {
  const [state, formAction, pending] = useActionState(updateAttendanceSettingsAction, initialState);

  return (
    <Panel
      title="Attendance settings"
      description="How registers are taken, when attendance counts as low, and how long a finalized register can be corrected."
    >
      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <Field label="Attendance mode" htmlFor="attendanceMode">
          <Select id="attendanceMode" name="attendanceMode" defaultValue={attendanceMode}>
            <option value="DAILY">Daily — one register per class per day</option>
            <option value="SUBJECT_WISE">Subject-wise — one register per lecture</option>
          </Select>
          <Note>
            Schools usually take one register a day; colleges usually take one per lecture, because
            a student can attend one subject and miss the next. Changing this does not rewrite
            registers that already exist — it decides how new sessions are counted and reported.
          </Note>
        </Field>

        <Field label="Low attendance threshold (%)" htmlFor="lowAttendanceThreshold">
          <Input
            id="lowAttendanceThreshold"
            name="lowAttendanceThreshold"
            type="number"
            min={0}
            max={100}
            step={0.5}
            defaultValue={lowAttendanceThreshold}
            className="max-w-32"
          />
          <Note>
            A student below this percentage is flagged in reports and on the student portal. It is
            a reporting line, not an enforcement one: nothing is blocked and no attendance record
            changes because a student crosses it.
          </Note>
        </Field>

        <Field label="Correction window after finalization (days)" htmlFor="correctionWindowDays">
          <Input
            id="correctionWindowDays"
            name="correctionWindowDays"
            type="number"
            min={0}
            max={MAX_CORRECTION_WINDOW_DAYS}
            step={1}
            defaultValue={policy.correctionWindowDays}
            className="max-w-32"
          />
          <Note>
            How long after a register is finalized an administrator may still change a result.{" "}
            <strong>0</strong> means no time limit, which is what this system did before this
            setting existed. A register that is still under review is never governed by this clock —
            a deadline must not be the thing that decides what an unresolved row becomes.
          </Note>
        </Field>

        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            name="requireReasonAfterFinalization"
            defaultChecked={policy.requireReasonAfterFinalization}
            className="mt-0.5"
          />
          <span>
            Require a written reason when changing a finalized register
            <span className="mt-0.5 block text-xs text-neutral-500">
              Applies only after finalization. During review a teacher is expected to disagree with
              the model many times per session, and demanding a sentence each time produces thirty
              rows that say &ldquo;wrong&rdquo; — which is a tax, not an audit trail.
            </span>
          </span>
        </label>

        <Banner state={state} />

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save attendance settings"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * The rules that are not settings.
 *
 * Stated rather than rendered as disabled switches: a greyed-out control
 * invites somebody to hunt for the permission that unlocks it, and there is
 * none. Each line carries its reason, because "you cannot turn this off" is
 * only acceptable when the system says why.
 */
export function FixedAttendanceRules() {
  return (
    <Panel
      title="Rules that cannot be changed"
      description="These are part of how attendance is decided. No permission grants them, and no setting switches them off."
    >
      <ul className="flex flex-col gap-3">
        {FIXED_ATTENDANCE_RULES.map((entry) => (
          <li key={entry.rule} className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-neutral-900">{entry.rule}</span>
            <span className="text-xs text-neutral-500">{entry.why}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
