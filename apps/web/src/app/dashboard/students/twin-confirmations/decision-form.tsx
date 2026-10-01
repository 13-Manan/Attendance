"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  decideTwinConfirmationAction,
  type TwinDecisionFormState,
} from "@/modules/twin-confirmation/actions";
import type { TwinPairState } from "@/modules/twin-confirmation/types";
import { Button } from "@/components/ui/button";

const initialState: TwinDecisionFormState = { error: null };

/**
 * The reviewer's decision about one pair.
 *
 * "Confirm these are different people" asks for a tick first: it is the one
 * button in this product that lets a face through the duplicate check, and it
 * should not be pressed on the strength of two names. "Not confirmed" needs
 * no such step — it changes nothing for the student, who stays blocked.
 *
 * The form carries only the pair's key and, on a department's page, the
 * department; the server works out everything else and checks it.
 */
export function TwinDecisionForm({
  pair,
  state,
  departmentId,
  cancelHref,
}: {
  pair: string;
  state: TwinPairState;
  departmentId: string | null;
  cancelHref: string;
}) {
  const [result, formAction, pending] = useActionState(decideTwinConfirmationAction, initialState);

  return (
    <form action={formAction} className="flex flex-col items-start gap-3">
      <input type="hidden" name="pair" value={pair} />
      {departmentId ? <input type="hidden" name="departmentId" value={departmentId} /> : null}

      <label className="flex max-w-2xl items-start gap-3 text-sm text-neutral-700">
        <input type="checkbox" name="checked" className="mt-0.5 h-4 w-4 rounded border-neutral-300" />
        <span>
          I have checked in person that these are two different people — identical twins, or two
          students who look alike — and not the same student enrolled twice.
          <span className="mt-1 block text-xs text-neutral-500">
            Confirming lets face enrollment continue for these two students only. It does not
            change how attendance recognises them: a classroom photograph that cannot tell them
            apart still goes to review instead of being guessed.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="confirmed" disabled={pending || state === "confirmed"}>
          Confirm these are different people
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="secondary"
          disabled={pending || state === "rejected"}
        >
          Not confirmed
        </Button>
        <Link
          href={cancelHref}
          className="inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 sm:min-h-10"
        >
          Cancel
        </Link>
      </div>

      {result.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {result.error}
        </p>
      ) : null}
    </form>
  );
}
