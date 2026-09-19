import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FACULTY_SORT,
  EMPTY_FACULTY_FILTERS,
  FACULTY_PAGE_SIZE,
  NO_DEPARTMENT,
  NO_PASSWORD,
  NO_ROLE,
  buildStaffWhere,
  clampFacultyPage,
  facultyFilterQuery,
  facultyOrderBy,
  facultyPageCount,
  facultyPageSkip,
  facultySearchTokens,
  hasActiveFacultyFilters,
  parseFacultyFilters,
  type FacultyFilters,
} from "./directory-filters.ts";

/**
 * The faculty directory's query, as a pure value.
 *
 * Two things are asserted first and hardest, because they are the ones a query
 * string could otherwise reach: the `where` is always scoped to the institution
 * it was given, and it always excludes students. Everything below that is about
 * a list being legible — a stable page 2, a sort that does not open with people
 * who have never signed in, a pasted paragraph that cannot become a
 * hundred-clause query.
 */

function filters(overrides: Partial<FacultyFilters> = {}): FacultyFilters {
  return { ...EMPTY_FACULTY_FILTERS, ...overrides };
}

// ---------------------------------------------------------------------------
// Tenancy, and what a staff list is
// ---------------------------------------------------------------------------

test("the institution is always in the where, whatever the filters say", () => {
  const combinations: FacultyFilters[] = [
    filters(),
    filters({ q: "sharma", status: "INACTIVE", role: "FACULTY" }),
    filters({ departmentId: NO_DEPARTMENT, access: NO_PASSWORD }),
    filters({ role: NO_ROLE, departmentId: "unit-cs", page: 9 }),
  ];
  for (const combination of combinations) {
    assert.equal(buildStaffWhere("inst-1", combination).institutionId, "inst-1");
  }
});

test("no query string can make an institution id optional", () => {
  // The signature is the guarantee. There is no overload that omits it, and no
  // filter value that removes it, so a `where` that forgot the tenant cannot be
  // constructed by anything a browser sends.
  assert.equal(buildStaffWhere.length, 2, "an institution id and the filters");
});

test("students are excluded by every filter combination", () => {
  const combinations: FacultyFilters[] = [
    filters(),
    filters({ role: NO_ROLE }),
    filters({ role: "FACULTY" }),
    filters({ q: "a b c", status: "ACTIVE", access: NO_PASSWORD, departmentId: "unit-cs" }),
  ];
  for (const combination of combinations) {
    const where = buildStaffWhere("inst-1", combination);
    assert.deepEqual(
      where.AND[0],
      { roleAssignments: { none: { role: { key: "STUDENT" } } } },
      "the definition of staff is the first clause, always",
    );
  }
});

test("a filter for 'no role' still cannot list a student", () => {
  // The one combination worth naming: "accounts with no role" is exactly the
  // shape that would list children if the student clause were conditional.
  const where = buildStaffWhere("inst-1", filters({ role: NO_ROLE }));
  assert.deepEqual(where.AND[0], { roleAssignments: { none: { role: { key: "STUDENT" } } } });
  assert.deepEqual(where.AND[1], { roleAssignments: { none: {} } });
});

// ---------------------------------------------------------------------------
// Reading the query string
// ---------------------------------------------------------------------------

test("an unrecognised value is dropped rather than passed through", () => {
  const parsed = parseFacultyFilters({
    status: "DELETED",
    role: "PLATFORM_SUPER_ADMIN",
    access: "anything",
    sort: "salary",
  });
  assert.equal(parsed.status, "", "an unknown status would match nothing and read as 'no staff'");
  assert.equal(parsed.role, "", "a role this directory does not list is not a filter");
  assert.equal(parsed.access, "");
  assert.equal(parsed.sort, DEFAULT_FACULTY_SORT);
});

test("PLATFORM_SUPER_ADMIN is not a role this screen will filter by", () => {
  // Such an account has no institution, so it never appears in an
  // institution-scoped list. Offering the filter would suggest otherwise.
  assert.equal(parseFacultyFilters({ role: "PLATFORM_SUPER_ADMIN" }).role, "");
  assert.equal(parseFacultyFilters({ role: "STUDENT" }).role, "");
  assert.equal(parseFacultyFilters({ role: "COLLEGE_ADMIN" }).role, "COLLEGE_ADMIN");
});

test("a status is read case-insensitively, because a hand-edited URL is normal", () => {
  assert.equal(parseFacultyFilters({ status: "active" }).status, "ACTIVE");
  assert.equal(parseFacultyFilters({ status: " Inactive " }).status, "INACTIVE");
});

test("a repeated parameter takes the first, not the joined string", () => {
  assert.equal(parseFacultyFilters({ q: ["sharma", "bose"] }).q, "sharma");
});

test("a page that is not a counting number falls back to the first", () => {
  for (const page of ["0", "-3", "2.5", "abc", ""]) {
    assert.equal(parseFacultyFilters({ page }).page, 1, `page=${page}`);
  }
  assert.equal(parseFacultyFilters({ page: "4" }).page, 4);
  // An absurdly large page is not refused here — it is a whole number, and
  // `clampFacultyPage` is what turns it into the last real page. Rejecting it
  // at the parse step would show page 1 to somebody who asked for the end.
  assert.equal(parseFacultyFilters({ page: "100000" }).page, 100000);
  assert.equal(clampFacultyPage(100000, 30), 2);
});

