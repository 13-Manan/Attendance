// Which list a register was opened from, so its page can lead back there.
//
// A register lives under its class (`/dashboard/attendance/[cohortId]/review/…`)
// and its page leads back to the class. Opened from a list of registers — the
// Sessions page as filtered, a class's history, the overview — it offers the
// way back to that list instead. The list says so with `?returnTo=`, which is
// checked here and rebuilt, never followed as given (see `lib/return-path.ts`).
//
// Pure: no names are loaded. Every label is fixed or comes from the register
// the page has already loaded through its own checks.

import { normalizeSessionFilters } from "@/modules/attendance-analytics/service";
import type { FacultySessionFilters } from "@/modules/attendance-analytics/types";
import { parseReturnPath } from "@/lib/return-path";
import type { BackTarget } from "@/components/nav/trail";

export const SESSIONS_LIST = "/dashboard/attendance/sessions";
const OVERVIEW = "/dashboard";
const HISTORY = "/dashboard/attendance/[cohortId]/history";

/** The Sessions page with these filters, as its own form would address it. */
export function sessionsListPath(filters: FacultySessionFilters): string {
  const params = new URLSearchParams();
  if (filters.today) params.set("today", "1");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.cohortId) params.set("cohortId", filters.cohortId);
  if (filters.cohortSubjectId) params.set("cohortSubjectId", filters.cohortSubjectId);
  if (filters.status) params.set("status", filters.status);
  const query = params.toString();
  return query ? `${SESSIONS_LIST}?${query}` : SESSIONS_LIST;
}

/** A class's attendance history — the list its registers are opened from. */
export function historyPath(cohortId: string): string {
  return `/dashboard/attendance/${encodeURIComponent(cohortId)}/history`;
}

/**
 * The list this register was opened from, or null for its class. A history
 * page counts only for the register's own class: another class's history in
 * the address is not where this register was listed.
 */
export function registerOrigin(value: unknown, cohortId: string): BackTarget | null {
  const match = parseReturnPath(value, [OVERVIEW, SESSIONS_LIST, HISTORY]);
  if (!match) return null;

  if (match.pattern === OVERVIEW) return { label: "Dashboard", href: OVERVIEW };
  if (match.pattern === SESSIONS_LIST) {
    // The Sessions page's own reading of its filters, so nothing it would not
    // accept survives into the link.
    const one = (key: string) => match.query.get(key);
    const filters = normalizeSessionFilters({
      today: one("today"),
      from: one("from"),
      to: one("to"),
      cohortId: one("cohortId"),
      cohortSubjectId: one("cohortSubjectId"),
      status: one("status"),
    });
    return { label: "Sessions", href: sessionsListPath(filters) };
  }
  if (match.params.cohortId !== cohortId) return null;
  return { label: "Attendance history", href: historyPath(cohortId) };
}
