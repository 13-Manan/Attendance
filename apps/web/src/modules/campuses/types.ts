/**
 * Campuses: the branches an institution actually operates from.
 *
 * `Campus` has existed in the schema since the foundation phase and is
 * referenced — nullably — by `User`, `Student`, `AcademicUnit` and
 * `UserRoleAssignment`. What has not existed until now is any way to create
 * one, which made `campus.manage` a permission nobody could exercise and made
 * `UserRoleAssignment.campusId` a narrowing nobody could apply.
 *
 * ## Why a campus is closed and never deleted
 *
 * Deleting one would orphan, or refuse to orphan, four kinds of row that point
 * at it — including staff role assignments and past students. A school that
 * shuts a branch still has last year's registers from it, and those registers
 * have to keep saying where they were taken. So the only removal offered is
 * closure: the row stays, `isActive` goes false, and every screen that offers
 * a campus to pick stops offering that one.
 */

export type { Campus } from "@prisma/client";

export const MAX_CAMPUS_NAME = 120;
export const MAX_CAMPUS_CODE = 32;
export const MAX_CAMPUS_ADDRESS = 500;

/**
 * A campus plus what would be affected by closing it.
 *
 * The counts are the whole reason this shape exists rather than the bare row:
 * "Close this campus" and "Close this campus — 412 students and 23 staff are
 * assigned to it" are the same click and very different decisions.
 */
export interface CampusSummary {
  id: string;
  name: string;
  code: string;
  address: string | null;
  isActive: boolean;
  createdAt: Date;
  studentCount: number;
  staffCount: number;
  academicUnitCount: number;
}

/** A refusal an administrator can act on. Never carries an internal detail. */
export class CampusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampusError";
  }
}
