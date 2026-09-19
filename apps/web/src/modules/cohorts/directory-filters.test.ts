import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANY_TEACHER,
  COHORT_PAGE_SIZE,
  DEFAULT_COHORT_SORT,
  EMPTY_COHORT_FILTERS,
  NO_TEACHER,
  buildCohortWhere,
  clampCohortPage,
  cohortFilterQuery,
  cohortOrderBy,
  cohortPageCount,
  cohortPageSkip,
  cohortSearchTokens,
  hasActiveCohortFilters,
  parseCohortFilters,
} from "./directory-filters.ts";

/**
 * Narrowing the class list.
 *
 * The load-bearing assertion is the first one: whatever arrives in the query
 * string, the `where` handed to Prisma is scoped to one institution. Everything
 * after it is about a list that stays honest — a search that finds a class by
 * its year, an order that does not shuffle between pages, and a page number
 * that cannot point past the end.
 */

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("the institution is always in the where, whatever the query string says", () => {
  const hostile = parseCohortFilters({
    q: "'; select 1 --",
    sessionId: "year-from-another-institution",
    unitId: "unit-from-another-institution",
    teacher: "../../etc/passwd",
    sort: "institutionId",
    page: "-3",
  });

  const where = buildCohortWhere("inst-A", hostile);
  assert.equal(where.institutionId, "inst-A");

  // Every other clause can only narrow. An id from elsewhere matches nothing,
  // because those rows were already excluded by the institution.
  assert.equal(where.academicSessionId, "year-from-another-institution");
  assert.equal(where.academicUnitId, "unit-from-another-institution");
  assert.equal(where.facultyLinks, undefined, "an unrecognised teacher value is dropped");
});

