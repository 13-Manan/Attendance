import { AcademicSessionError, MAX_SESSION_NAME } from "./types";

/**
 * What an academic year is allowed to be.
 *
 * Pure: no Prisma, no session, no clock except where a rule genuinely needs
 * one, and then it is passed in. Every refusal is a sentence an administrator
 * can act on.
 */

export function validateSessionName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (name === "") {
    throw new AcademicSessionError("Give the academic year a name, for example 2026-27.");
  }
  if (name.length > MAX_SESSION_NAME) {
    throw new AcademicSessionError(`The name must be ${MAX_SESSION_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * A date from a `<input type="date">`, read as a plain calendar day.
 *
 * Built at UTC midnight rather than through `new Date("2026-06-01")`'s local
 * interpretation, because the two differ by a day west of Greenwich and an
 * academic year that starts "31 May" in the database and "1 June" on the form
 * is the kind of bug nobody believes until it is demonstrated.
 */
export function parseSessionDate(raw: unknown, field: string): Date {
  const text = String(raw ?? "").trim();
  if (text === "") throw new AcademicSessionError(`Enter the ${field}.`);

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new AcademicSessionError(`The ${field} must be a date, for example 2026-06-01.`);

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    // `Date.UTC` rolls 31 February forward into March rather than refusing it.
    throw new AcademicSessionError(`${text} is not a real date.`);
  }
  return date;
}

/**
 * The year has to end after it starts.
 *
 * Nothing checks that it is roughly a year long, or that it does not overlap
 * the year before it: institutions really do run a nine-month year, a two-year
 * programme and a summer term that overlaps both, and a system that refused
 * them would be refusing the truth.
 */
export function validateDateRange(startDate: Date, endDate: Date): void {
  if (endDate.getTime() <= startDate.getTime()) {
    throw new AcademicSessionError("The end date must be after the start date.");
  }
}

/**
 * The single word a list shows for a year's state.
 *
 * Three states, not two: the one year that is current, an archived year, and
 * an open year that is simply not the current one — next year already set up,
 * or last year left un-archived. Naming the third is the whole reason
 * `isCurrent` exists as a column of its own rather than being read off
 * `isActive`.
 *
 * "Open" is deliberately not called "upcoming": the system does not know that
 * it is in the future, only that nobody has archived it.
 */
export type AcademicSessionState = "current" | "open" | "archived";

export function sessionState(session: {
  isActive: boolean;
  isCurrent: boolean;
}): AcademicSessionState {
  if (!session.isActive) return "archived";
  return session.isCurrent ? "current" : "open";
}

export const SESSION_STATE_LABEL: Record<AcademicSessionState, string> = {
  current: "Current year",
  open: "Not current",
  archived: "Archived",
};
