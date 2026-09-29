"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createDepartmentStudentAction, type NewStudentState } from "@/modules/college-setup/actions";
import {
  MAX_ADMISSION_NUMBER,
  MAX_STUDENT_CODE,
  MAX_STUDENT_EMAIL,
  MAX_STUDENT_NAME,
  MAX_STUDENT_PHONE,
  type StudentFormOptions,
} from "@/modules/students/directory-types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { usePageLeft } from "@/components/ui/use-page-left";

const INITIAL: NewStudentState = {};

/** A section the new student can join, named the way the department's pages name it. */
export interface NewStudentSection {
  sectionId: string;
  /** "Physics — Section A (PHY401-A)". */
  label: string;
}

type Created = NonNullable<NewStudentState["created"]>;

/**
 * A new student admitted from a college department, with their Student
 * Portal login: who they are, the course section they join, and the college
 * email they sign in with — one form, one submission, created together or
 * not at all.
 *
 * On success the form gives way to the temporary password: the action's
 * answer, held in this component's state. It is not in the address bar, not in
 * storage, and not in the student's page; reloading or leaving this page drops
 * it, and Done unmounts the form — and with it the password — before the
 * student's page opens. From then on the only way to see it again is the
 * audited "Show current password" on that page.
 */
export function NewStudentWithLoginForm({
  departmentId,
  sections,
  fixedSection,
  campuses,
}: {
  departmentId: string;
  /** The department's sections this session, to choose from. Ignored with `fixedSection`. */
  sections: readonly NewStudentSection[];
  /** Opened from a section's own page: the student joins that section, and there is no choice. */
  fixedSection?: NewStudentSection;
  campuses: StudentFormOptions["campuses"];
}) {
  const router = useRouter();
  const [leavingFor, setLeavingFor] = useState<string | null>(null);

  if (leavingFor) {
    return (
      <p role="status" className="text-sm text-neutral-600">
        Opening {leavingFor}&apos;s page…
      </p>
    );
  }
  return (
    <Admission
      departmentId={departmentId}
      sections={sections}
      fixedSection={fixedSection}
      campuses={campuses}
      onDone={(created) => {
        setLeavingFor(created.name);
        router.push(created.href);
      }}
    />
  );
}