test("institutionId is a required argument, so a where cannot be built without one", () => {
  assert.equal(buildCohortWhere.length, 2, "the institution and the filters");
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("an empty query string is the default view", () => {
  assert.deepEqual(parseCohortFilters({}), EMPTY_COHORT_FILTERS);
});

test("unrecognised sort and teacher values fall back rather than matching nothing", () => {
  // A stale bookmark should show too much, never an empty table that reads as
  // "this institution has no classes".
  const filters = parseCohortFilters({ sort: "most_students", teacher: "maybe" });
  assert.equal(filters.sort, DEFAULT_COHORT_SORT);
  assert.equal(filters.teacher, "");
});

test("both teacher values survive parsing", () => {
  assert.equal(parseCohortFilters({ teacher: NO_TEACHER }).teacher, NO_TEACHER);
  assert.equal(parseCohortFilters({ teacher: ANY_TEACHER }).teacher, ANY_TEACHER);
});

test("a repeated parameter takes the first value rather than joining them", () => {
  assert.equal(parseCohortFilters({ q: ["8-A", "9-B"] }).q, "8-A");
});

test("a page that is not a positive integer is page one", () => {
  for (const page of ["0", "-2", "1.5", "abc", ""]) {
    assert.equal(parseCohortFilters({ page }).page, 1, page);
  }
  assert.equal(parseCohortFilters({ page: "4" }).page, 4);
});

test("filters are active only when the list is actually narrowed", () => {
  assert.equal(hasActiveCohortFilters(EMPTY_COHORT_FILTERS), false);
  assert.equal(
    hasActiveCohortFilters({ ...EMPTY_COHORT_FILTERS, sort: "name", page: 3 }),
    false,
    "sorting and paging are not filters",
  );
  assert.equal(hasActiveCohortFilters({ ...EMPTY_COHORT_FILTERS, q: "8" }), true);
  assert.equal(hasActiveCohortFilters({ ...EMPTY_COHORT_FILTERS, unitId: "unit-1" }), true);
  assert.equal(hasActiveCohortFilters({ ...EMPTY_COHORT_FILTERS, teacher: NO_TEACHER }), true);
});

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

test("a search is split into terms, capped in both directions", () => {
  assert.deepEqual(cohortSearchTokens("  8-A   2026  "), ["8-A", "2026"]);
  assert.deepEqual(cohortSearchTokens("   "), []);
  assert.equal(cohortSearchTokens("a b c d e f g h i").length, 6, "at most six terms");
  assert.equal(cohortSearchTokens("x".repeat(200))[0].length, 64, "each term is truncated");
});

test("every term has to match, and each one is matched against the year and the unit too", () => {
  // "8-A 2026" is a class name and an academic year: no single column holds
  // that string, which is why each term is an OR across the joins.
  const where = buildCohortWhere("inst-A", { ...EMPTY_COHORT_FILTERS, q: "8-A 2026" });
  assert.equal(where.AND?.length, 2, "both terms must match");

  const first = where.AND?.[0].OR ?? [];
  assert.equal(first.length, 5);
  assert.deepEqual(
    first.map((clause) => Object.keys(clause)[0]),
    ["name", "termLabel", "academicUnit", "academicUnit", "academicSession"],
  );
  assert.deepEqual(first[0], { name: { contains: "8-A", mode: "insensitive" } });
});

test("searching is case-insensitive, because nobody types the register's capitalisation", () => {
  const where = buildCohortWhere("inst-A", { ...EMPTY_COHORT_FILTERS, q: "physics" });
  for (const clause of where.AND?.[0].OR ?? []) {
    assert.match(JSON.stringify(clause), /"mode":"insensitive"/);
  }
});

test("an empty search adds no clauses at all", () => {
  assert.equal(buildCohortWhere("inst-A", EMPTY_COHORT_FILTERS).AND, undefined);
});

test("the teacher filter asks the database for the relation, not for a column", () => {
  assert.deepEqual(
    buildCohortWhere("inst-A", { ...EMPTY_COHORT_FILTERS, teacher: NO_TEACHER }).facultyLinks,
    { none: {} },
  );
  assert.deepEqual(
    buildCohortWhere("inst-A", { ...EMPTY_COHORT_FILTERS, teacher: ANY_TEACHER }).facultyLinks,
    { some: {} },
  );
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("every ordering ends with the id, so a paginated list is stable", () => {
  // Two sections called "A" in different departments are identical on every
  // visible column. Without a tiebreaker, page 2 can repeat a row from page 1
  // and hide another entirely.
  for (const sort of ["year", "name", "name_desc", "added_new"] as const) {
    const order = cohortOrderBy(sort);
    assert.deepEqual(order.at(-1), { id: "asc" }, sort);
  }
});

test("the default leads with the newest academic year", () => {
  assert.deepEqual(cohortOrderBy(DEFAULT_COHORT_SORT)[0], { academicSession: { startDate: "desc" } });
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

test("an empty list is still page 1 of 1", () => {
  assert.equal(cohortPageCount(0), 1);
  assert.equal(clampCohortPage(1, 0), 1);
});

test("page counts do not lose the last, partly full page", () => {
  assert.equal(cohortPageCount(COHORT_PAGE_SIZE), 1);
  assert.equal(cohortPageCount(COHORT_PAGE_SIZE + 1), 2);
});

test("a page past the end shows the last page rather than an empty table", () => {
  // This is what happens when somebody narrows a filter without clearing the
  // page. Honouring page 7 of a two-page list shows nothing under a heading
  // that says there are forty.
  assert.equal(clampCohortPage(7, COHORT_PAGE_SIZE + 1), 2);
  assert.equal(clampCohortPage(0, 100), 1);
  assert.equal(clampCohortPage(1.5, 100), 1);
});

test("skip counts from zero", () => {
  assert.equal(cohortPageSkip(1), 0);
  assert.equal(cohortPageSkip(3), COHORT_PAGE_SIZE * 2);
  assert.equal(cohortPageSkip(0), 0, "a nonsense page does not produce a negative skip");
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test("a link keeps the current search and writes nothing that is empty", () => {
  assert.equal(cohortFilterQuery(EMPTY_COHORT_FILTERS), "");

  const query = cohortFilterQuery(
    { ...EMPTY_COHORT_FILTERS, q: "8 A", teacher: NO_TEACHER },
    { page: 3 },
  );
  const params = new URLSearchParams(query.slice(1));
  assert.equal(params.get("q"), "8 A");
  assert.equal(params.get("teacher"), NO_TEACHER);
  assert.equal(params.get("page"), "3");
  assert.equal(params.get("sessionId"), null, "an empty filter is left out");
  assert.equal(params.get("sort"), null, "the default sort is left out");
});

test("a query string round-trips through parsing unchanged", () => {
  const filters = {
    ...EMPTY_COHORT_FILTERS,
    q: "physics 3",
    sessionId: "year-1",
    unitId: "unit-1",
    teacher: ANY_TEACHER,
    sort: "name" as const,
    page: 2,
  };
  const params = new URLSearchParams(cohortFilterQuery(filters).slice(1));
  assert.deepEqual(parseCohortFilters(Object.fromEntries(params)), filters);
});
