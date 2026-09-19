import type { AcademicUnitLabels, Institution } from "@/modules/institutions/types";

/**
 * The institution's own profile: who it is, where it is, how to reach it, and
 * what it calls the parts of itself.
 *
 * ## Why this is a separate module from `admin-settings`
 *
 * `admin-settings` configures how the software *behaves* — recognition
 * thresholds, correction windows, retention. Everything here is a fact about
 * the tenant: its name, its time zone, the number a parent rings. Changing a
 * threshold can alter tomorrow's attendance; changing the phone number cannot.
 * Keeping them apart is what lets the audit trail say which kind of change
 * somebody made, and it is the same reason the contact columns are columns
 * rather than keys inside `settings` (see `schema.prisma`).
 *
 * The one exception is the academic-unit labels, which live in `settings` and
 * are edited here. They are vocabulary, not behaviour — nothing branches on
 * them — and an administrator looking for "what do we call a Section" looks at
 * the institution's profile, not at its attendance policy.
 */

export type { Institution };

export const MAX_INSTITUTION_NAME = 200;
export const MAX_CONTACT_EMAIL = 200;
export const MAX_CONTACT_PHONE = 40;
export const MAX_ADDRESS_LINE = 500;
export const MAX_UNIT_LABEL = 40;

/** Everything the profile screen shows, already resolved. */
export interface InstitutionProfile {
  id: string;
  name: string;
  /** Read-only here. See the note on `updateInstitutionProfileForRequest`. */
  type: Institution["type"];
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine: string | null;
  /** Defaults merged with whatever this institution overrode. */
  academicUnitLabels: AcademicUnitLabels;
}

/**
 * The form field one academic-unit label is edited in.
 *
 * Here rather than in `actions.ts` because every export of a `"use server"`
 * module has to be an async Server Action — a plain helper exported from one
 * is a build error. Shared so the form that writes the field and the action
 * that reads it cannot drift apart.
 */
export function labelField(key: string): string {
  return `label_${key}`;
}

/** A refusal an administrator can act on. Never carries an internal detail. */
export class InstitutionProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstitutionProfileError";
  }
}
