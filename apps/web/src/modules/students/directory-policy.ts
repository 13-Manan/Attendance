import {
  MAX_ADMISSION_NUMBER,
  MAX_STUDENT_CODE,
  MAX_STUDENT_EMAIL,
  MAX_STUDENT_NAME,
  MAX_STUDENT_PHONE,
  STUDENT_STATUSES,
  StudentError,
  type StudentStatus,
} from "./directory-types";

/**
 * What a student record is allowed to be, before anything is written.
 *
 * Pure: no Prisma, no session, no clock except the one that is passed in. Every
 * refusal is a sentence a clerk can act on, because the person filling this
 * form in is admitting a child with a parent standing at the desk, and
 * "validation failed" costs somebody a second trip.
 *
 * Nothing here is normalised beyond trimming and the one case that has to be
 * (email). A student code, an admission number and a name are the
 * institution's own strings; rewriting their case would make the record
 * disagree with the paper register it was copied from.
 */

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function validateStudentName(raw: unknown, field: "first name" | "last name"): string {
  const name = text(raw);
  if (name === "") throw new StudentError(`Enter the student's ${field}.`);
  if (name.length > MAX_STUDENT_NAME) {
    throw new StudentError(`The ${field} must be ${MAX_STUDENT_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * The institution's handle for this record.
 *
 * Required and unique per institution — that uniqueness is a database
 * constraint (`@@unique([institutionId, studentCode])`), and the service checks
 * for a clash first only so the clerk gets a sentence naming the other student
 * instead of a constraint violation.
 */
export function validateStudentCode(raw: unknown): string {
  const code = text(raw);
  if (code === "") throw new StudentError("Enter a student code — the institution's own ID for this student.");
  if (code.length > MAX_STUDENT_CODE) {
    throw new StudentError(`The student code must be ${MAX_STUDENT_CODE} characters or fewer.`);
  }
  return code;
}

/**
 * Optional. An empty box means "not on file", stored as null rather than "".
 *
 * Lower-cased, unlike every other field here, because an address is compared
 * and sent to rather than read back: `R.Sharma@…` and `r.sharma@…` are one
 * inbox, and storing both makes two students look like two people to anything
 * that matches on it later.
 *
 * The shape check is loose on purpose — one `@`, something either side, a dot
 * after it, no whitespace. Stricter patterns reject addresses that work
 * (`first+tag@`, long TLDs, per-department subdomains) and the only thing that
 * proves an address is real is sending to it, which this build does not do.
 */
export function validateStudentEmail(raw: unknown): string | null {
  const email = text(raw).toLowerCase();
  if (email === "") return null;
  if (email.length > MAX_STUDENT_EMAIL) {
    throw new StudentError(`The email address must be ${MAX_STUDENT_EMAIL} characters or fewer.`);
  }
  if (/\s/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new StudentError(`"${email}" does not look like an email address.`);
  }
  return email;
}

/**
 * Optional, and deliberately permissive about punctuation.
 *
 * A guardian's number arrives written a dozen ways — `+91 98765 43210`,
 * `098765-43210`, `(022) 2345 6789` — and all of them are the same fact. What
 * is refused is a value with no number in it at all, or one too short to dial,
 * because that is somebody typing a note into the wrong box.
 */
export function validateStudentPhone(raw: unknown): string | null {
  const phone = text(raw);
  if (phone === "") return null;
  if (phone.length > MAX_STUDENT_PHONE) {
    throw new StudentError(`The phone number must be ${MAX_STUDENT_PHONE} characters or fewer.`);
  }
  if (/[A-Za-z]/.test(phone)) {
    throw new StudentError(`"${phone}" does not look like a phone number.`);
  }
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) {
    throw new StudentError(`"${phone}" is too short to be a phone number.`);
  }
  return phone;
}

/**
 * Optional, and not unique.
 *
 * The schema says why: a re-admission legitimately reuses a number at some
 * institutions, and a constraint that stops a clerk recording what the register
 * says is a constraint that gets worked around with a made-up value.
 */
export function validateAdmissionNumber(raw: unknown): string | null {
  const number = text(raw);
  if (number === "") return null;
  if (number.length > MAX_ADMISSION_NUMBER) {
    throw new StudentError(
      `The admission number must be ${MAX_ADMISSION_NUMBER} characters or fewer.`,
    );
  }
  return number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST_ADMISSION_YEAR = 1900;
const FUTURE_ADMISSION_YEARS = 2;

/**
 * The day this student was admitted, as the calendar day that was typed.
 *
 * `Date.UTC`, not `new Date(text)` with a local reading: west of Greenwich the
 * latter stores the day before, and an admission date that is one day out on
 * every record is the kind of bug nobody believes until it is demonstrated
 * against a transfer certificate.
 *
 * `Date.UTC` also rolls 31 February forward into March rather than refusing it,
 * so the parsed value is formatted back and compared to the input.
 *
 * Both ends are bounded. A year before 1900 and a year more than two ahead are
 * both typos — the second is the one that matters, because "sort by newest
 * admission" would put a mistyped 2206 at the top of the list for the lifetime
 * of the record.
 */
export function parseAdmissionDate(raw: unknown, now: Date = new Date()): Date | null {
  const value = text(raw);
  if (value === "") return null;

  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new StudentError(`"${value}" is not a date. Use the date picker, or type 2026-06-01.`);
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new StudentError(`There is no such date as ${value}.`);
  }

  if (date.getUTCFullYear() < EARLIEST_ADMISSION_YEAR) {
    throw new StudentError(`An admission date in ${year} is a typo — check the year.`);
  }
  const latestYear = now.getUTCFullYear() + FUTURE_ADMISSION_YEARS;
  if (date.getUTCFullYear() > latestYear) {
    throw new StudentError(
      `An admission date in ${year} is more than ${FUTURE_ADMISSION_YEARS} years away — check the year.`,
    );
  }

  return date;
}

/**
 * The status being set.
 *
 * Refused rather than defaulted when it is not one of the four. A form that
 * quietly fell back to ACTIVE when handed something unexpected would be a form
 * through which a crafted request could put a student who has left back on
 * every class list.
 */
export function validateStudentStatus(raw: unknown): StudentStatus {
  const status = text(raw).toUpperCase();
  if ((STUDENT_STATUSES as readonly string[]).includes(status)) return status as StudentStatus;
  throw new StudentError(
    `"${text(raw)}" is not a student status. Choose one of: ${STUDENT_STATUSES.join(", ")}.`,
  );
}

/**
 * An optional reference to another row — a campus, a class.
 *
 * Empty means "none", which is a real answer for both: an institution with one
 * site has no campuses, and a student admitted today may not be placed in a
 * class until next week. That the id names a row in *this* institution is not
 * checked here — it cannot be, without a database — and is checked in the
 * service before anything is written.
 */
export function optionalId(raw: unknown): string | null {
  const id = text(raw);
  return id === "" ? null : id;
}