function Admission({
  departmentId,
  sections,
  fixedSection,
  campuses,
  onDone,
}: {
  departmentId: string;
  sections: readonly NewStudentSection[];
  fixedSection?: NewStudentSection;
  campuses: StudentFormOptions["campuses"];
  onDone: (created: Created) => void;
}) {
  const [state, formAction, pending] = useActionState(createDepartmentStudentAction, INITIAL);
  const id = useId();

  if (state.created) {
    const created = state.created;
    return <StudentCreated created={created} onDone={() => onDone(created)} />;
  }

  // Every field is keyed on the attempt, so a refusal redisplays what was typed.
  const key = state.attempt ?? 0;
  const typed = (name: string) => state.values?.[name] ?? "";

  return (
    <form action={formAction} className="flex w-full max-w-2xl flex-col gap-5">
      <input type="hidden" name="departmentId" value={departmentId} />
      {fixedSection ? <input type="hidden" name="sectionId" value={fixedSection.sectionId} /> : null}
      <p className="text-xs text-neutral-500">Fields marked * are required.</p>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Step 1 · Student details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name *" htmlFor={`${id}-firstName`}>
            <Input
              key={`firstName-${key}`}
              id={`${id}-firstName`}
              name="firstName"
              required
              autoComplete="off"
              maxLength={MAX_STUDENT_NAME}
              defaultValue={typed("firstName")}
            />
          </Field>
          <Field label="Last name *" htmlFor={`${id}-lastName`}>
            <Input
              key={`lastName-${key}`}
              id={`${id}-lastName`}
              name="lastName"
              required
              autoComplete="off"
              maxLength={MAX_STUDENT_NAME}
              defaultValue={typed("lastName")}
            />
          </Field>
        </div>
        <Field label="Student ID *" htmlFor={`${id}-studentCode`}>
          <Input
            key={`studentCode-${key}`}
            id={`${id}-studentCode`}
            name="studentCode"
            required
            autoComplete="off"
            maxLength={MAX_STUDENT_CODE}
            defaultValue={typed("studentCode")}
            aria-describedby={`${id}-studentCode-help`}
          />
          <p id={`${id}-studentCode-help`} className="mt-1 text-xs text-neutral-500">
            The college&apos;s own ID for the student — a roll or register number. It must be unique in the college.
          </p>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Admission number (optional)" htmlFor={`${id}-admissionNumber`}>
            <Input
              key={`admissionNumber-${key}`}
              id={`${id}-admissionNumber`}
              name="admissionNumber"
              autoComplete="off"
              maxLength={MAX_ADMISSION_NUMBER}
              defaultValue={typed("admissionNumber")}
            />
          </Field>
          <Field label="Admission date (optional)" htmlFor={`${id}-admissionDate`}>
            <Input
              key={`admissionDate-${key}`}
              id={`${id}-admissionDate`}
              name="admissionDate"
              type="date"
              defaultValue={typed("admissionDate")}
            />
          </Field>
          <Field label="Phone (optional)" htmlFor={`${id}-phone`}>
            <Input
              key={`phone-${key}`}
              id={`${id}-phone`}
              name="phone"
              type="tel"
              autoComplete="off"
              maxLength={MAX_STUDENT_PHONE}
              defaultValue={typed("phone")}
            />
          </Field>
          {campuses.length > 0 ? (
            <Field label="Campus (optional)" htmlFor={`${id}-campusId`}>
              <Select key={`campusId-${key}`} id={`${id}-campusId`} name="campusId" defaultValue={typed("campusId")}>
                <option value="">No campus</option>
                {campuses.map((campus) => (
                  <option key={campus.id} value={campus.id}>
                    {campus.name} ({campus.code}){campus.isActive ? "" : " — closed"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Step 2 · Course and section</legend>
        {fixedSection ? (
          <p className="text-sm text-neutral-700">
            They join <span className="font-medium text-neutral-900">{fixedSection.label}</span>.
          </p>
        ) : (
          <Field label="Course and section *" htmlFor={`${id}-sectionId`}>
            <Select
              key={`sectionId-${key}`}
              id={`${id}-sectionId`}
              name="sectionId"
              required
              defaultValue={typed("sectionId")}
            >
              <option value="">Choose…</option>
              {sections.map((section) => (
                <option key={section.sectionId} value={section.sectionId}>
                  {section.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <p className="text-xs text-neutral-500">
          They can be added to their other courses&apos; sections from their page afterwards.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Step 3 · Student login</legend>
        <Field label="College email *" htmlFor={`${id}-email`}>
          <Input
            key={`email-${key}`}
            id={`${id}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={MAX_STUDENT_EMAIL}
            defaultValue={typed("email")}
            aria-describedby={`${id}-email-help`}
          />
          <p id={`${id}-email-help`} className="mt-1 text-xs text-neutral-500">
            This email will be used by the student to sign in to the Student Portal.
          </p>
        </Field>
        <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          A temporary password is created for them and shown to you on the next screen. They choose their own
          password the first time they sign in. Authorized staff can reveal their current password from their page
          when necessary; every reveal is recorded.
        </p>
      </fieldset>

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create student and login"}
        </Button>
        <p className="text-xs text-neutral-500">Recorded in the audit log against your name.</p>
      </div>
    </form>
  );
}

/** This page's origin, read in the browser; empty while rendering on the server. */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
}

/**
 * "Student created": who was admitted, how they sign in, and their temporary
 * password — this once. Focus moves to the heading, so a screen reader reads
 * the result rather than the button that was pressed.
 */
function StudentCreated({ created, onDone }: { created: Created; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const left = usePageLeft();
  const origin = useOrigin();
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => heading.current?.focus(), []);

  return (
    <section
      aria-labelledby={headingId}
      className="flex w-full max-w-2xl flex-col gap-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 sm:p-5"
    >
      <h2 id={headingId} ref={heading} tabIndex={-1} className="text-base font-semibold text-emerald-900 outline-none">
        Student created
      </h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Detail label="Name">{created.name}</Detail>
        <Detail label="Student ID">
          <span className="font-mono">{created.studentCode}</span>
        </Detail>
        <Detail label="College email">
          <span className="break-all">{created.email}</span>
        </Detail>
        <Detail label="Portal">
          Student Portal
          {origin ? <span className="block break-all text-xs text-neutral-600">Sign in at {origin}/login</span> : null}
        </Detail>
      </dl>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs uppercase tracking-wide text-emerald-900">Temporary password</p>
        {left ? (
          <p className="text-sm text-neutral-700">No longer shown. Reset their password from their page if it was not saved.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded border border-emerald-200 bg-white px-2 py-1.5 font-mono text-sm text-neutral-900">
              {created.password}
            </code>
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.password);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy password"}
            </Button>
            <span aria-live="polite" className="sr-only">
              {copied ? "Password copied" : ""}
            </span>
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-1 text-sm text-emerald-900">
        <li className="font-medium">
          Save this temporary password securely. It will not be shown on this screen again.
        </li>
        <li>The student should sign in and change this password immediately.</li>
      </ul>

      <div>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-emerald-900/80">{label}</dt>
      <dd className="text-neutral-900">{children}</dd>
    </div>
  );
}
