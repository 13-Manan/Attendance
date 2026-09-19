"use client";

import { useActionState } from "react";
import {
  setAcademicSessionArchivedAction,
  setCurrentAcademicSessionAction,
  type AcademicSessionActionState,
} from "@/modules/academic-sessions/actions";
import type { AcademicSessionSummary } from "@/modules/academic-sessions/types";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/use-confirm";

const initialState: AcademicSessionActionState = {};

/**
 * Make current, archive and restore, from one year's row.
 *
 * Its own action state per row, for the reason recorded in
 * `faculty/faculty-controls.tsx`: on a page listing six years, a refusal has to
 * appear on the row it belongs to rather than at the top of the table.
 *
 * ## Why archiving asks twice and the other two do not
 *
 * Archiving is the control that takes something away — the year stops being
 * offered when a class is set up — and the confirmation carries the one fact
 * that decides whether it is safe: how many classes are attached to it. A year
 * with 40 classes and an empty one should not be the same button press.
 *
 * Making a year current is a single click even though it changes what every
 * other screen defaults to, because it is immediately visible, immediately
 * reversible, and the row says which year is losing the status. Restoring is a
 * single click because it is an undo, and asking somebody to confirm an undo
 * teaches them to click through dialogs. The confirmation is scoped to the
 * year being archivable at all, so restoring one — or making it current — does
 * not bring the archive warning back with it; see `useConfirm`.
 */
export function AcademicSessionControls({ session }: { session: AcademicSessionSummary }) {
  const [currentState, makeCurrent, makingCurrent] = useActionState(
    setCurrentAcademicSessionAction,
    initialState,
  );
  const [archiveState, setArchived, archiving] = useActionState(
    setAcademicSessionArchivedAction,
    initialState,
  );
  const [confirming, setConfirming] = useConfirm(session.isActive && !session.isCurrent);

  const attached =
    session.cohortCount === 0
      ? "No classes are set up under it."
      : `${session.cohortCount} ${session.cohortCount === 1 ? "class is" : "classes are"} set up under it.`;

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {session.isActive && !session.isCurrent ? (
          <form action={makeCurrent}>
            <input type="hidden" name="id" value={session.id} />
            <input type="hidden" name="name" value={session.name} />
            <Button type="submit" variant="secondary" disabled={makingCurrent}>
              {makingCurrent ? "Switching…" : "Make current"}
            </Button>
          </form>
        ) : null}

        {!session.isActive ? (
          <form action={setArchived}>
            <input type="hidden" name="id" value={session.id} />
            <input type="hidden" name="name" value={session.name} />
            <input type="hidden" name="archived" value="false" />
            <Button type="submit" variant="secondary" disabled={archiving}>
              {archiving ? "Restoring…" : "Restore"}
            </Button>
          </form>
        ) : session.isCurrent ? null : confirming ? null : (
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
            Archive
          </Button>
        )}
      </div>

      {confirming ? (
        <form action={setArchived} className="flex flex-col items-start gap-1.5">
          <input type="hidden" name="id" value={session.id} />
          <input type="hidden" name="name" value={session.name} />
          <input type="hidden" name="archived" value="true" />
          <p className="max-w-xs text-xs text-neutral-600">
            {attached} Archiving keeps every one of them and every register ever taken — it only
            stops {session.name} being offered when a new class is set up. You can restore it later.
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={archiving}>
              {archiving ? "Archiving…" : "Archive year"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {/* The current year has no archive button at all, rather than a disabled
          one: the reason is a sentence, and a greyed-out control cannot say it. */}
      {session.isCurrent ? (
        <p className="max-w-xs text-xs text-neutral-500">
          Make another year current before archiving this one.
        </p>
      ) : null}

      {[currentState, archiveState].map((state, index) =>
        state.error ? (
          <p key={index} role="alert" className="max-w-xs text-xs text-red-700">
            {state.error}
          </p>
        ) : state.message ? (
          <p key={index} role="status" className="max-w-xs text-xs text-green-800">
            {state.message}
          </p>
        ) : null,
      )}
    </div>
  );
}
