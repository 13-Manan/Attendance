import { STUDENT_STATUSES, type StudentStatus } from "./directory-types";

/**
 * Search, sorting and pagination for the student directory.
 *
 * Pure — no Prisma, no session, no clock — and it produces a `where` and an
 * `orderBy` for the repository to hand straight to the database rather than
 * filtering rows in memory.
 *
 * That is the opposite of what the campus list does, deliberately. A campus
 * list is a handful of rows that are already in hand; the student directory is
 * the one list in this product that genuinely grows, and a school with four
 * thousand students on roll cannot have every one of them read into a Node
 * process to render twenty-five. Everything here narrows in SQL and the page
 * only ever holds one page.
 *
 * The tenancy guarantee lives in `buildStudentWhere`: `institutionId` is a
 * required first argument and is always written into the `where`, so there is
 * no combination of query-string values that produces a filter without it.
 */

export const STUDENT_PAGE_SIZE = 25;

/** "Not in any class", as a value the class dropdown can carry. */
export const NO_COHORT = "none";
/** "Not attached to a campus". */
export const NO_CAMPUS = "none";

export const STUDENT_SORTS = [
  { key: "name", label: "Name (A–Z)" },
  { key: "name_desc", label: "Name (Z–A)" },
  { key: "code", label: "Student code (A–Z)" },
  { key: "code_desc", label: "Student code (Z–A)" },
  { key: "admitted_new", label: "Admitted (newest first)" },
  { key: "admitted_old", label: "Admitted (oldest first)" },
  { key: "added_new", label: "Recently added" },
] as const;

export type StudentSortKey = (typeof STUDENT_SORTS)[number]["key"];

export const DEFAULT_STUDENT_SORT: StudentSortKey = "name";

export interface StudentFilters {
  /** Free text, matched against name, code, email and admission number. */
  q: string;
  /** Exact status. Empty means every status, archived ones included. */
  status: "" | StudentStatus;
  /** A cohort id, `NO_COHORT`, or empty for any. */
  cohortId: string;
  /** A campus id, `NO_CAMPUS`, or empty for any. */
  campusId: string;
  sort: StudentSortKey;
  page: number;
}

export const EMPTY_STUDENT_FILTERS: StudentFilters = {
  q: "",
  status: "",
  cohortId: "",
  campusId: "",
  sort: DEFAULT_STUDENT_SORT,
  page: 1,
};

function first(value: string | string[] | undefined): string {
  // A repeated parameter (?q=a&q=b) is a bookmark artefact, not a request to
  // search for the literal string "a,b".
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return "";
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/**
 * Normalises whatever arrived in the query string.
 *
 * Unrecognised values are dropped rather than refused, the same way the audit
 * log's filters are: a directory URL is something people bookmark, edit and
 * send to each other, and a stale one should show too much rather than error.
 * What must never happen is the opposite — an unrecognised status reaching the
 * `where`, where it would match nothing and read as "this school has no
 * students".
 */
export function parseStudentFilters(
  params: Record<string, string | string[] | undefined>,
): StudentFilters {
  const status = first(params.status).trim().toUpperCase();
  const sort = first(params.sort).trim();

  return {
    q: first(params.q).trim(),
    status: (STUDENT_STATUSES as readonly string[]).includes(status)
      ? (status as StudentStatus)
      : "",
    cohortId: first(params.cohortId).trim(),
    campusId: first(params.campusId).trim(),
    sort: STUDENT_SORTS.some((option) => option.key === sort)
      ? (sort as StudentSortKey)
      : DEFAULT_STUDENT_SORT,
    page: positiveInt(first(params.page), 1),
  };
}

/** True when the list is narrowed by anything other than sorting and paging. */
export function hasActiveStudentFilters(filters: StudentFilters): boolean {
  return (
    filters.q !== "" || filters.status !== "" || filters.cohortId !== "" || filters.campusId !== ""
  );
}

/** The most tokens a search is split into, and the longest each may be. */
const MAX_SEARCH_TOKENS = 6;
const MAX_TOKEN_LENGTH = 64;

/**
 * Splits a search box into terms.
 *
 * Typing "priya sharma" has to find Priya Sharma, and no single column contains
 * that string — the name is two columns. So each token is matched separately
 * and a row has to match all of them, which also makes "sharma 2024" work as
 * "the Sharma admitted under a 2024 number".
 *
 * Capped in both directions. A pasted paragraph would otherwise become a
 * hundred-clause query against every text column in the table, which is a
 * denial of service written in a search box rather than a bug in the caller.
 */
export function studentSearchTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
}

/** The columns a free-text search looks in. */
export const STUDENT_SEARCH_FIELDS = [
  "firstName",
  "lastName",
  "studentCode",
  "email",
  "admissionNumber",
] as const;

export type StudentSearchField = (typeof STUDENT_SEARCH_FIELDS)[number];

type TextMatch = {
  [K in StudentSearchField]?: { contains: string; mode: "insensitive" };
};

