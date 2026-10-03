import type { SessionUser } from "@/modules/auth-tenancy/types";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { hasPermission } from "@/modules/authorization/service";
import { FacultyError } from "@/modules/faculty/directory-types";
import { validateFacultyEmail, validateFacultyName } from "@/modules/faculty/directory-policy";
import { NARROWED_FROM, NEVER_GRANTABLE, permissionsFor, resolveAccess } from "./catalog";
import { ReceptionistError } from "./types";

/**
 * The rules, before anything is written. Pure: no Prisma, no session lookup.
 */

export const MAX_PHONE = 32;

/** The same name rule as a teacher's, in this module's error. */
export function validateReceptionistName(raw: unknown): string {
  try {
    return validateFacultyName(raw);
  } catch (error) {
    if (error instanceof FacultyError) throw new ReceptionistError(error.message);
    throw error;
  }
}

/** Lower-cased, as every account's: `User.email` is unique and case-sensitive. */
export function validateReceptionistEmail(raw: unknown): string {
  try {
    return validateFacultyEmail(raw);
  } catch (error) {
    if (error instanceof FacultyError) throw new ReceptionistError(error.message.replace("work email", "school email"));
    throw error;
  }
}

/** Optional. Digits with the usual separators; an empty box means none. */
export function validateReceptionistPhone(raw: unknown): string | null {
  const phone = String(raw ?? "").trim();
  if (phone === "") return null;
  if (phone.length > MAX_PHONE || !/^\+?[0-9 ()\-.]+$/.test(phone)) {
    throw new ReceptionistError("Enter the phone number using digits, spaces, + or -.");
  }
  const digits = phone.replace(/\D/g, "").length;
  if (digits < 6 || digits > 15) throw new ReceptionistError("That phone number has too few or too many digits.");
  return phone;
}

/**
 * Whether this person may grant a permission: they hold it, or they hold the
 * broader keys it is a slice of (an administrator holds `user.invite`, not the
 * receptionist's `studentLogin.manage`). Never a key on the never list.
 */
export function mayGrant(actor: SessionUser, key: PermissionKey): boolean {
  if (NEVER_GRANTABLE.has(key)) return false;
  if (hasPermission(actor, key)) return true;
  const broader = NARROWED_FROM[key];
  return broader !== undefined && broader.every((parent) => hasPermission(actor, parent));
}

/**
 * The switches as they will be saved, and the keys they grant — or a refusal.
 *
 * Unknown switches are dropped and each switch's dependencies added
 * (`resolveAccess`); then every key must be one the principal may grant. The
 * request never carries keys of its own: what it can ask for is the catalogue.
 */
export function grantableAccess(
  actor: SessionUser,
  requested: readonly string[],
): { access: string[]; permissions: PermissionKey[] } {
  const access = resolveAccess(requested);
  const permissions = permissionsFor(access);
  const refused = permissions.filter((key) => !mayGrant(actor, key));
  if (refused.length > 0) {
    throw new ReceptionistError(
      "You can only give access you have yourself. Ask the platform administrator if something is missing.",
    );
  }
  return { access, permissions };
}
