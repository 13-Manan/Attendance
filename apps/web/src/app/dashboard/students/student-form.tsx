"use client";

import { useActionState } from "react";
import {
  createStudentAction,
  updateStudentAction,
  type StudentActionState,
} from "@/modules/students/directory-actions";
import {
  MAX_ADMISSION_NUMBER,
  MAX_STUDENT_CODE,
  MAX_STUDENT_EMAIL,
  MAX_STUDENT_NAME,
  MAX_STUDENT_PHONE,
  STUDENT_STATUSES,
  STUDENT_STATUS_DESCRIPTION,
  STUDENT_STATUS_LABEL,
  type StudentDetail,
  type StudentFormOptions,
} from "@/modules/students/directory-types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const initialState: StudentActionState = {};

/** The `value` an `<input type="date">` wants, from a UTC-midnight Date. */
function dateValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * Admit a student, or edit one.
 *
 * One form for both, because they are the same record and a second copy would
 * be the place a field gets added to only one of them. What differs is named
 * explicitly: a new student has no status to choose — they are on roll by
 * definition — and an existing one is not placed in a class from here, because
 * placement is its own decision with its own permission and lives on the
 * student's record where the current placements are visible.
 *
 * Every field is keyed on `attempt` so a refused submission redisplays what
 * was typed: React resets a form when its action completes, which would
 * otherwise throw a clerk's work away and silently restore the stored values.
 *
 * The institution is not a field. The service reads it from the session, so
 * there is nothing here that a crafted submission could point at another
 * school.
 */
