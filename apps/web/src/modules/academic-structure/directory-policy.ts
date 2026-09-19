import type { AcademicUnitKind } from "@prisma/client";
import {
  AcademicStructureError,
  MAX_SORT_ORDER,
  MAX_UNIT_CODE,
  MAX_UNIT_NAME,
} from "./directory-types";

/**
 * What a part of the academic structure is allowed to be.
 *
 * Pure: no Prisma, no session. Every refusal is a sentence somebody can act on.
 *
 * Nothing is normalised beyond trimming. "B.Tech CSE", "BTech-CSE" and "CSE"
 * are three institutions' way of writing the same department, and rewriting any
 * of them would make the screen disagree with the prospectus.
 */

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function validateUnitName(raw: unknown): string {
  const name = text(raw);
  if (name === "") {
    throw new AcademicStructureError("Enter a name — what this is called on your own lists.");
  }
  if (name.length > MAX_UNIT_NAME) {
    throw new AcademicStructureError(`The name must be ${MAX_UNIT_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * Optional. The institution's short form — "CSE", "VIII".
 *
 * An empty box is null rather than "": a blank string would read as a code
 * nobody filled in, and the screens print a code whenever one exists.
 */
export function validateUnitCode(raw: unknown): string | null {
  const code = text(raw);
  if (code === "") return null;
  if (code.length > MAX_UNIT_CODE) {
    throw new AcademicStructureError(`The code must be ${MAX_UNIT_CODE} characters or fewer.`);
  }
  return code;
}

/**
 * Which kind of thing this is, checked against what the institution may have.
 *
 * A school has no semesters and a college has no grades. The same check exists
 * in `service.ts`, which is where the guarantee lives — it reads the type from
 * the database rather than from a form. This one exists so the refusal is a
 * sentence rather than `invalid_kind_for_institution_type:SEMESTER/SCHOOL`.
 */
export function validateKind(
  raw: unknown,
  allowed: readonly AcademicUnitKind[],
): AcademicUnitKind {
  const kind = text(raw);
  if (kind === "") throw new AcademicStructureError("Choose what kind of thing this is.");
  const match = allowed.find((candidate) => candidate === kind);
  if (!match) {
    throw new AcademicStructureError("That is not something this institution's structure can hold.");
  }
  return match;
}

/**
 * Where it sits in the list, as a hand-typed number.
 *
 * Empty is 0, which puts it first and is what somebody who does not care about
 * ordering means. A negative or fractional value is refused rather than
 * rounded: silently turning "1.5" into 1 would leave two units claiming the
 * same position and no way to tell why the order looks wrong.
 */
export function validateSortOrder(raw: unknown): number {
  const value = text(raw);
  if (value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SORT_ORDER) {
    throw new AcademicStructureError(
      `The order must be a whole number between 0 and ${MAX_SORT_ORDER}.`,
    );
  }
  return parsed;
}

/** An optional id. "" is a cleared dropdown, which is not the same as an id. */
export function optionalId(raw: unknown): string | null {
  const id = text(raw);
  return id === "" ? null : id;
}
