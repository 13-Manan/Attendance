import type { SessionUser } from "@/modules/auth-tenancy/types";
import { SYSTEM_ROLES } from "@/modules/authorization/permissions";
import { hasPermission } from "@/modules/authorization/service";
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

/**
 * Why a receptionist acting through `staff.manage` alone may not touch an
 * account holding these roles — or null when they may.
 *
 * Teacher accounts only, and only ones that can do nothing the actor cannot:
 * never the principal's, another administrator's, a head of department's or a
 * receptionist's — and never a teacher whose sign-in would carry more than the
 * receptionist was given (a class teacher's student edits, say), because a
 * password they issue is a password they know. Pure, so the page offers only
 * the actions the service will allow.
 */
export function staffManageRefusal(actor: SessionUser, roleKeys: readonly string[]): string | null {
  const teacherRoles: readonly string[] = FACULTY_ROLE_KEYS;
  if (roleKeys.length === 0 || roleKeys.some((key) => !teacherRoles.includes(key))) {
    return "You can manage teacher accounts only. Ask the principal about this one.";
  }
  for (const key of roleKeys) {
    const role = SYSTEM_ROLES.find((r) => r.key === key);
    if (!role || role.permissions.some((permission) => !hasPermission(actor, permission))) {
      return "That account can do things your own account cannot, so only the principal can change it.";
    }
  }
  return null;
}
