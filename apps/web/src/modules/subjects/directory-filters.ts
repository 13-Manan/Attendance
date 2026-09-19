/**
 * Search, sorting and pagination for the subject list.
 *
 * Pure — no Prisma, no session — and it produces a `where` and an `orderBy` for
 * the repository to hand straight to the database.
 *
 * The tenancy guarantee lives in `buildSubjectWhere`: `institutionId` is a
 * required first argument and is always written into the `where`, so there is
 * no combination of query-string values that produces a filter without it.
 */

export const SUBJECT_PAGE_SIZE = 25;

/** "No class offers it", as a value the dropdown can carry. */
export const NOT_OFFERED = "none";
/** "Some class does". */
export const OFFERED = "offered";

export const SUBJECT_SORTS = [
  { key: "code", label: "Code (A–Z)" },
  { key: "name", label: "Name (A–Z)" },
  { key: "name_desc", label: "Name (Z–A)" },
  { key: "added_new", label: "Recently added" },
] as const;

export type SubjectSortKey = (typeof SUBJECT_SORTS)[number]["key"];

export const DEFAULT_SUBJECT_SORT: SubjectSortKey = "code";

export interface SubjectFilters {
  /** Free text, matched against the code and the name. */
  q: string;
  /** `OFFERED`, `NOT_OFFERED`, or empty for either. */
  offered: string;
  sort: SubjectSortKey;
  page: number;
}

export const EMPTY_SUBJECT_FILTERS: SubjectFilters = {
  q: "",
  offered: "",
  sort: DEFAULT_SUBJECT_SORT,
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
 * Unrecognised values are dropped rather than refused: a filtered list is a URL
 * people bookmark and send to each other. What must never happen is an
 * unrecognised value reaching the `where`, where it would match nothing and
 * read as "this college has no subjects".
 */
export function parseSubjectFilters(
  params: Record<string, string | string[] | undefined>,
): SubjectFilters {
  const sort = first(params.sort).trim();
  const offered = first(params.offered).trim();

  return {
    q: first(params.q).trim(),
    offered: offered === OFFERED || offered === NOT_OFFERED ? offered : "",
    sort: SUBJECT_SORTS.some((option) => option.key === sort)
      ? (sort as SubjectSortKey)
      : DEFAULT_SUBJECT_SORT,
    page: positiveInt(first(params.page), 1),
  };
}

/** True when the list is narrowed by anything other than sorting and paging. */
export function hasActiveSubjectFilters(filters: SubjectFilters): boolean {
  return filters.q !== "" || filters.offered !== "";
}

/** The most tokens a search is split into, and the longest each may be. */
const MAX_SEARCH_TOKENS = 6;
const MAX_TOKEN_LENGTH = 64;

/**
 * Splits a search box into terms.
 *
 * Typing "PHY quantum" has to find PHY301 Quantum Mechanics, and no single
 * column contains that string. So each token is matched separately and a row
 * has to match all of them.
 *
 * Capped in both directions: a pasted paragraph would otherwise become a
 * hundred-clause query.
 */
export function subjectSearchTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
}

type Contains = { contains: string; mode: "insensitive" };

export type SubjectTextMatch = { code: Contains } | { name: Contains };

export interface SubjectWhere {
  institutionId: string;
  cohortLinks?: { none: Record<string, never> } | { some: Record<string, never> };
  AND?: Array<{ OR: SubjectTextMatch[] }>;
}

/**
 * `institutionId` first, and not optional.
 *
 * Every other clause narrows further; none can widen past it. A crafted query
 * string therefore cannot pull in another institution's subjects — the worst it
 * can do is match nothing, because those rows have already been excluded.
 */
export function buildSubjectWhere(institutionId: string, filters: SubjectFilters): SubjectWhere {
  const where: SubjectWhere = { institutionId };

  // "Offered by nobody" is the list somebody works through before term: a
  // subject no class offers is one nobody can take a register for.
  if (filters.offered === NOT_OFFERED) where.cohortLinks = { none: {} };
  else if (filters.offered === OFFERED) where.cohortLinks = { some: {} };

  const tokens = subjectSearchTokens(filters.q);
  if (tokens.length > 0) {
    where.AND = tokens.map((token) => {
      const contains: Contains = { contains: token, mode: "insensitive" };
      return { OR: [{ code: contains }, { name: contains }] };
    });
  }

  return where;
}

type Direction = "asc" | "desc";

export type SubjectOrderBy = {
  code?: Direction;
  name?: Direction;
  createdAt?: Direction;
  id?: Direction;
};

/**
 * How the rows are ordered, and why every option ends with `id`.
 *
 * An unstable order across two queries is how a paginated list shows the same
 * row twice and hides another. The id tiebreaker costs nothing and makes page 2
 * mean the same thing twice in a row.
 *
 * The default is the code, because that is what a timetable is written in.
 */
export function subjectOrderBy(sort: SubjectSortKey): SubjectOrderBy[] {
  switch (sort) {
    case "name":
      return [{ name: "asc" }, { id: "asc" }];
    case "name_desc":
      return [{ name: "desc" }, { id: "asc" }];
    case "added_new":
      return [{ createdAt: "desc" }, { id: "asc" }];
    case "code":
    default:
      return [{ code: "asc" }, { id: "asc" }];
  }
}

/** How many pages `total` rows make. Always at least one, so "page 1 of 1". */
export function subjectPageCount(total: number, pageSize = SUBJECT_PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * The page actually shown.
 *
 * Asking for page 7 of a list that now has two is what happens when somebody
 * narrows a filter without clearing the page. Clamping shows the last page;
 * honouring it shows an empty table under a heading that says there are forty.
 */
export function clampSubjectPage(
  page: number,
  total: number,
  pageSize = SUBJECT_PAGE_SIZE,
): number {
  const pages = subjectPageCount(total, pageSize);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, pages);
}

export function subjectPageSkip(page: number, pageSize = SUBJECT_PAGE_SIZE): number {
  return (Math.max(1, page) - 1) * pageSize;
}

/**
 * The query string for a link that keeps the current search.
 *
 * Empty values are omitted rather than written as `?q=&offered=`, which keeps a
 * plain first visit's URL clean and makes "filtered" visible in the address bar.
 */
export function subjectFilterQuery(
  filters: SubjectFilters,
  overrides: Partial<SubjectFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (merged.q !== "") params.set("q", merged.q);
  if (merged.offered !== "") params.set("offered", merged.offered);
  if (merged.sort !== DEFAULT_SUBJECT_SORT) params.set("sort", merged.sort);
  if (merged.page > 1) params.set("page", String(merged.page));

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
