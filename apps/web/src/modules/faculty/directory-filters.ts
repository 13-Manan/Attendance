import { STAFF_ROLE_KEYS } from "./directory-types";

/**
 * Search, sorting and pagination for the faculty directory.
 *
 * Pure — no Prisma, no session — and it produces a `where` and an `orderBy` the
 * repository hands straight to the database. A college with three hundred staff
 * accounts is not a list anybody scrolls, and it is certainly not one worth
 * reading into a Node process to render twenty-five rows.
 *
 * Two tenancy guarantees live in `buildStaffWhere`, and both are structural
 * rather than conditional: `institutionId` is a required first argument that is
 * always written into the `where`, and the clause that excludes students is
 * always the first `AND` entry. Neither can be turned off by a query string,
 * because neither is reachable from one.
 */

export const FACULTY_PAGE_SIZE = 25;

/** "In no department", as a value the department dropdown can carry. */
export const NO_DEPARTMENT = "none";
/** "Has no role assigned" — the account that can sign in and see nothing. */
export const NO_ROLE = "none";
/** "Has never been given a password", so cannot sign in at all. */
export const NO_PASSWORD = "no_password";

export const FACULTY_SORTS = [
  { key: "status", label: "Active first, then name" },
  { key: "name", label: "Name (A–Z)" },
  { key: "name_desc", label: "Name (Z–A)" },
  { key: "last_in", label: "Recently signed in" },
  { key: "added_new", label: "Recently added" },
] as const;

export type FacultySortKey = (typeof FACULTY_SORTS)[number]["key"];

/**
 * The shipped order, which is the one this screen had before it was
 * searchable: active accounts first, alphabetical within each group. Stopped
 * accounts are still listed — they are the answer to "why can't she sign in?"
 * — but they are not what an administrator is looking at first.
 */
export const DEFAULT_FACULTY_SORT: FacultySortKey = "status";

export interface FacultyFilters {
  /** Free text, matched against name, email and employee code. */
  q: string;
  /** Exact status. Empty means both. */
  status: "" | "ACTIVE" | "INACTIVE";
  /** A role key, `NO_ROLE`, or empty for any. */
  role: string;
  /** A department unit id, `NO_DEPARTMENT`, or empty for any. */
  departmentId: string;
  /** `NO_PASSWORD`, or empty for any. */
  access: "" | typeof NO_PASSWORD;
  sort: FacultySortKey;
  page: number;
}

export const EMPTY_FACULTY_FILTERS: FacultyFilters = {
  q: "",
  status: "",
  role: "",
  departmentId: "",
  access: "",
  sort: DEFAULT_FACULTY_SORT,
  page: 1,
};

function first(value: string | string[] | undefined): string {
  // A repeated parameter (?q=a&q=b) is a bookmark artefact, not a search for
  // the literal string "a,b".
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
 * Unrecognised values are dropped rather than refused: a directory URL gets
 * bookmarked, edited and forwarded, and a stale one should show too much rather
 * than error. What must never happen is the opposite — an unrecognised status
 * reaching the `where`, where it matches nothing and reads as "this college has
 * no staff".
 */
export function parseFacultyFilters(
  params: Record<string, string | string[] | undefined>,
): FacultyFilters {
  const status = first(params.status).trim().toUpperCase();
  const role = first(params.role).trim();
  const sort = first(params.sort).trim();
  const access = first(params.access).trim();

  return {
    q: first(params.q).trim(),
    status: status === "ACTIVE" || status === "INACTIVE" ? status : "",
    role:
      role === NO_ROLE || (STAFF_ROLE_KEYS as readonly string[]).includes(role) ? role : "",
    departmentId: first(params.departmentId).trim(),
    access: access === NO_PASSWORD ? NO_PASSWORD : "",
    sort: FACULTY_SORTS.some((option) => option.key === sort)
      ? (sort as FacultySortKey)
      : DEFAULT_FACULTY_SORT,
    page: positiveInt(first(params.page), 1),
  };
}

/** True when the list is narrowed by anything other than sorting and paging. */
export function hasActiveFacultyFilters(filters: FacultyFilters): boolean {
  return (
    filters.q !== "" ||
    filters.status !== "" ||
    filters.role !== "" ||
    filters.departmentId !== "" ||
    filters.access !== ""
  );
}

/** The most tokens a search is split into, and the longest each may be. */
const MAX_SEARCH_TOKENS = 6;
const MAX_TOKEN_LENGTH = 64;

/**
 * Splits the search box into terms.
 *
 * "r sharma" has to find R Sharma, and no single column holds that string.
 * Each token is matched separately and a row has to match all of them, which
 * also makes "sharma t-14" work as "the Sharma with that employee code".
 *
 * Capped in both directions, or a pasted paragraph becomes a hundred-clause
 * query across three text columns — a denial of service written in a search box
 * rather than a bug in the caller.
 */
export function facultySearchTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== "")
    .slice(0, MAX_SEARCH_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
}

/** The columns a free-text search looks in. Never the password hash. */
export const FACULTY_SEARCH_FIELDS = ["name", "email", "employeeCode"] as const;

export type FacultySearchField = (typeof FACULTY_SEARCH_FIELDS)[number];

type TextMatch = {
  [K in FacultySearchField]?: { contains: string; mode: "insensitive" };
};