test("sorting and paging alone do not count as filtering", () => {
  // The distinction the empty state depends on: "nothing matched" and "nobody
  // works here yet" are different sentences.
  assert.equal(hasActiveFacultyFilters(filters({ sort: "name", page: 3 })), false);
  assert.equal(hasActiveFacultyFilters(filters({ q: "sharma" })), true);
  assert.equal(hasActiveFacultyFilters(filters({ departmentId: NO_DEPARTMENT })), true);
  assert.equal(hasActiveFacultyFilters(filters({ access: NO_PASSWORD })), true);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("each term has to match, so two words narrow rather than widen", () => {
  const where = buildStaffWhere("inst-1", filters({ q: "sharma t-14" }));
  const textClauses = where.AND.filter((clause) => "OR" in clause);
  assert.equal(textClauses.length, 2, "one AND clause per term");
});

test("a term is looked for in three columns and never in the password", () => {
  const where = buildStaffWhere("inst-1", filters({ q: "sharma" }));
  const clause = where.AND.find((entry) => "OR" in entry) as { OR: Record<string, unknown>[] };
  assert.deepEqual(
    clause.OR.map((match) => Object.keys(match)[0]).sort(),
    ["email", "employeeCode", "name"],
  );
  assert.equal(JSON.stringify(where).includes("password"), false);
});

test("a pasted paragraph cannot become a hundred-clause query", () => {
  const paragraph = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
  assert.equal(facultySearchTokens(paragraph).length, 6);
  const long = facultySearchTokens("x".repeat(500));
  assert.equal(long[0].length, 64);
});

test("searching is case-insensitive, because nobody types a name the same way twice", () => {
  const where = buildStaffWhere("inst-1", filters({ q: "Sharma" }));
  const clause = where.AND.find((entry) => "OR" in entry) as {
    OR: Array<{ name?: { contains: string; mode: string } }>;
  };
  assert.equal(clause.OR[0].name?.mode, "insensitive");
});

// ---------------------------------------------------------------------------
// The other filters
// ---------------------------------------------------------------------------

test("'no department' is a filter for null, not for the literal word", () => {
  assert.equal(buildStaffWhere("inst-1", filters({ departmentId: NO_DEPARTMENT })).departmentId, null);
  assert.equal(
    buildStaffWhere("inst-1", filters({ departmentId: "unit-cs" })).departmentId,
    "unit-cs",
  );
  assert.equal(
    Object.hasOwn(buildStaffWhere("inst-1", filters()), "departmentId"),
    false,
    "no department filter means no clause at all",
  );
});

test("'cannot sign in' asks whether a hash exists, and never for its value", () => {
  const where = buildStaffWhere("inst-1", filters({ access: NO_PASSWORD }));
  assert.equal(where.passwordHash, null);
  assert.equal(
    Object.hasOwn(buildStaffWhere("inst-1", filters()), "passwordHash"),
    false,
    "the column is not mentioned unless that filter is on",
  );
});

// ---------------------------------------------------------------------------
// Order and pages
// ---------------------------------------------------------------------------

test("every sort ends with the id, so page 2 means the same thing twice running", () => {
  for (const sort of ["status", "name", "name_desc", "last_in", "added_new"] as const) {
    const order = facultyOrderBy(sort);
    assert.deepEqual(order[order.length - 1], { id: "asc" }, sort);
  }
});

test("'recently signed in' does not open with people who never have", () => {
  const [first] = facultyOrderBy("last_in");
  assert.deepEqual(first, { lastLoginAt: { sort: "desc", nulls: "last" } });
});

test("the default order is the one this screen already had", () => {
  // Active first, alphabetical within each group. Changing it would silently
  // reorder a screen administrators already know.
  assert.deepEqual(facultyOrderBy(DEFAULT_FACULTY_SORT), [
    { status: "asc" },
    { name: "asc" },
    { id: "asc" },
  ]);
});

test("an empty list is page 1 of 1, not page 1 of 0", () => {
  assert.equal(facultyPageCount(0), 1);
  assert.equal(facultyPageCount(1), 1);
  assert.equal(facultyPageCount(FACULTY_PAGE_SIZE), 1);
  assert.equal(facultyPageCount(FACULTY_PAGE_SIZE + 1), 2);
});

test("asking for a page past the end shows the last one", () => {
  // What happens when somebody narrows a filter without clearing the page.
  assert.equal(clampFacultyPage(7, 30), 2);
  assert.equal(clampFacultyPage(1, 0), 1);
  assert.equal(clampFacultyPage(-4, 100), 1);
});

test("skipping is derived from the page, so the two cannot disagree", () => {
  assert.equal(facultyPageSkip(1), 0);
  assert.equal(facultyPageSkip(3), FACULTY_PAGE_SIZE * 2);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test("a first visit's link carries no query string", () => {
  assert.equal(facultyFilterQuery(EMPTY_FACULTY_FILTERS), "");
  assert.equal(facultyFilterQuery(filters({ page: 1, sort: DEFAULT_FACULTY_SORT })), "");
});

test("the pager keeps what was just typed", () => {
  const query = facultyFilterQuery(filters({ q: "sharma", status: "ACTIVE" }), { page: 2 });
  const params = new URLSearchParams(query.slice(1));
  assert.equal(params.get("q"), "sharma");
  assert.equal(params.get("status"), "ACTIVE");
  assert.equal(params.get("page"), "2");
});

test("a link round-trips back to the filters it came from", () => {
  const original = filters({
    q: "sharma",
    status: "INACTIVE",
    role: "CLASS_TEACHER",
    departmentId: NO_DEPARTMENT,
    access: NO_PASSWORD,
    sort: "last_in",
    page: 3,
  });
  const query = facultyFilterQuery(original);
  const params = Object.fromEntries(new URLSearchParams(query.slice(1)));
  assert.deepEqual(parseFacultyFilters(params), original);
});
