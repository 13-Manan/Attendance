import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STUDENT_SORT,
  EMPTY_STUDENT_FILTERS,
  NO_CAMPUS,
  NO_COHORT,
  STUDENT_PAGE_SIZE,
  STUDENT_SEARCH_FIELDS,
  STUDENT_SORTS,
  buildStudentWhere,
  clampStudentPage,
  hasActiveStudentFilters,
  parseStudentFilters,
  studentFilterQuery,
  studentOrderBy,
  studentPageCount,
  studentPageSkip,
  studentSearchTokens,
  type StudentFilters,
} from "./directory-filters.ts";

/**
 * The student directory's query string, and what it turns into.
 *
 * Pure, so all of it runs without a database. Two properties are worth more
 * than the rest: that no combination of query-string values produces a filter
 * without an institution, and that the ordering is total — a paginated list
 * with an unstable sort shows one student twice and hides another.
 */

function filters(overrides: Partial<StudentFilters> = {}): StudentFilters {
  return { ...EMPTY_STUDENT_FILTERS, ...overrides };
}

// ---------------------------------------------------------------------------
// Reading the query string
// ---------------------------------------------------------------------------

test("an empty query string is the unfiltered first page", () => {
  assert.deepEqual(parseStudentFilters({}), EMPTY_STUDENT_FILTERS);
});

test("a status is matched case-insensitively and an unknown one is dropped", () => {
  assert.equal(parseStudentFilters({ status: "active" }).status, "ACTIVE");
  assert.equal(parseStudentFilters({ status: " Transferred " }).status, "TRANSFERRED");
  // Dropped, not refused: a stale bookmark should show too much rather than
  // error. What must not happen is the value reaching the `where`, where it
  // would match nothing and read as "this school has no students".
  assert.equal(parseStudentFilters({ status: "EXPELLED" }).status, "");
  assert.equal(parseStudentFilters({ status: "DROP TABLE" }).status, "");
});

test("an unknown sort falls back to the default rather than to no order at all", () => {
  assert.equal(parseStudentFilters({ sort: "sideways" }).sort, DEFAULT_STUDENT_SORT);
  for (const option of STUDENT_SORTS) {
    assert.equal(parseStudentFilters({ sort: option.key }).sort, option.key);
  }
});

test("a page number that is not a page number is page one", () => {
  assert.equal(parseStudentFilters({ page: "3" }).page, 3);
  for (const bad of ["0", "-4", "1.5", "seven", "", "9e99999"]) {
    assert.equal(parseStudentFilters({ page: bad }).page, 1, bad);
  }
});

test("a repeated parameter takes the first value, not the joined pair", () => {
  // ?q=priya&q=sharma is a bookmark artefact, not a search for "priya,sharma".
  assert.equal(parseStudentFilters({ q: ["priya", "sharma"] }).q, "priya");
  assert.equal(parseStudentFilters({ q: [] }).q, "");
});

test("only narrowing counts as a filter — sorting and paging do not", () => {
  assert.equal(hasActiveStudentFilters(EMPTY_STUDENT_FILTERS), false);
  assert.equal(hasActiveStudentFilters(filters({ page: 4, sort: "code" })), false);
  assert.equal(hasActiveStudentFilters(filters({ q: "sharma" })), true);
  assert.equal(hasActiveStudentFilters(filters({ status: "INACTIVE" })), true);
  assert.equal(hasActiveStudentFilters(filters({ cohortId: NO_COHORT })), true);
  assert.equal(hasActiveStudentFilters(filters({ campusId: "campus-1" })), true);
});

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

test("a search is split into terms, so two columns can be matched at once", () => {
  // No single column contains "priya sharma" — the name is two columns.
  assert.deepEqual(studentSearchTokens("priya sharma"), ["priya", "sharma"]);
  assert.deepEqual(studentSearchTokens("  priya\t\n sharma  "), ["priya", "sharma"]);
  assert.deepEqual(studentSearchTokens("   "), []);
});

