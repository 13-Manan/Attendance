/**
 * Search, sorting and pagination for the class list.
 *
 * Pure — no Prisma, no session — and it produces a `where` and an `orderBy` for
 * the repository to hand straight to the database.
 *
 * Narrowed in SQL rather than in memory, unlike the campus list. A campus list
 * is a handful of rows; classes multiply — a college with forty departments,
 * eight semesters and three sections has nearly a thousand in a single year,
 * and every past year is kept because the attendance under it has to stay
 * readable. So the page holds one page.
 *
 * The tenancy guarantee lives in `buildCohortWhere`: `institutionId` is a
 * required first argument and is always written into the `where`, so there is
 * no combination of query-string values that produces a filter without it.
 */

export const COHORT_PAGE_SIZE = 25;

/** "Nobody is teaching it", as a value the teacher dropdown can carry. */
export const NO_TEACHER = "none";
/** "Somebody is". */
export const ANY_TEACHER = "assigned";

export const COHORT_SORTS = [
  { key: "year", label: "Newest year first" },
  { key: "name", label: "Name (A–Z)" },
  { key: "name_desc", label: "Name (Z–A)" },
  { key: "added_new", label: "Recently added" },
] as const;

export type CohortSortKey = (typeof COHORT_SORTS)[number]["key"];

export const DEFAULT_COHORT_SORT: CohortSortKey = "year";

export interface CohortFilters {
  /** Free text, matched against the name, term, unit and academic year. */
  q: string;
  /** An academic session id, or empty for every year. */
  sessionId: string;
  /** An academic unit id, or empty for anywhere in the structure. */
  unitId: string;
  /** `NO_TEACHER`, `ANY_TEACHER`, or empty for either. */
  teacher: string;
  sort: CohortSortKey;
  page: number;
}

export const EMPTY_COHORT_FILTERS: CohortFilters = {
  q: "",
  sessionId: "",
  unitId: "",
  teacher: "",
  sort: DEFAULT_COHORT_SORT,
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
 * people bookmark, edit and send to each other, and a stale one should show too
 * much rather than error. What must never happen is an unrecognised value
 * reaching the `where`, where it would match nothing and read as "this
 * institution has no classes".
 */
export function parseCohortFilters(
  params: Record<string, string | string[] | undefined>,
): CohortFilters {
  const sort = first(params.sort).trim();
  const teacher = first(params.teacher).trim();

  return {
    q: first(params.q).trim(),
    sessionId: first(params.sessionId).trim(),
    unitId: first(params.unitId).trim(),
    teacher: teacher === NO_TEACHER || teacher === ANY_TEACHER ? teacher : "",
    sort: COHORT_SORTS.some((option) => option.key === sort)
      ? (sort as CohortSortKey)
      : DEFAULT_COHORT_SORT,
    page: positiveInt(first(params.page), 1),
  };
}

/** True when the list is narrowed by anything other than sorting and paging. */
export function hasActiveCohortFilters(filters: CohortFilters): boolean {
  return (
    filters.q !== "" || filters.sessionId !== "" || filters.unitId !== "" || filters.teacher !== ""
  );
}

/** The most tokens a search is split into, and the longest each may be. */
const MAX_SEARCH_TOKENS = 6;
const MAX_TOKEN_LENGTH = 64;

/**
 * Splits a search box into terms.
 *
 * Typing "8-A 2026" has to find class 8-A in the 2026-27 year, and no single
 * column contains that string — it is the cohort's name and its session's. So
 * each token is matched separately and a row has to match all of them.
 *
 * Capped in both directions: a pasted paragraph would otherwise become a
 * hundred-clause query joined across three tables.
 */
export function cohortSearchTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
}

type Contains = { contains: string; mode: "insensitive" };

/**
 * One token, matched against everything a person might have typed it from.
 *
 * The unit and the session are joins rather than columns, which is the whole
 * reason this is written out: somebody searching "Physics 3" is thinking of the
 * department and the semester, not of `Cohort.name`.
 */
export type CohortTextMatch =
  | { name: Contains }
  | { termLabel: Contains }
  | { academicUnit: { name: Contains } }
  | { academicUnit: { code: Contains } }
  | { academicSession: { name: Contains } };