/**
 * The filter handed to Prisma.
 *
 * Written out as a local type rather than imported from `@prisma/client` so
 * this module stays pure and testable without a generated client. It is
 * structurally a `StudentWhereInput`, and the repository is where that is
 * checked by the compiler.
 */
export interface StudentWhere {
  institutionId: string;
  status?: StudentStatus;
  campusId?: string | null;
  enrollments?:
    | { some: { cohortId: string; status: "ACTIVE" } }
    | { none: { status: "ACTIVE" } };
  AND?: Array<{ OR: TextMatch[] }>;
}

/**
 * `institutionId` first, and not optional.
 *
 * Every other clause narrows further; none can widen past it. A cohort id from
 * a crafted query string therefore cannot pull in another institution's
 * students — the worst it can do is match nothing, because that cohort's
 * enrollments belong to rows this `where` has already excluded.
 */
export function buildStudentWhere(institutionId: string, filters: StudentFilters): StudentWhere {
  const where: StudentWhere = { institutionId };

  if (filters.status !== "") where.status = filters.status;

  if (filters.campusId === NO_CAMPUS) where.campusId = null;
  else if (filters.campusId !== "") where.campusId = filters.campusId;

  if (filters.cohortId === NO_COHORT) {
    // "Not placed anywhere" — the list an administrator works through at the
    // start of a year. A student with only a past placement belongs here.
    where.enrollments = { none: { status: "ACTIVE" } };
  } else if (filters.cohortId !== "") {
    where.enrollments = { some: { cohortId: filters.cohortId, status: "ACTIVE" } };
  }

  const tokens = studentSearchTokens(filters.q);
  if (tokens.length > 0) {
    where.AND = tokens.map((token) => ({
      OR: STUDENT_SEARCH_FIELDS.map((field) => ({
        [field]: { contains: token, mode: "insensitive" as const },
      })) as TextMatch[],
    }));
  }

  return where;
}

type Direction = "asc" | "desc";

export type StudentOrderBy = {
  lastName?: Direction;
  firstName?: Direction;
  studentCode?: Direction;
  admissionDate?: { sort: Direction; nulls: "first" | "last" };
  createdAt?: Direction;
  id?: Direction;
};

/**
 * How the rows are ordered, and why every option ends with `id`.
 *
 * Two students called Sharma are not distinguishable by any of the columns
 * above, and an unstable order across two queries is how a paginated list shows
 * the same row twice and hides another entirely. The id tiebreaker costs
 * nothing and makes page 2 mean the same thing twice in a row.
 *
 * `admissionDate` is nullable, and Postgres sorts nulls first in descending
 * order — which would open "newest admissions" with every student who has no
 * admission date recorded. `nulls: "last"` puts the unknowns at the end in both
 * directions, where they read as "not recorded" rather than as "most recent".
 */
export function studentOrderBy(sort: StudentSortKey): StudentOrderBy[] {
  switch (sort) {
    case "name_desc":
      return [{ lastName: "desc" }, { firstName: "desc" }, { id: "asc" }];
    case "code":
      return [{ studentCode: "asc" }, { id: "asc" }];
    case "code_desc":
      return [{ studentCode: "desc" }, { id: "asc" }];
    case "admitted_new":
      return [{ admissionDate: { sort: "desc", nulls: "last" } }, { lastName: "asc" }, { id: "asc" }];
    case "admitted_old":
      return [{ admissionDate: { sort: "asc", nulls: "last" } }, { lastName: "asc" }, { id: "asc" }];
    case "added_new":
      return [{ createdAt: "desc" }, { id: "asc" }];
    case "name":
    default:
      return [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }];
  }
}

/** How many pages `total` rows make. Always at least one, so "page 1 of 1". */
export function studentPageCount(total: number, pageSize = STUDENT_PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * The page actually shown.
 *
 * Asking for page 7 of a list that now has two is what happens when somebody
 * narrows a filter without clearing the page — a bookmark, a back button, a
 * changed search. Clamping shows the last page; honouring it shows an empty
 * table under a heading that says there are forty results.
 */
export function clampStudentPage(page: number, total: number, pageSize = STUDENT_PAGE_SIZE): number {
  const pages = studentPageCount(total, pageSize);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, pages);
}

export function studentPageSkip(page: number, pageSize = STUDENT_PAGE_SIZE): number {
  return (Math.max(1, page) - 1) * pageSize;
}

/**
 * The query string for a link that keeps the current search.
 *
 * Used by the pager and the sort control, so neither throws away the filters
 * the administrator just typed. Empty values are omitted rather than written as
 * `?q=&status=`, which keeps a plain first visit's URL clean and makes
 * "filtered" visible in the address bar.
 */
export function studentFilterQuery(
  filters: StudentFilters,
  overrides: Partial<StudentFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (merged.q !== "") params.set("q", merged.q);
  if (merged.status !== "") params.set("status", merged.status);
  if (merged.cohortId !== "") params.set("cohortId", merged.cohortId);
  if (merged.campusId !== "") params.set("campusId", merged.campusId);
  if (merged.sort !== DEFAULT_STUDENT_SORT) params.set("sort", merged.sort);
  if (merged.page > 1) params.set("page", String(merged.page));

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