test("a pasted paragraph cannot become a hundred-clause query", () => {
  const tokens = studentSearchTokens("a b c d e f g h i j k");
  assert.equal(tokens.length, 6);
  const long = studentSearchTokens("x".repeat(500));
  assert.equal(long[0].length, 64);
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("the institution is in every where, whatever the query string says", () => {
  const crafted = filters({
    q: "sharma",
    status: "ACTIVE",
    cohortId: "cohort-from-another-school",
    campusId: "campus-from-another-school",
    page: 9,
  });
  assert.equal(buildStudentWhere("inst-A", crafted).institutionId, "inst-A");
  assert.equal(buildStudentWhere("inst-A", EMPTY_STUDENT_FILTERS).institutionId, "inst-A");
  // It is a required first argument, so there is no call that omits it.
  assert.equal(buildStudentWhere.length, 2);
});

test("a cohort id from another institution narrows to nothing rather than widening", () => {
  const where = buildStudentWhere("inst-A", filters({ cohortId: "cohort-inst-B" }));
  assert.equal(where.institutionId, "inst-A");
  assert.deepEqual(where.enrollments, {
    some: { cohortId: "cohort-inst-B", status: "ACTIVE" },
  });
});

// ---------------------------------------------------------------------------
// Building the filter
// ---------------------------------------------------------------------------

test("an unfiltered list asks only for the institution", () => {
  assert.deepEqual(buildStudentWhere("inst-A", EMPTY_STUDENT_FILTERS), {
    institutionId: "inst-A",
  });
});

test("“not placed in any class” means no active enrollment, not no enrollment ever", () => {
  // A student with only a past placement belongs on this list: they need
  // putting in a class for the new year.
  const where = buildStudentWhere("inst-A", filters({ cohortId: NO_COHORT }));
  assert.deepEqual(where.enrollments, { none: { status: "ACTIVE" } });
});

test("“no campus” is null, which is not the same as any campus", () => {
  assert.equal(buildStudentWhere("inst-A", filters({ campusId: NO_CAMPUS })).campusId, null);
  assert.equal(buildStudentWhere("inst-A", filters({ campusId: "c1" })).campusId, "c1");
  assert.equal("campusId" in buildStudentWhere("inst-A", EMPTY_STUDENT_FILTERS), false);
});

test("every term has to match, and each may match any searchable column", () => {
  const where = buildStudentWhere("inst-A", filters({ q: "priya sharma" }));
  assert.equal(where.AND?.length, 2, "both terms, ANDed");
  for (const clause of where.AND ?? []) {
    assert.equal(clause.OR.length, STUDENT_SEARCH_FIELDS.length);
  }
  assert.deepEqual(where.AND?.[0].OR[0], {
    firstName: { contains: "priya", mode: "insensitive" },
  });
});

test("a blank search adds no clause at all", () => {
  assert.equal("AND" in buildStudentWhere("inst-A", filters({ q: "   " })), false);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("every sort ends with the id, so a page means the same thing twice", () => {
  for (const option of STUDENT_SORTS) {
    const order = studentOrderBy(option.key);
    assert.deepEqual(order[order.length - 1], { id: "asc" }, option.key);
  }
});

test("students with no admission date sort last in both directions", () => {
  // Postgres puts nulls first in DESC, which would open "newest admissions"
  // with every student whose date was never recorded.
  assert.deepEqual(studentOrderBy("admitted_new")[0], {
    admissionDate: { sort: "desc", nulls: "last" },
  });
  assert.deepEqual(studentOrderBy("admitted_old")[0], {
    admissionDate: { sort: "asc", nulls: "last" },
  });
});

test("the default order is by surname", () => {
  assert.deepEqual(studentOrderBy(DEFAULT_STUDENT_SORT), [
    { lastName: "asc" },
    { firstName: "asc" },
    { id: "asc" },
  ]);
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

test("an empty list is still page 1 of 1", () => {
  assert.equal(studentPageCount(0), 1);
  assert.equal(studentPageCount(-3), 1);
  assert.equal(studentPageCount(1), 1);
  assert.equal(studentPageCount(STUDENT_PAGE_SIZE), 1);
  assert.equal(studentPageCount(STUDENT_PAGE_SIZE + 1), 2);
});

test("asking for page 7 of a two-page list shows page 2, not an empty table", () => {
  assert.equal(clampStudentPage(7, 30), 2);
  assert.equal(clampStudentPage(1, 30), 1);
  assert.equal(clampStudentPage(0, 30), 1);
  assert.equal(clampStudentPage(2.5, 30), 1);
  assert.equal(clampStudentPage(3, 0), 1);
});

test("the skip is a whole number of pages and never negative", () => {
  assert.equal(studentPageSkip(1), 0);
  assert.equal(studentPageSkip(3), STUDENT_PAGE_SIZE * 2);
  assert.equal(studentPageSkip(0), 0);
  assert.equal(studentPageSkip(-5), 0);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test("a link keeps the search and carries nothing empty", () => {
  assert.equal(studentFilterQuery(EMPTY_STUDENT_FILTERS), "");
  assert.equal(
    studentFilterQuery(filters({ q: "priya sharma", status: "ACTIVE" })),
    "?q=priya+sharma&status=ACTIVE",
  );
});

test("the pager changes the page and leaves the filters alone", () => {
  const current = filters({ q: "sharma", cohortId: "c1", page: 2 });
  assert.equal(studentFilterQuery(current, { page: 3 }), "?q=sharma&cohortId=c1&page=3");
  assert.equal(studentFilterQuery(current, { page: 1 }), "?q=sharma&cohortId=c1");
});

test("the default sort is not written into the URL", () => {
  assert.equal(studentFilterQuery(filters({ sort: DEFAULT_STUDENT_SORT })), "");
  assert.equal(studentFilterQuery(filters({ sort: "code_desc" })), "?sort=code_desc");
});
