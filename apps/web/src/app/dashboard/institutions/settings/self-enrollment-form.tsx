"use client";

import { useActionState } from "react";
import {
  updateSelfEnrollmentPolicyAction,
  type ActionState,
} from "@/modules/admin-settings/actions";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

const initialState: ActionState = {};

/**
 * Who may enrol a face.
 *
 * Deliberately not folded into the recognition-thresholds form above it, even
 * though both live under `Institution.settings`. The thresholds decide how
 * confidently a stored template is matched; this decides whether biometric
 * data can enter the system at all without a member of staff present. They are
 * different questions, they are answered by different people, and an
 * administrator who came to change one should not have to re-submit the other.
 *
 * The default is stated rather than implied. An administrator looking at an
 * unticked box on a college should be able to tell whether somebody turned it
 * off or whether it was never on — those are different facts about their
 * institution and only one of them is a decision.
 */
export function SelfEnrollmentForm({
  enabled,
  defaultForType,
  institutionType,
}: {
  enabled: boolean;
  defaultForType: boolean;
  institutionType: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateSelfEnrollmentPolicyAction,
    initialState,
  );

  const typeWord = institutionType === "COLLEGE" ? "college" : "school";

  return (
    <Panel
      title="Who may enrol a face"
      description="Staff can always enrol a student from that student's record. This decides whether students may also do it themselves, from the student portal."
    >
      <form action={formAction} className="flex flex-col items-start gap-3">
        <label className="flex max-w-2xl items-start gap-3 text-sm text-neutral-700">
          <input
            type="checkbox"
            name="selfEnrollmentEnabled"
            defaultValue="on"
            defaultChecked={enabled}
            className="mt-0.5 h-4 w-4 rounded border-neutral-300"
          />
          <span>
            Students may enrol their own face from the student portal.
            <span className="mt-1 block text-xs text-neutral-500">
              The default for a {typeWord} is {defaultForType ? "on" : "off"}
              {enabled === defaultForType
                ? ", and this institution is using it."
                : ", and this institution has been set the other way."}{" "}
              A student can only ever enrol their own face — the portal accepts no student id, and
              the server resolves the account&apos;s own record. Students can never retire or replace
              a template; that stays with staff, because a student able to remove their own
              template could make themselves unrecognisable before a class.
            </span>
          </span>
        </label>

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>

        {state.error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}
        {state.message ? (
          <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            {state.message}
          </p>
        ) : null}
      </form>
    </Panel>
  );
}
