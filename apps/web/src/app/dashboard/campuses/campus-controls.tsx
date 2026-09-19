"use client";

import { useActionState } from "react";
import { setCampusOpenAction, type CampusActionState } from "@/modules/campuses/actions";
import type { CampusSummary } from "@/modules/campuses/types";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/use-confirm";

const initialState: CampusActionState = {};

/**
 * Close or reopen one campus, from its row.
 *
 * Its own action state per row, for the reason recorded in
 * `faculty/faculty-controls.tsx`: on a page listing six campuses, a refusal
 * has to appear on the row it belongs to.
 *
 * ## Why closing asks twice
 *
 * It is the destructive-looking control on this screen, and the confirmation
 * step exists to carry one sentence: what closing does and what it does not
 * touch. The sentence names the actual numbers attached to this campus, so
 * "close the branch we never used" and "close the branch with 412 students"
 * are visibly different decisions rather than the same button.
 *
 * Reopening is a single click. It is reversible, it takes nothing away, and
 * asking somebody to confirm an undo teaches them to click through dialogs.
 * The confirmation is scoped to the campus being open, so reopening one does
 * not bring the closing warning back with it — see `useConfirm`.
 */
export function CampusStatusControl({ campus }: { campus: CampusSummary }) {
  const [state, formAction, pending] = useActionState(setCampusOpenAction, initialState);
  const [confirming, setConfirming] = useConfirm(campus.isActive);

  const attached =
    campus.studentCount + campus.staffCount + campus.academicUnitCount === 0
      ? "Nothing is assigned to it."
      : `${campus.studentCount} ${campus.studentCount === 1 ? "student" : "students"}, ` +
        `${campus.staffCount} ${campus.staffCount === 1 ? "staff member" : "staff"} and ` +
        `${campus.academicUnitCount} ${campus.academicUnitCount === 1 ? "class or unit" : "classes and units"} ` +
        "are assigned to it.";

  return (
    <div className="flex flex-col items-start gap-2">
      {!campus.isActive ? (
        <form action={formAction}>
          <input type="hidden" name="id" value={campus.id} />
          <input type="hidden" name="isActive" value="true" />
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Reopening…" : "Reopen"}
          </Button>
        </form>
      ) : confirming ? (
        <form action={formAction} className="flex flex-col items-start gap-1.5">
          <input type="hidden" name="id" value={campus.id} />
          <input type="hidden" name="isActive" value="false" />
          <p className="max-w-xs text-xs text-neutral-600">
            {attached} Closing keeps every one of those records and every register ever taken
            here — it only stops {campus.name} being offered when someone is assigned a campus.
            You can reopen it later.
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Closing…" : "Close campus"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
          Close
        </Button>
      )}

      {state.error ? (
        <p role="alert" className="max-w-xs text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="max-w-xs text-xs text-green-800">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
