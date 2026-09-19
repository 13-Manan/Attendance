import {
  CampusError,
  MAX_CAMPUS_ADDRESS,
  MAX_CAMPUS_CODE,
  MAX_CAMPUS_NAME,
} from "./types";

/**
 * What a campus is allowed to be, before anything is written.
 *
 * Pure: no Prisma, no session. Every refusal is a sentence an administrator
 * can act on, in the same style as `modules/faculty/directory-policy.ts` —
 * "invalid input" on a form somebody is filling in during an onboarding call
 * costs a phone call.
 */

export function validateCampusName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (name === "") throw new CampusError("Enter a name for the campus.");
  if (name.length > MAX_CAMPUS_NAME) {
    throw new CampusError(`The name must be ${MAX_CAMPUS_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * The short handle for a campus, e.g. `MAIN` or `NORTH`.
 *
 * Upper-cased and restricted to letters, digits, hyphen and underscore, for
 * one reason that is not cosmetic: the code is half of
 * `@@unique([institutionId, code])`. Postgres compares text case-sensitively,
 * so without normalising, `north` and `North` are two campuses whose
 * difference nobody can see in a list — and a timetable import keyed on the
 * code would then attach students to whichever one it happened to match.
 *
 * Spaces are refused rather than stripped. Silently turning "North Campus"
 * into "NORTHCAMPUS" produces a code the administrator did not choose and will
 * not recognise when an integration rejects it.
 */
export function validateCampusCode(raw: unknown): string {
  const code = String(raw ?? "").trim().toUpperCase();
  if (code === "") throw new CampusError("Enter a short code for the campus, e.g. MAIN.");
  if (code.length > MAX_CAMPUS_CODE) {
    throw new CampusError(`The code must be ${MAX_CAMPUS_CODE} characters or fewer.`);
  }
  if (!/^[A-Z0-9_-]+$/.test(code)) {
    throw new CampusError(
      "A campus code can contain letters, numbers, hyphens and underscores — no spaces or punctuation.",
    );
  }
  return code;
}

/** Optional. An empty box means "no address on file", stored as null not "". */
export function validateCampusAddress(raw: unknown): string | null {
  const address = String(raw ?? "").trim();
  if (address === "") return null;
  if (address.length > MAX_CAMPUS_ADDRESS) {
    throw new CampusError(`The address must be ${MAX_CAMPUS_ADDRESS} characters or fewer.`);
  }
  return address;
}