export interface CohortWhere {
  institutionId: string;
  academicSessionId?: string;
  academicUnitId?: string;
  facultyLinks?: { none: Record<string, never> } | { some: Record<string, never> };
  AND?: Array<{ OR: CohortTextMatch[] }>;
}

/**
 * `institutionId` first, and not optional.
 *
 * Every other clause narrows further; none can widen past it. A unit or session
 * id from a crafted query string therefore cannot pull in another institution's
 * classes — the worst it can do is match nothing, because those rows have
 * already been excluded.
 */
export function buildCohortWhere(institutionId: string, filters: CohortFilters): CohortWhere {
  const where: CohortWhere = { institutionId };

  if (filters.sessionId !== "") where.academicSessionId = filters.sessionId;
  if (filters.unitId !== "") where.academicUnitId = filters.unitId;

  // "Nobody is teaching it" is the list somebody works through in the week
  // before term: a class with no teacher is a class whose register nobody can
  // open.
  if (filters.teacher === NO_TEACHER) where.facultyLinks = { none: {} };
  else if (filters.teacher === ANY_TEACHER) where.facultyLinks = { some: {} };

  const tokens = cohortSearchTokens(filters.q);
  if (tokens.length > 0) {
    where.AND = tokens.map((token) => {
      const contains: Contains = { contains: token, mode: "insensitive" };
      return {
        OR: [
          { name: contains },
          { termLabel: contains },
          { academicUnit: { name: contains } },
          { academicUnit: { code: contains } },
          { academicSession: { name: contains } },
        ],
      };
    });
  }

  return where;
}

type Direction = "asc" | "desc";

export type CohortOrderBy = {
  name?: Direction;
  createdAt?: Direction;
  academicSession?: { startDate: Direction };
  id?: Direction;
};

/**
 * How the rows are ordered, and why every option ends with `id`.
 *
 * Two sections called "A" in different departments are not distinguishable by
 * any of the columns above, and an unstable order across two queries is how a
 * paginated list shows the same row twice and hides another. The id tiebreaker
 * costs nothing and makes page 2 mean the same thing twice in a row.
 *
 * The default leads with the academic year, newest first, because the year
 * somebody is working in is almost always the current one — and a list that
 * opens on classes from four years ago is a list nobody trusts.
 */
export function cohortOrderBy(sort: CohortSortKey): CohortOrderBy[] {
  switch (sort) {
    case "name":
      return [{ name: "asc" }, { id: "asc" }];
    case "name_desc":
      return [{ name: "desc" }, { id: "asc" }];
    case "added_new":
      return [{ createdAt: "desc" }, { id: "asc" }];
    case "year":
    default:
      return [{ academicSession: { startDate: "desc" } }, { name: "asc" }, { id: "asc" }];
  }
}

/** How many pages `total` rows make. Always at least one, so "page 1 of 1". */
export function cohortPageCount(total: number, pageSize = COHORT_PAGE_SIZE): number {
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
export function clampCohortPage(page: number, total: number, pageSize = COHORT_PAGE_SIZE): number {
  const pages = cohortPageCount(total, pageSize);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, pages);
}

export function cohortPageSkip(page: number, pageSize = COHORT_PAGE_SIZE): number {
  return (Math.max(1, page) - 1) * pageSize;
}

/**
 * The query string for a link that keeps the current search.
 *
 * Empty values are omitted rather than written as `?q=&unitId=`, which keeps a
 * plain first visit's URL clean and makes "filtered" visible in the address bar.
 */
export function cohortFilterQuery(
  filters: CohortFilters,
  overrides: Partial<CohortFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (merged.q !== "") params.set("q", merged.q);
  if (merged.sessionId !== "") params.set("sessionId", merged.sessionId);
  if (merged.unitId !== "") params.set("unitId", merged.unitId);
  if (merged.teacher !== "") params.set("teacher", merged.teacher);
  if (merged.sort !== DEFAULT_COHORT_SORT) params.set("sort", merged.sort);
  if (merged.page > 1) params.set("page", String(merged.page));

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
