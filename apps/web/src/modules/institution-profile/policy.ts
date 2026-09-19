import {
  ACADEMIC_UNIT_LABEL_KEYS,
  DEFAULT_ACADEMIC_UNIT_LABELS,
  type AcademicUnitLabels,
} from "@/modules/institutions/types";
import {
  InstitutionProfileError,
  MAX_ADDRESS_LINE,
  MAX_CONTACT_EMAIL,
  MAX_CONTACT_PHONE,
  MAX_INSTITUTION_NAME,
  MAX_UNIT_LABEL,
} from "./types";

/**
 * What an institution's profile is allowed to be.
 *
 * Pure: no Prisma, no session, no clock. Every refusal is a sentence an
 * administrator can act on — the person filling this in is usually setting the
 * product up on their first morning, and "invalid input" costs somebody a
 * phone call.
 */

export function validateInstitutionName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (name === "") throw new InstitutionProfileError("Enter the institution's name.");
  if (name.length > MAX_INSTITUTION_NAME) {
    throw new InstitutionProfileError(
      `The name must be ${MAX_INSTITUTION_NAME} characters or fewer.`,
    );
  }
  return name;
}

/**
 * A named IANA time zone, checked against the runtime's own zone database
 * rather than against a list this codebase maintains.
 *
 * `Intl.DateTimeFormat` throws a RangeError for a zone it does not know, which
 * makes the platform the authority — a list hard-coded here would go stale the
 * next time a country changed its rules. The zone is not decorative: it is the
 * answer to "which day is this register for" at an institution whose evening
 * classes run past midnight UTC.
 *
 * ## Why a bare offset is refused even though `Intl` accepts it
 *
 * "+05:30" is a valid argument to `Intl.DateTimeFormat`, and it is exactly the
 * wrong thing to store. An offset is a fact about one moment; a zone is a rule.
 * An institution that recorded "-05:00" would silently file an hour of
 * registers against the wrong day the first spring after daylight saving
 * started, and nothing in the product would look broken. Named zones follow
 * the rules; offsets cannot.
 *
 * The value is not rewritten. `Asia/Kolkata` and `Asia/Calcutta` are the same
 * zone under two names, and this build's ICU canonicalises the first to the
 * second — normalising would hand an Indian administrator back a spelling
 * their own government stopped using in 1995.
 */
export function validateTimezone(raw: unknown): string {
  const timezone = String(raw ?? "").trim();
  if (timezone === "") {
    throw new InstitutionProfileError("Choose a time zone, for example Asia/Kolkata.");
  }
  if (/^[+-]/.test(timezone)) {
    throw new InstitutionProfileError(
      `"${timezone}" is a fixed offset, not a time zone. An offset cannot follow daylight saving, ` +
        "so registers would land on the wrong day when the clocks change. Choose a named zone such as Asia/Kolkata.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new InstitutionProfileError(
      `"${timezone}" is not a time zone this system recognises. Use an IANA name such as Asia/Kolkata.`,
    );
  }
  return timezone;
}

/**
 * The zones the profile form offers, current one first.
 *
 * `Intl.supportedValuesOf` is the canonical list this runtime knows, and it
 * deliberately omits both "UTC" — the column default, so every institution
 * that has never set a zone is on it — and any alias an existing row might
 * hold. Prepending the stored value is what keeps the form from silently
 * proposing a change to an institution that simply opened the page.
 */
export function listTimezoneOptions(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  const seen = new Set<string>();
  const options: string[] = [];
  for (const zone of [current, "UTC", ...zones]) {
    if (zone === "" || seen.has(zone)) continue;
    seen.add(zone);
    options.push(zone);
  }
  return options;
}

/**
 * Optional. An empty box means "not on file", stored as null rather than "" so
 * there is one representation of absence rather than two that render alike.
 *
 * The shape check is deliberately loose, for the reason written out in
 * `modules/faculty/directory-policy.ts`: a stricter expression rejects
 * addresses that are valid, and the only thing that proves an address works is
 * sending to it.
 */
export function validateContactEmail(raw: unknown): string | null {
  const email = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (email === "") return null;
  if (email.length > MAX_CONTACT_EMAIL) {
    throw new InstitutionProfileError(
      `The contact email must be ${MAX_CONTACT_EMAIL} characters or fewer.`,
    );
  }
  if (/\s/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new InstitutionProfileError(`"${email}" does not look like an email address.`);
  }
  return email;
}

/**
 * Optional, and kept as typed apart from trimming.
 *
 * Not normalised into a canonical form: this is a number a parent dials, and
 * institutions write it with the spacing, country code and extension their own
 * stationery uses. Rewriting it would hand back a number the administrator did
 * not enter. The check is only that it could be dialled — digits, and the
 * punctuation people put between them.
 */
export function validateContactPhone(raw: unknown): string | null {
  const phone = String(raw ?? "").trim();
  if (phone === "") return null;
  if (phone.length > MAX_CONTACT_PHONE) {
    throw new InstitutionProfileError(
      `The contact number must be ${MAX_CONTACT_PHONE} characters or fewer.`,
    );
  }
  if (!/\d/.test(phone) || !/^[0-9+\-() .]+$/.test(phone)) {
    throw new InstitutionProfileError(
      `"${phone}" does not look like a phone number. Digits, spaces, +, -, ( ) and . only.`,
    );
  }
  return phone;
}

/** Optional. Newlines are kept — a postal address is several lines. */
export function validateAddressLine(raw: unknown): string | null {
  const address = String(raw ?? "").trim();
  if (address === "") return null;
  if (address.length > MAX_ADDRESS_LINE) {
    throw new InstitutionProfileError(
      `The address must be ${MAX_ADDRESS_LINE} characters or fewer.`,
    );
  }
  return address;
}

/**
 * The six words this institution uses for the parts of itself.
 *
 * Two properties worth stating:
 *
 * - **A blank box restores the default**, it does not blank the label. There is
 *   no useful institution in which a Section is called nothing, so an empty
 *   field can only mean "use the standard word".
 * - **A label equal to the default is not stored.** Otherwise every institution
 *   that opened the form and pressed Save would carry six redundant overrides,
 *   and a future change to the shipped wording would silently miss them all.
 */
export function validateAcademicUnitLabels(raw: unknown): Partial<AcademicUnitLabels> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const overrides: Partial<AcademicUnitLabels> = {};

  for (const key of ACADEMIC_UNIT_LABEL_KEYS) {
    const label = String(input[key] ?? "").trim();
    if (label === "") continue;
    if (label.length > MAX_UNIT_LABEL) {
      throw new InstitutionProfileError(
        `The word for ${DEFAULT_ACADEMIC_UNIT_LABELS[key]} must be ${MAX_UNIT_LABEL} characters or fewer.`,
      );
    }
    if (label === DEFAULT_ACADEMIC_UNIT_LABELS[key]) continue;
    overrides[key] = label;
  }

  return overrides;
}

/** Defaults, overlaid with whatever this institution stored. */
export function resolveLabels(stored: unknown): AcademicUnitLabels {
  const overrides =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Partial<AcademicUnitLabels>)
      : {};
  return { ...DEFAULT_ACADEMIC_UNIT_LABELS, ...overrides };
}
