"use client";

import { useActionState, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import {
  runRetentionSweepAction,
  updateRetentionPolicyAction,
  type ActionState,
} from "@/modules/privacy/actions";
import { MAX_RETENTION_DAYS, type BiometricRetentionPolicy } from "@/modules/privacy/types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: ActionState = {};

/**
 * Local copies of two controls the Integration Center also has.
 *
 * Duplicated rather than imported across route folders, and small enough that
 * the duplication is cheaper than the coupling: these panels must not break
 * because somebody changed a control on an unrelated screen.
 *
 * `role="alert"` for a failure and `role="status"` for a success, for the same
 * reason as everywhere else — a screen reader should interrupt for "the sweep
 * failed" and not for "saved".
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
 * The face-data retention policy editor.
 *
 * ## Why every control spells out its consequence
 *
 * The person filling this in is usually answering a question a data protection
 * authority asked, not tuning a system. So each field states what `0` means and
 * what the sweep will do, next to the input rather than in a document — a
 * retention setting that is misunderstood is a retention setting that is wrong,
 * and the data it governs is a photograph of somebody's face.
 *
 * ## Why "keep forever" is not offered
 *
 * For classroom photographs there is no such value, by construction: storage is
 * either off or "for N days" with N at least 1. The shipped default is off,
 * which is exactly what the capture path does today — turning this panel on
 * changes nothing until an administrator deliberately changes something.
 *
 * The form carries no institution id. The action reads the tenant from the
 * session, so there is no field here through which an administrator could name
 * someone else's institution.
 */
export function RetentionForm({ policy }: { policy: BiometricRetentionPolicy }) {
  const [state, formAction, pending] = useActionState(updateRetentionPolicyAction, initialState);
  // Mirrored in local state only so the dependent period box can appear and
  // disappear; the server re-derives the whole policy from the submission.
  const [storage, setStorage] = useState<string>(policy.classroomImageStorage);

  return (
    <Panel
      title="Face data retention"
      description="How long biometric templates and classroom photographs are kept, and what happens when a student leaves."
    >
      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <Field label="Face template retention in days" htmlFor="faceTemplateRetentionDays">
          <Input
            id="faceTemplateRetentionDays"
            name="faceTemplateRetentionDays"
            type="number"
            min={0}
            max={MAX_RETENTION_DAYS}
            step={1}
            defaultValue={policy.faceTemplateRetentionDays}
            className="max-w-32"
          />
          <Note>
            Counted from the day the face was enrolled. <strong>0</strong> means no age limit —
            the template lasts as long as the student is active. Set a number to force periodic
            re-enrollment: an expired template is deactivated, then deleted on the grace schedule
            below, and the student is asked to enroll again.
          </Note>
        </Field>

        <Field label="When a student is no longer active" htmlFor="onStudentInactive">
          <Select
            id="onStudentInactive"
            name="onStudentInactive"
            defaultValue={policy.onStudentInactive}
          >
            <option value="DEACTIVATE">
              Deactivate their face data, then delete it after the grace period
            </option>
            <option value="DELETE">Delete their face data on the next sweep</option>
          </Select>
          <Note>
            Applies when a student is marked inactive, transferred or completed. Deactivating
            first is the safer default: a student marked inactive by mistake can be restored,
            whereas a deleted template can only be re-collected from the person.
          </Note>
        </Field>

        <Field
          label="Grace period in days before deactivated templates are deleted"
          htmlFor="deactivatedTemplateGraceDays"
        >
          <Input
            id="deactivatedTemplateGraceDays"
            name="deactivatedTemplateGraceDays"
            type="number"
            min={0}
            max={MAX_RETENTION_DAYS}
            step={1}
            defaultValue={policy.deactivatedTemplateGraceDays}
            className="max-w-32"
          />
          <Note>
            A deactivated template is permanently deleted once it is this old.{" "}
            <strong>0</strong> means deactivated templates are never deleted automatically — they
            can still be deleted by hand, but biometric data stays in the database until somebody
            does it.
          </Note>
        </Field>

        <Field label="Classroom photographs" htmlFor="classroomImageStorage">
          <Select
            id="classroomImageStorage"
            name="classroomImageStorage"
            value={storage}
            onChange={(event) => setStorage(event.target.value)}
          >
            <option value="NEVER">Never stored — processed in memory, then discarded</option>
            <option value="RETAIN_FOR_DAYS">Stored, then deleted after a fixed period</option>
          </Select>
          <Note>
            This system does not store classroom photographs today, and that is the default. Turn
            storage on only if your institution&apos;s own policy explicitly requires keeping the
            images — an examination board, a disciplinary process. There is no option to keep them
            indefinitely.
          </Note>
        </Field>

        {storage === "RETAIN_FOR_DAYS" ? (
          <Field
            label="Delete stored classroom photographs after (days)"
            htmlFor="classroomImageRetentionDays"
          >
            <Input
              id="classroomImageRetentionDays"
              name="classroomImageRetentionDays"
              type="number"
              min={1}
              max={MAX_RETENTION_DAYS}
              step={1}
              defaultValue={policy.classroomImageRetentionDays || 30}
              className="max-w-32"
            />
            <Note>At least 1 day, and required whenever storage is on.</Note>
          </Field>
        ) : (
          // Submitted as 0 so the action always sees a complete form. The
          // service zeroes this field under NEVER in any case.
          <input type="hidden" name="classroomImageRetentionDays" value="0" />
        )}

        <Banner state={state} />

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save retention policy"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * Applies the policy now.
 *
 * A button rather than a schedule because no scheduler ships with this build
 * (ADR-0007), and a policy that can only be enforced by a cron nobody has
 * installed is a policy that is not enforced. The result says exactly what was
 * deactivated and deleted, so an administrator can see the effect rather than
 * trust it.
 */
export function RetentionSweepPanel() {
  const [state, formAction, pending] = useActionState(runRetentionSweepAction, initialState);

  return (
    <Panel
      title="Apply the retention policy now"
      description="Deactivates and deletes the face data that is outside the policy above. Deletions cannot be undone."
    >
      <form action={formAction} className="flex flex-col gap-3">
        <Note>
          Safe to run more than once: every decision is made from the current state of each row,
          so a second run over an unchanged roster does nothing. The run is recorded in the audit
          log whether or not it found anything.
        </Note>
        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input type="checkbox" name="acknowledge" className="mt-0.5" />
          <span>
            I understand this permanently deletes face templates that are outside the policy, and
            that those students would have to enroll again in person.
          </span>
        </label>
        <Banner state={state} />
        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Running…" : "Run retention sweep"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
