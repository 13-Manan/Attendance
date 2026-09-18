"use client";

import { useActionState, type ReactNode } from "react";
import { updateFacePolicyAction, type ActionState } from "@/modules/admin-settings/actions";
import {
  DEFAULT_FACE_POLICY,
  FACE_POLICY_BOUNDS,
  type FaceRecognitionPolicySettings,
} from "@/modules/admin-settings/types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: ActionState = {};

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-neutral-500">{children}</p>;
}

/**
 * Warnings are amber and never block.
 *
 * `role="status"` rather than `role="alert"`: the save succeeded, and a screen
 * reader should not announce a completed action as a failure. The refusals —
 * the values this system will not accept at all — arrive as `state.error` and
 * do interrupt.
 */
function Warnings({ items, heading }: { items: string[]; heading: string }) {
  if (items.length === 0) return null;
  return (
    <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="font-medium">{heading}</p>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ChangedBadge({ changed }: { changed: boolean }) {
  if (!changed) return null;
  return (
    <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
      changed from default
    </span>
  );
}

/**
 * One numeric recognition control.
 *
 * `min`, `max` and `step` come from `FACE_POLICY_BOUNDS`, so the browser and
 * the server refuse the same values — but the browser's refusal is a
 * convenience only. `validateFacePolicy` runs server-side on every submission
 * and is the one that counts; a request that never touches this form is held
 * to exactly the same range.
 */
function PolicyField({
  name,
  label,
  value,
  changed,
  children,
}: {
  name: keyof FaceRecognitionPolicySettings;
  label: string;
  value: number;
  changed: boolean;
  children: ReactNode;
}) {
  const bound = FACE_POLICY_BOUNDS[name];
  return (
    <Field label={label} htmlFor={name}>
      <div className="flex items-center gap-3">
        <Input
          id={name}
          name={name}
          type="number"
          min={bound.min}
          max={bound.max}
          step={bound.step}
          defaultValue={value}
          className="max-w-32"
        />
        <span className="text-xs text-neutral-500">
          allowed {bound.min}–{bound.max}, default {DEFAULT_FACE_POLICY[name]}
          <ChangedBadge changed={changed} />
        </span>
      </div>
      <Note>{children}</Note>
    </Field>
  );
}

/**
 * The recognition policy editor.
 *
 * ## Why this screen is wordier than the rest of the dashboard
 *
 * These four numbers decide whether a student is marked present, sent to a
 * teacher, or marked absent. An administrator changing them is usually
 * responding to a complaint — "the system keeps missing the back row" — and
 * has no way to know which number governs that. So each control says what it
 * means, what moving it in each direction costs, and what the benchmark in
 * `docs/BENCHMARKS.md` measured. A threshold changed without understanding it
 * is the most damaging thing on this settings page, and the damage is silent:
 * nothing errors, students are simply marked wrong.
 *
 * ## What this form will not do
 *
 * It will not quietly adjust a value to something safer. Out-of-range input is
 * refused with a sentence naming the field and the range; risky-but-legal
 * input is saved exactly as typed and warned about. A threshold silently
 * different from the one an administrator entered is a threshold nobody is
 * accountable for.
 *
 * The acknowledgement checkbox is friction against a misclick, not a security
 * control — `institution.update` and the server-side range check are the
 * controls, and neither can be skipped by a caller that avoids this form.
 */
export function FacePolicyForm({
  policy,
  currentWarnings,
  changedFields,
}: {
  policy: FaceRecognitionPolicySettings;
  currentWarnings: string[];
  changedFields: Array<keyof FaceRecognitionPolicySettings>;
}) {
  const [state, formAction, pending] = useActionState(updateFacePolicyAction, initialState);
  const changed = new Set(changedFields);

  return (
    <Panel
      title="Face recognition policy"
      description="The confidence values that decide whether a face becomes a Present, a review item, or nothing at all."
    >
      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        {/* Shown on load, about the policy currently in force — before any
            change is made, because the administrator who needs the warning is
            usually the one who inherited the setting. */}
        <Warnings items={currentWarnings} heading="About the policy currently in force" />

        <PolicyField
          name="presentMin"
          label="Present threshold"
          value={policy.presentMin}
          changed={changed.has("presentMin")}
        >
          A face matching an enrolled student at or above this similarity is marked{" "}
          <strong>Present</strong> without anyone looking at it. Lower it and more students are
          marked present automatically — including students who were not there. Raise it and more
          faces go to a teacher instead. The synthetic benchmark in{" "}
          <code>docs/BENCHMARKS.md</code> §6 saw false accepts persist until 0.70.
        </PolicyField>

        <PolicyField
          name="reviewMin"
          label="Review threshold"
          value={policy.reviewMin}
          changed={changed.has("reviewMin")}
        >
          Between this value and the present threshold, a face is sent to a person as{" "}
          <strong>Needs Review</strong> rather than being decided by the model. Below it, the match
          is discarded — the student is not marked present, and a teacher marks them by hand. The
          gap between the two thresholds is the uncertain band: make it narrow and uncertainty
          turns into Absent instead of into a question.
        </PolicyField>

        <PolicyField
          name="ambiguityMargin"
          label="Ambiguity margin"
          value={policy.ambiguityMargin}
          changed={changed.has("ambiguityMargin")}
        >
          When a face matches two different students almost equally well, this is how close the
          two scores must be before the system refuses to choose and sends it to review. This is
          the setting that decides what happens to siblings, twins and look-alikes. At{" "}
          <strong>0</strong> the system always picks whichever scored marginally higher.
        </PolicyField>

        <PolicyField
          name="minDetectionConfidence"
          label="Minimum detection confidence"
          value={policy.minDetectionConfidence}
          changed={changed.has("minDetectionConfidence")}
        >
          How sure the detector must be that a region of the photograph is a face at all, before
          the system tries to match it. Too low and posters, reflections and faces in the corridor
          get matched against your roster. Too high and the back rows stop being seen — those
          students are not marked absent by this setting, they simply never appear, which reaches
          the register as an Absent anyway.
        </PolicyField>

        <label className="flex items-start gap-2 text-sm text-neutral-700">
          <input type="checkbox" name="acknowledge" className="mt-0.5" />
          <span>
            I understand these values change how attendance is decided for every class in this
            institution, and that the change is recorded in the audit log under my name.
          </span>
        </label>

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
        {/* Shown again after saving, about the values now in force — the
            warning that matters is the one about the policy that is live. */}
        <Warnings items={state.warnings ?? []} heading="About the policy you just saved" />

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save recognition policy"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
