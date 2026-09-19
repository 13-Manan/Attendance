import type { CampusSummary } from "./types";

/**
 * Search and filtering for the campus list.
 *
 * Pure, and applied in memory rather than in the `where` clause — which is the
 * opposite of what the audit log does, for a reason worth stating. The audit
 * log is unbounded and filtering it in memory would mean fetching megabytes to
 * show fifty rows. A campus list is the branches an institution operates from:
 * a handful, occasionally a few dozen, and `listCampusSummaries` already reads
 * all of them to compute the attached counts. Narrowing in SQL would add a
 * round trip and a `mode: "insensitive"` clause to filter a list that is
 * already in hand.
 *
 * There is no pagination here for the same reason. A pager over eleven rows is
 * furniture; if an institution ever has enough campuses for one, the counts
 * query has to change too and both should change together.
 */

export type CampusStatusFilter = "" | "open" | "closed";

export interface CampusListFilters {
  /** Free text, matched against name, code and address. */
  q: string;
  status: CampusStatusFilter;
}

function first(value: string | string[] | undefined): string {
  // A repeated parameter (?q=a&q=b) is a bookmark artefact. Taking the first is
  // better than searching for the literal string "a,b".
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return "";
}

export function parseCampusFilters(
  params: Record<string, string | string[] | undefined>,
): CampusListFilters {
  const status = first(params.status);
  return {
    q: first(params.q).trim(),
    // An unrecognised value falls back to "every campus" rather than to an
    // empty list: a mistyped URL should show too much, not too little.
    status: status === "open" || status === "closed" ? status : "",
  };
}

export function hasActiveCampusFilters(filters: CampusListFilters): boolean {
  return filters.q !== "" || filters.status !== "";
}

/**
 * Matching is case-insensitive and substring-based across the three fields a
 * person might search by. `toLowerCase` rather than `localeCompare`: this is a
 * contains test, not an ordering, and the codes are already upper-cased Latin.
 */
export function applyCampusFilters(
  campuses: CampusSummary[],
  filters: CampusListFilters,
): CampusSummary[] {
  const needle = filters.q.toLowerCase();

  return campuses.filter((campus) => {
    if (filters.status === "open" && !campus.isActive) return false;
    if (filters.status === "closed" && campus.isActive) return false;
    if (needle === "") return true;

    return (
      campus.name.toLowerCase().includes(needle) ||
      campus.code.toLowerCase().includes(needle) ||
      (campus.address ?? "").toLowerCase().includes(needle)
    );
  });
}
