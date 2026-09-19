import { CohortError, MAX_COHORT_NAME, MAX_TERM_LABEL } from "./directory-types";

/**
 * What a class is allowed to be, before anything is written.
 *
 * Pure: no Prisma, no session. Every refusal is a sentence somebody can act on.
 *
 * Nothing is normalised beyond trimming. "8-A", "8 A" and "VIII A" are three
 * different institutions' way of writing the same class, and rewriting any of
 * them would make the screen disagree with the timetable on the wall.
 */

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function validateCohortName(raw: unknown): string {
  const name = text(raw);
  if (name === "") {
    throw new CohortError("Enter a name — what this class is called on the timetable, like “8-A”.");
  }
  if (name.length > MAX_COHORT_NAME) {
    throw new CohortError(`The name must be ${MAX_COHORT_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * Optional. The part of the year this class runs in — "Term 1", "Semester 3".
 *
 * An empty box means "the whole year", stored as null rather than "": a blank
 * string would read as a term whose name nobody filled in.
 */
export function validateTermLabel(raw: unknown): string | null {
  const label = text(raw);
  if (label === "") return null;
  if (label.length > MAX_TERM_LABEL) {
    throw new CohortError(`The term must be ${MAX_TERM_LABEL} characters or fewer.`);
  }
  return label;
}

/**
 * A required id from a form.
 *
 * That it names a row in *this* institution cannot be known without a database
 * and is checked in the service, before anything is written.
 */
export function requiredId(raw: unknown, message: string): string {
  const id = text(raw);
  if (id === "") throw new CohortError(message);
  return id;
}

/** An optional id. "" is a cleared dropdown, which is not the same as an id. */
export function optionalId(raw: unknown): string | null {
  const id = text(raw);
  return id === "" ? null : id;
}
