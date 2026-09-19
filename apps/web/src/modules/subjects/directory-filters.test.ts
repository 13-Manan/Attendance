import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUBJECT_SORT,
  NOT_OFFERED,
  OFFERED,
  SUBJECT_PAGE_SIZE,
  buildSubjectWhere,
  clampSubjectPage,
  hasActiveSubjectFilters,
  parseSubjectFilters,
  subjectFilterQuery,
  subjectOrderBy,
  subjectPageCount,
  subjectPageSkip,
  subjectSearchTokens,
  EMPTY_SUBJECT_FILTERS,
} from "./directory-filters.ts";

/**
 * Search, sorting and pagination for the subject list.
 *
 * The first test is the one that matters: whatever arrives in the query string,
 * the `where` is scoped to the institution the caller was given. Everything
 * after it is about a bookmarked URL degrading into a wider list rather than an
 * error or an empty one.
 */

test("a hostile query string still produces an institution-scoped where", () => {
  const filters = parseSubjectFilters({
    q: "'; drop table subject; --",
    offered: "../../etc/passwd",
    sort: "institutionId",
    page: "-4",
  });

  const where = buildSubjectWhere("inst-A", filters);

  assert.equal(where.institutionId, "inst-A");
  assert.equal(where.cohortLinks, undefined, "an unrecognised value was dropped, not passed on");
  assert.equal(filters.sort, DEFAULT_SUBJECT_SORT);
  assert.equal(filters.page, 1);
});

test("institutionId is a required argument, not an optional filter", () => {
  // The signature is the guarantee: there is no way to call this without one.
  assert.equal(buildSubjectWhere.length, 2);
});

test("a repeated parameter takes the first value", () => {
  // ?q=a&q=b is a bookmark artefact, not a search for "a,b".
  assert.equal(parseSubjectFilters({ q: ["PHY", "CHE"] }).q, "PHY");
  assert.equal(parseSubjectFilters({ q: [] }).q, "");
  assert.equal(parseSubjectFilters({}).q, "");
});

test("only the two known values of `offered` survive parsing", () => {
  assert.equal(parseSubjectFilters({ offered: OFFERED }).offered, OFFERED);
  assert.equal(parseSubjectFilters({ offered: NOT_OFFERED }).offered, NOT_OFFERED);
  assert.equal(parseSubjectFilters({ offered: "maybe" }).offered, "");
});

test("an unrecognised sort falls back to the default rather than erroring", () => {
  assert.equal(parseSubjectFilters({ sort: "nonsense" }).sort, DEFAULT_SUBJECT_SORT);
  assert.equal(parseSubjectFilters({ sort: "name_desc" }).sort, "name_desc");
});

test("a page number is a positive integer or 1", () => {
  assert.equal(parseSubjectFilters({ page: "3" }).page, 3);
  assert.equal(parseSubjectFilters({ page: "0" }).page, 1);
  assert.equal(parseSubjectFilters({ page: "2.5" }).page, 1);
  assert.equal(parseSubjectFilters({ page: "abc" }).page, 1);
});

test("sorting and paging alone do not count as filtering", () => {
  assert.equal(hasActiveSubjectFilters(EMPTY_SUBJECT_FILTERS), false);
  assert.equal(
    hasActiveSubjectFilters({ ...EMPTY_SUBJECT_FILTERS, sort: "name_desc", page: 4 }),
    false,
  );
  assert.equal(hasActiveSubjectFilters({ ...EMPTY_SUBJECT_FILTERS, q: "PHY" }), true);
  assert.equal(hasActiveSubjectFilters({ ...EMPTY_SUBJECT_FILTERS, offered: NOT_OFFERED }), true);
});

test("a pasted paragraph cannot become a hundred-clause query", () => {
  const tokens = subjectSearchTokens(Array.from({ length: 40 }, () => "x".repeat(200)).join(" "));

  assert.equal(tokens.length, 6);
  for (const token of tokens) assert.equal(token.length, 64);
});

test("each search term has to match, and each may match the code or the name", () => {
  // "PHY quantum" means PHY301 Quantum Mechanics — no single column holds it.
  const where = buildSubjectWhere("inst-A", {
    ...EMPTY_SUBJECT_FILTERS,
    q: "PHY quantum",
  });

  assert.equal(where.AND?.length, 2, "both terms must match");
  assert.deepEqual(where.AND?.[0], {
    OR: [
      { code: { contains: "PHY", mode: "insensitive" } },
      { name: { contains: "PHY", mode: "insensitive" } },
    ],
  });
});

test("search is case-insensitive", () => {
  const where = buildSubjectWhere("inst-A", { ...EMPTY_SUBJECT_FILTERS, q: "phy" });
  const clause = where.AND?.[0].OR[0] as { code: { mode: string } };

  assert.equal(clause.code.mode, "insensitive");
});

test("the offered filter becomes a relation clause", () => {
  assert.deepEqual(
    buildSubjectWhere("inst-A", { ...EMPTY_SUBJECT_FILTERS, offered: NOT_OFFERED }).cohortLinks,
    { none: {} },
  );
  assert.deepEqual(
    buildSubjectWhere("inst-A", { ...EMPTY_SUBJECT_FILTERS, offered: OFFERED }).cohortLinks,
    { some: {} },
  );
});

test("every sort ends with the id", () => {
  // Two subjects can share a name; an unstable order is how a paginated list
  // shows one row twice and hides another.
  for (const sort of ["code", "name", "name_desc", "added_new"] as const) {
    const order = subjectOrderBy(sort);
    assert.deepEqual(order[order.length - 1], { id: "asc" }, sort);
  }
  assert.deepEqual(subjectOrderBy("code")[0], { code: "asc" });
});

test("page counts and skips line up", () => {
  assert.equal(subjectPageCount(0), 1, "page 1 of 1, not page 1 of 0");
  assert.equal(subjectPageCount(SUBJECT_PAGE_SIZE), 1);
  assert.equal(subjectPageCount(SUBJECT_PAGE_SIZE + 1), 2);
  assert.equal(subjectPageSkip(1), 0);
  assert.equal(subjectPageSkip(3), SUBJECT_PAGE_SIZE * 2);
});

test("asking for a page past the end shows the last one", () => {
  // What happens when somebody narrows a filter without clearing the page.
  assert.equal(clampSubjectPage(7, SUBJECT_PAGE_SIZE + 1), 2);
  assert.equal(clampSubjectPage(1, 0), 1);
  assert.equal(clampSubjectPage(-3, 100), 1);
});

test("the query string omits what is empty or default", () => {
  assert.equal(subjectFilterQuery(EMPTY_SUBJECT_FILTERS), "");
  assert.equal(subjectFilterQuery(EMPTY_SUBJECT_FILTERS, { page: 1 }), "");
  assert.equal(subjectFilterQuery(EMPTY_SUBJECT_FILTERS, { page: 3 }), "?page=3");
});

test("a filtered URL round-trips", () => {
  const filters = {
    q: "PHY 301",
    offered: NOT_OFFERED,
    sort: "name_desc" as const,
    page: 2,
  };
  const query = subjectFilterQuery(filters);
  const params = Object.fromEntries(new URLSearchParams(query.slice(1)));

  assert.deepEqual(parseSubjectFilters(params), filters);
});
