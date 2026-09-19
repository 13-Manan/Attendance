"use client";

import { useActionState } from "react";
import {
  updateInstitutionProfileAction,
  type InstitutionProfileActionState,
} from "@/modules/institution-profile/actions";
import {
  MAX_ADDRESS_LINE,
  MAX_CONTACT_EMAIL,
  MAX_CONTACT_PHONE,
  MAX_INSTITUTION_NAME,
  MAX_UNIT_LABEL,
  labelField,
  type InstitutionProfile,
} from "@/modules/institution-profile/types";
import {
  ACADEMIC_UNIT_LABEL_KEYS,
  DEFAULT_ACADEMIC_UNIT_LABELS,
} from "@/modules/institutions/types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const initialState: InstitutionProfileActionState = {};

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-neutral-500">{children}</p>;
}

/**
 * The institution's own profile.
 *
 * ## Why the fields are keyed on `attempt`
 *
 * React resets a form when its action completes, which would wipe a refused
 * submission back to the stored values and lose whatever the administrator had
 * typed. Re-keying every input on the attempt counter remounts them with the
 * echoed `defaultValue`, so a refusal keeps the work and a success shows what
 * was actually saved. The same idiom is used by every other form in this
 * codebase.
 *
 * No institution id is rendered anywhere. The action reads the tenant from the
 * session, so there is no field to tamper with.
 */
export function InstitutionProfileForm({
  profile,
  timezones,
}: {
  profile: InstitutionProfile;
  /** Built on the server by `listTimezoneOptions`, current zone first. */
  timezones: string[];
}) {
  const [state, formAction, pending] = useActionState(
    updateInstitutionProfileAction,
    initialState,
  );

  // The echoed values win over the stored ones, so a refused save redisplays
  // what was typed rather than silently reverting it.
  const value = (field: string, stored: string | null) => state.values?.[field] ?? stored ?? "";
  const key = state.attempt ?? 0;

  return (
    <Panel
      title="Institution profile"
      description="Who this institution is, where it is, and what it calls the parts of itself."
    >
      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <Field label="Institution name" htmlFor="name">
          <Input
            key={`name-${key}`}
            id="name"
            name="name"
            required
            maxLength={MAX_INSTITUTION_NAME}
            defaultValue={value("name", profile.name)}
            autoComplete="organization"
          />
          <Note>Shown on reports, on the sign-in page and in every notification this system sends.</Note>
        </Field>

        <Field label="Institution type" htmlFor="type">
          {/* Read-only, and rendered as text rather than a disabled control:
              a greyed-out dropdown invites somebody to hunt for the permission
              that unlocks it, and there is none. */}
          <p id="type" className="text-sm text-neutral-900">
            {profile.type === "SCHOOL" ? "School" : "College"}
          </p>
          <Note>
            Set when the institution was created. It selects the shape of a register — a daily class
            register or one per lecture — so changing it would leave every session already taken on
            the wrong side of that choice. To take registers the other way, change{" "}
            <strong>Attendance mode</strong> below.
          </Note>
        </Field>

        <Field label="Time zone" htmlFor="timezone">
          <Select
            key={`timezone-${key}`}
            id="timezone"
            name="timezone"
            defaultValue={value("timezone", profile.timezone)}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
          <Note>
            Decides which calendar day a register belongs to. It matters most for an institution
            whose evening classes run past midnight UTC: the register should be filed under the day
            the class was held locally, not the day it was in London.
          </Note>
        </Field>

        <Field label="Contact email" htmlFor="contactEmail">
          <Input
            key={`contactEmail-${key}`}
            id="contactEmail"
            name="contactEmail"
            type="email"
            maxLength={MAX_CONTACT_EMAIL}
            defaultValue={value("contactEmail", profile.contactEmail)}
            autoComplete="email"
          />
          <Note>Optional. The address a parent or a student would write to.</Note>
        </Field>

        <Field label="Contact number" htmlFor="contactPhone">
          <Input
            key={`contactPhone-${key}`}
            id="contactPhone"
            name="contactPhone"
            type="tel"
            maxLength={MAX_CONTACT_PHONE}
            defaultValue={value("contactPhone", profile.contactPhone)}
            autoComplete="tel"
          />
          <Note>
            Optional, and kept exactly as you write it — including the country code, spacing and
            extension your own stationery uses.
          </Note>
        </Field>

        <Field label="Address" htmlFor="addressLine">
          <textarea
            key={`addressLine-${key}`}
            id="addressLine"
            name="addressLine"
            rows={3}
            maxLength={MAX_ADDRESS_LINE}
            defaultValue={value("addressLine", profile.addressLine)}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
          />
          <Note>Optional. Several lines are fine.</Note>
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
          <legend className="px-1 text-sm font-medium text-neutral-700">
            What this institution calls things
          </legend>
          <Note>
            Vocabulary only — nothing behaves differently because of a word here. A college that
            says &ldquo;Batch&rdquo; where this system says &ldquo;Section&rdquo; can set it once
            and see its own word everywhere. Leave a box empty to go back to the standard word.
          </Note>
          <div className="grid gap-3 sm:grid-cols-2">
            {ACADEMIC_UNIT_LABEL_KEYS.map((unitKey) => {
              const field = labelField(unitKey);
              const stored = profile.academicUnitLabels[unitKey];
              return (
                <Field
                  key={field}
                  label={DEFAULT_ACADEMIC_UNIT_LABELS[unitKey]}
                  htmlFor={field}
                >
                  <Input
                    key={`${field}-${key}`}
                    id={field}
                    name={field}
                    maxLength={MAX_UNIT_LABEL}
                    placeholder={DEFAULT_ACADEMIC_UNIT_LABELS[unitKey]}
                    defaultValue={value(field, stored)}
                  />
                </Field>
              );
            })}
          </div>
        </fieldset>

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

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * The same facts for somebody who may read settings but not change them.
 *
 * A teacher asking "what number do we give parents?" should be able to answer
 * it without an administrator, and an empty contact field says so in words
 * rather than leaving a blank cell that could equally mean "loading".
 */
export function InstitutionProfileSummary({ profile }: { profile: InstitutionProfile }) {
  return (
    <Panel title="Institution profile" description="Read-only — changing these needs institution settings access.">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-neutral-500">Name</dt>
        <dd className="text-neutral-900">{profile.name}</dd>
        <dt className="text-neutral-500">Type</dt>
        <dd className="text-neutral-900">{profile.type === "SCHOOL" ? "School" : "College"}</dd>
        <dt className="text-neutral-500">Time zone</dt>
        <dd className="text-neutral-900">{profile.timezone}</dd>
        <dt className="text-neutral-500">Contact email</dt>
        <dd className="text-neutral-900">{profile.contactEmail ?? "Not on file"}</dd>
        <dt className="text-neutral-500">Contact number</dt>
        <dd className="text-neutral-900">{profile.contactPhone ?? "Not on file"}</dd>
        <dt className="text-neutral-500">Address</dt>
        <dd className="whitespace-pre-line text-neutral-900">
          {profile.addressLine ?? "Not on file"}
        </dd>
        <dt className="text-neutral-500">Academic unit labels</dt>
        <dd className="text-neutral-900">
          {ACADEMIC_UNIT_LABEL_KEYS.map((key) => profile.academicUnitLabels[key]).join(", ")}
        </dd>
      </dl>
    </Panel>
  );
}
