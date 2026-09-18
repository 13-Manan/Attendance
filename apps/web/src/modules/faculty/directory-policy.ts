import {
  FACULTY_ROLE_KEYS,
  FacultyError,
  MAX_EMAIL,
  MAX_EMPLOYEE_CODE,
  MAX_FACULTY_NAME,
  type FacultyRoleKey,
} from "./directory-types";

/**
 * What a staff account is allowed to be, before anything is written.
 *
 * Pure: no Prisma, no session, no randomness. Every refusal is a sentence an
 * administrator can act on, because the person filling in this form is adding
 * a colleague on their first morning and "invalid input" costs somebody a
 * phone call.
 */

export function validateFacultyName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (name === "") throw new FacultyError("Enter the person's name.");
  if (name.length > MAX_FACULTY_NAME) {
    throw new FacultyError(`The name must be ${MAX_FACULTY_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * Normalises and checks an address.
 *
 * Lower-cased because `User.email` is unique and case-sensitive in Postgres:
 * without this, `R.Sharma@…` and `r.sharma@…` are two accounts for one person,
 * and the second one's owner cannot sign in with the address they were given.
 *
 * The shape check is deliberately loose — one `@`, something either side, no
 * whitespace. A stricter regular expression rejects addresses that are valid
 * (`first+tag@`, a long TLD, a subdomain per department), and the thing that
 * actually proves an address works is sending to it, which this build does not
 * do.
 */
export function validateFacultyEmail(raw: unknown): string {
  const email = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (email === "") throw new FacultyError("Enter a work email address.");
  if (email.length > MAX_EMAIL) {
    throw new FacultyError(`The email address must be ${MAX_EMAIL} characters or fewer.`);
  }
  if (/\s/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new FacultyError(`"${email}" does not look like an email address.`);
  }
  return email;
}

/** Optional. An empty box means "no code", stored as null rather than "". */
export function validateEmployeeCode(raw: unknown): string | null {
  const code = String(raw ?? "").trim();
  if (code === "") return null;
  if (code.length > MAX_EMPLOYEE_CODE) {
    throw new FacultyError(`The employee code must be ${MAX_EMPLOYEE_CODE} characters or fewer.`);
  }
  return code;
}

/**
 * The role being granted.
 *
 * Refused rather than defaulted if it is not one of the three this screen
 * offers. A form that quietly fell back to FACULTY when handed an unexpected
 * value would be a form through which a crafted request could ask for
 * something else and get a working account anyway.
 */
export function validateFacultyRole(raw: unknown): FacultyRoleKey {
  const key = String(raw ?? "").trim();
  if ((FACULTY_ROLE_KEYS as readonly string[]).includes(key)) return key as FacultyRoleKey;
  throw new FacultyError(
    `"${key}" is not a role that can be granted here. Choose one of: ${FACULTY_ROLE_KEYS.join(", ")}.`,
  );
}
