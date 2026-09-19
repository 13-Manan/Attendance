import type { AcademicSession } from "@prisma/client";

export type { AcademicSession };

export const MAX_SESSION_NAME = 100;

/**
 * One academic year, with the two counts a list has to show.
 *
 * `cohortCount` is what makes archiving honest: archiving a year that still
 * has forty classes hanging off it is a different act from archiving an empty
 * one, and the confirmation should be able to say which it is.
 */
export interface AcademicSessionSummary {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  isCurrent: boolean;
  cohortCount: number;
}

/** A refusal an administrator can act on. Never carries an internal detail. */
export class AcademicSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcademicSessionError";
  }
}