type RoleClause =
  | { roleAssignments: { none: Record<string, never> | { role: { key: string } } } }
  | { roleAssignments: { some: { role: { key: string } } } };

export type StaffAndClause = RoleClause | { OR: TextMatch[] };

/**
 * The filter handed to Prisma.
 *
 * Written as a local type rather than imported from `@prisma/client` so this
 * module stays pure and testable without a generated client. It is structurally
 * a `UserWhereInput`, and the repository is where the compiler checks that.
 */
export interface StaffWhere {
  institutionId: string;
  status?: "ACTIVE" | "INACTIVE";
  departmentId?: string | null;
  /**
   * Only ever `null`, and only when filtering for "cannot sign in". The hash
   * itself is never selected on this path — see `directory-repository.ts` — and
   * asking the database whether one exists is not the same as reading it.
   */
  passwordHash?: null;
  AND: StaffAndClause[];
}

/**
 * `institutionId` first, and not optional.
 *
 * The first `AND` clause is the definition of "staff": everyone in this
 * institution who is not a student. It is written unconditionally rather than
 * as an option, because a screen that lists logins must not have a filter
 * combination that quietly starts listing children.
 */
export function buildStaffWhere(institutionId: string, filters: FacultyFilters): StaffWhere {
  const where: StaffWhere = {
    institutionId,
    AND: [{ roleAssignments: { none: { role: { key: "STUDENT" } } } }],
  };

  if (filters.status !== "") where.status = filters.status;
  if (filters.access === NO_PASSWORD) where.passwordHash = null;

  if (filters.departmentId === NO_DEPARTMENT) where.departmentId = null;
  else if (filters.departmentId !== "") where.departmentId = filters.departmentId;

  if (filters.role === NO_ROLE) {
    where.AND.push({ roleAssignments: { none: {} } });
  } else if (filters.role !== "") {
    where.AND.push({ roleAssignments: { some: { role: { key: filters.role } } } });
  }

  for (const token of facultySearchTokens(filters.q)) {
    where.AND.push({
      OR: FACULTY_SEARCH_FIELDS.map((field) => ({
        [field]: { contains: token, mode: "insensitive" as const },
      })) as TextMatch[],
    });
  }

  return where;
}

type Direction = "asc" | "desc";

export type FacultyOrderBy = {
  status?: Direction;
  name?: Direction;
  lastLoginAt?: { sort: Direction; nulls: "first" | "last" };
  createdAt?: Direction;
  id?: Direction;
};

/**
 * How the rows are ordered, and why every option ends with `id`.
 *
 * Two teachers can share a name, and an unstable order across two queries is
 * how a paginated list shows one row twice and hides another. The tiebreaker
 * costs nothing and makes page 2 mean the same thing twice running.
 *
 * `status: "asc"` is ACTIVE before INACTIVE — the enum's declared order, which
 * is also the order an administrator wants.
 *
 * `lastLoginAt` is null for anybody who has never signed in, and Postgres sorts
 * nulls first descending, which would open "recently signed in" with everyone
 * who never has. `nulls: "last"` puts them where they read as "never" rather
 * than as "just now".
 */
export function facultyOrderBy(sort: FacultySortKey): FacultyOrderBy[] {
  switch (sort) {
    case "name":
      return [{ name: "asc" }, { id: "asc" }];
    case "name_desc":
      return [{ name: "desc" }, { id: "asc" }];
    case "last_in":
      return [{ lastLoginAt: { sort: "desc", nulls: "last" } }, { name: "asc" }, { id: "asc" }];
    case "added_new":
      return [{ createdAt: "desc" }, { id: "asc" }];
    case "status":
    default:
      return [{ status: "asc" }, { name: "asc" }, { id: "asc" }];
  }
}

/** How many pages `total` rows make. Always at least one, so "page 1 of 1". */
export function facultyPageCount(total: number, pageSize = FACULTY_PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * The page actually shown.
 *
 * Asking for page 7 of a list that now has two is what happens when somebody
 * narrows a filter without clearing the page. Clamping shows the last page;
 * honouring it shows an empty table under a heading that says there are forty
 * results.
 */
export function clampFacultyPage(
  page: number,
  total: number,
  pageSize = FACULTY_PAGE_SIZE,
): number {
  const pages = facultyPageCount(total, pageSize);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, pages);
}

export function facultyPageSkip(page: number, pageSize = FACULTY_PAGE_SIZE): number {
  return (Math.max(1, page) - 1) * pageSize;
}

/**
 * The query string for a link that keeps the current search.
 *
 * Used by the pager and the sort control so neither throws away what was just
 * typed. Empty values are omitted rather than written as `?q=&status=`, which
 * keeps a first visit's URL clean and makes "filtered" visible in the address
 * bar.
 */
export function facultyFilterQuery(
  filters: FacultyFilters,
  overrides: Partial<FacultyFilters> = {},
): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (merged.q !== "") params.set("q", merged.q);
  if (merged.status !== "") params.set("status", merged.status);
  if (merged.role !== "") params.set("role", merged.role);
  if (merged.departmentId !== "") params.set("departmentId", merged.departmentId);
  if (merged.access !== "") params.set("access", merged.access);
  if (merged.sort !== DEFAULT_FACULTY_SORT) params.set("sort", merged.sort);
  if (merged.page > 1) params.set("page", String(merged.page));

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}
