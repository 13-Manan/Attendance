"use client";

import { useActionState, useState } from "react";
import { setSuspendedAction, type PlatformFormState } from "@/modules/platform/actions";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

const INITIAL: PlatformFormState = { error: null };

/**
 * Suspending and restoring a tenant.
 *
 * The confirmation is asymmetric, and deliberately so. Restoring service is
 * not a step anybody needs slowing down. Suspending stops a school being
 * served, so it states the consequence in the institution's own numbers —
 * "400 students, 2 registers awaiting review" — and requires the name typed
 * exactly. A generic "Are you sure?" on a page listing many institutions
 * cannot tell an administrator *which one* they are about to switch off.
 *
 * The typed value is checked server-side as well. This component makes the
 * mistake hard to make; it is not what makes it safe.
 */
export function SuspensionControl({
  institutionId,
  institutionName,
  suspended,
  students,
  awaitingReview,
}: {
  institutionId: string;
  institutionName: string;
  suspended: boolean;
  students: number;
  awaitingReview: number;
}) {
  const [state, action, pending] = useActionState(setSuspendedAction, INITIAL);
  const [confirming, setConfirming] = useState(false);

  if (suspended) {
    return (
      <Panel title="Restore service" description="Puts this institution back into service.">
        {state.error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            {state.error}
          </p>
        ) : null}
        <form action={action}>
          <input type="hidden" name="institutionId" value={institutionId} />
          <input type="hidden" name="suspend" value="false" />
          <Button type="submit" disabled={pending}>
            {pending ? "Restoring…" : "Restore institution"}
          </Button>
        </form>
      </Panel>
    );
  }

  return (
    <Panel
      title="Suspend institution"
      description="Stops this institution being served. Reversible, and deletes nothing."
    >
      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      ) : null}

      {!confirming ? (
        <div>
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Suspend institution…
          </Button>
        </div>
      ) : (
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="institutionId" value={institutionId} />
          <input type="hidden" name="suspend" value="true" />
          <input type="hidden" name="expectedName" value={institutionName} />

          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-medium">
              This will suspend {institutionName}.
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              <li>
                {students} active student{students === 1 ? "" : "s"} and their staff stop being
                served.
              </li>
              {awaitingReview > 0 ? (
                <li>
                  {awaitingReview} register{awaitingReview === 1 ? "" : "s"} still awaiting a
                  faculty decision will stay unresolved.
                </li>
              ) : null}
              <li>
                Attendance records, audit history and enrolments are kept. Nothing is deleted, and
                this can be undone.
              </li>
            </ul>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-neutral-700">
              Type <span className="font-mono">{institutionName}</span> to confirm
            </span>
            <input
              name="confirmation"
              required
              autoComplete="off"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Suspending…" : "Suspend institution"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
