/**
 * The administrator-facing shapes for subjects.
 *
 * A subject is a college concept: a school takes one register a day for a
 * class, a college takes one per subject per session. So these rows carry the
 * number of classes that actually offer the subject — the difference between
 * "rename this" and "nobody has ever taught this".
 */

export const MAX_SUBJECT_CODE = 40;
export const MAX_SUBJECT_NAME = 160;

export interface SubjectRow {
  id: string;
  code: string;
  name: string;
  createdAt: Date;
  /** Classes offering it, across every academic year. */
  cohortCount: number;
}

export interface SubjectPage {
  rows: SubjectRow[];
  /** Matching the current search. */
  total: number;
  /** In the institution, ignoring the search — so an empty result can say so. */
  totalAll: number;
  /** Offered by no class at all. */
  unusedAll: number;
  page: number;
  pageCount: number;
  pageSize: number;
}

/** A refusal an administrator is meant to read, as opposed to a bug. */
export class SubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubjectError";
  }
}