export function StudentForm({
  mode,
  student,
  options,
  canPlace,
  defaultCohortId,
  returnTo,
}: {
  mode: "create" | "edit";
  student?: StudentDetail;
  options: StudentFormOptions;
  /** Whether this administrator may also place the new student in a class. */
  canPlace: boolean;
  /** The class the placement starts on — the section the form was opened from. */
  defaultCohortId?: string;
  /** The section page to go back to once the student is added. Checked again by the action. */
  returnTo?: string;
}) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createStudentAction : updateStudentAction,
    initialState,
  );
  const key = state.attempt ?? 0;
  const values = state.values;

  return (
    <form action={formAction} className="flex w-full max-w-2xl flex-col gap-5">
      {student ? <input type="hidden" name="id" value={student.id} /> : null}
      {mode === "create" && returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Who they are</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="firstName">
            <Input
              key={`firstName-${key}`}
              id="firstName"
              name="firstName"
              required
              autoComplete="off"
              maxLength={MAX_STUDENT_NAME}
              defaultValue={values?.firstName ?? student?.firstName ?? ""}
            />
          </Field>
          <Field label="Last name" htmlFor="lastName">
            <Input
              key={`lastName-${key}`}
              id="lastName"
              name="lastName"
              required
              autoComplete="off"
              maxLength={MAX_STUDENT_NAME}
              defaultValue={values?.lastName ?? student?.lastName ?? ""}
            />
          </Field>
        </div>

        <Field label="Student code" htmlFor="studentCode">
          <Input
            key={`studentCode-${key}`}
            id="studentCode"
            name="studentCode"
            required
            autoComplete="off"
            maxLength={MAX_STUDENT_CODE}
            defaultValue={values?.studentCode ?? student?.studentCode ?? ""}
          />
          <p className="mt-1 text-xs text-neutral-500">
            This institution&apos;s own ID for the student — a roll number, a register number,
            whatever appears on your lists. It has to be unique here.
          </p>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email (optional)" htmlFor="email">
            <Input
              key={`email-${key}`}
              id="email"
              name="email"
              type="email"
              autoComplete="off"
              maxLength={MAX_STUDENT_EMAIL}
              defaultValue={values?.email ?? student?.email ?? ""}
            />
          </Field>
          <Field label="Phone (optional)" htmlFor="phone">
            <Input
              key={`phone-${key}`}
              id="phone"
              name="phone"
              type="tel"
              autoComplete="off"
              maxLength={MAX_STUDENT_PHONE}
              defaultValue={values?.phone ?? student?.phone ?? ""}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <legend className="mb-2 text-sm font-semibold text-neutral-900">Admission</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Admission number (optional)" htmlFor="admissionNumber">
            <Input
              key={`admissionNumber-${key}`}
              id="admissionNumber"
              name="admissionNumber"
              autoComplete="off"
              maxLength={MAX_ADMISSION_NUMBER}
              defaultValue={values?.admissionNumber ?? student?.admissionNumber ?? ""}
            />
          </Field>
          <Field label="Admission date (optional)" htmlFor="admissionDate">
            <Input
              key={`admissionDate-${key}`}
              id="admissionDate"
              name="admissionDate"
              type="date"
              defaultValue={values?.admissionDate ?? dateValue(student?.admissionDate ?? null)}
            />
          </Field>
        </div>
        <p className="text-xs text-neutral-500">
          The number the institution issued at intake, if it issues one. It is kept separate from
          the student code because at some institutions they are the same string and at others
          they have nothing to do with each other.
        </p>
      </fieldset>

      {options.campuses.length > 0 ? (
        <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
          <legend className="mb-2 text-sm font-semibold text-neutral-900">Where they are</legend>
          <Field label="Campus (optional)" htmlFor="campusId">
            <Select
              key={`campusId-${key}`}
              id="campusId"
              name="campusId"
              defaultValue={values?.campusId ?? student?.campusId ?? ""}
            >
              <option value="">No campus</option>
              {options.campuses.map((campus) => (
                <option key={campus.id} value={campus.id}>
                  {campus.name} ({campus.code}){campus.isActive ? "" : " — closed"}
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>
      ) : null}

      {mode === "create" && canPlace ? (
        <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
          <legend className="mb-2 text-sm font-semibold text-neutral-900">Class</legend>
          <Field label="Place in a class (optional)" htmlFor="cohortId">
            <Select
              key={`cohortId-${key}`}
              id="cohortId"
              name="cohortId"
              defaultValue={values?.cohortId ?? defaultCohortId ?? ""}
            >
              <option value="">Not placed yet</option>
              {options.cohorts.map((cohort) => (
                <option key={cohort.id} value={cohort.id}>
                  {cohort.name}
                  {cohort.termLabel ? ` · ${cohort.termLabel}` : ""} — {cohort.academicSessionName}
                  {cohort.academicSessionIsCurrent ? " (current year)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          {options.cohorts.length === 0 ? (
            <p className="text-xs text-amber-700">
              No classes exist yet. The student can be admitted now and placed once a class is set
              up under Academic management.
            </p>
          ) : (
            <p className="text-xs text-neutral-500">
              You can leave this empty and place them later from their record.
            </p>
          )}
        </fieldset>
      ) : null}

      {mode === "edit" ? (
        <fieldset className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
          <legend className="mb-2 text-sm font-semibold text-neutral-900">Status</legend>
          <Field label="Status" htmlFor="status">
            <Select
              key={`status-${key}`}
              id="status"
              name="status"
              defaultValue={values?.status ?? student?.status ?? "ACTIVE"}
            >
              {STUDENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STUDENT_STATUS_LABEL[status]}
                </option>
              ))}
            </Select>
          </Field>
          <ul className="flex flex-col gap-1 text-xs text-neutral-500">
            {STUDENT_STATUSES.map((status) => (
              <li key={status}>
                <span className="font-medium text-neutral-700">
                  {STUDENT_STATUS_LABEL[status]}:
                </span>{" "}
                {STUDENT_STATUS_DESCRIPTION[status]}
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {state.error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? mode === "create"
              ? "Adding…"
              : "Saving…"
            : mode === "create"
              ? "Add student"
              : "Save changes"}
        </Button>
        <p className="text-xs text-neutral-500">
          Recorded in the audit log against your name.
        </p>
      </div>
    </form>
  );
}
