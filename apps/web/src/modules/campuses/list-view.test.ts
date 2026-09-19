import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCampusFilters,
  hasActiveCampusFilters,
  parseCampusFilters,
} from "./list-view.ts";
import type { CampusSummary } from "./types.ts";

/**
 * Searching and filtering the campus list.
 *
 * The assertions that matter are about what a wrong input does: a mistyped
 * status must widen the list rather than empty it, and an empty result must be
 * reachable only by a filter the administrator actually set — otherwise "no
 * campuses" and "no matches" become the same screen.
 */

function campus(overrides: Partial<CampusSummary>): CampusSummary {
  return {
    id: "c1",
    name: "Main Campus",
    code: "MAIN",
    address: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    studentCount: 0,
    staffCount: 0,
    academicUnitCount: 0,
    ...overrides,
  };
}

const CAMPUSES: CampusSummary[] = [
  campus({ id: "c1", name: "Main Campus", code: "MAIN", address: "12 Nehru Road" }),
  campus({ id: "c2", name: "North Wing", code: "NORTH", address: null }),
  campus({ id: "c3", name: "Old Town", code: "OLD", isActive: false, address: "Fort Road" }),
];

const ids = (rows: CampusSummary[]) => rows.map((row) => row.id);

test("no parameters means no filters and every campus", () => {
  const filters = parseCampusFilters({});
  assert.deepEqual(filters, { q: "", status: "" });
  assert.equal(hasActiveCampusFilters(filters), false);
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, filters)), ["c1", "c2", "c3"]);
});

test("an unrecognised status shows every campus rather than none", () => {
  // A mistyped or stale URL should err towards showing too much. An empty
  // table caused by a typo reads as "this institution has no campuses".
  const filters = parseCampusFilters({ status: "archived" });
  assert.equal(filters.status, "");
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, filters)), ["c1", "c2", "c3"]);
});

test("the status filter separates open from closed", () => {
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, parseCampusFilters({ status: "open" }))), [
    "c1",
    "c2",
  ]);
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, parseCampusFilters({ status: "closed" }))), [
    "c3",
  ]);
});

test("search is case-insensitive and matches name, code or address", () => {
  const find = (q: string) => ids(applyCampusFilters(CAMPUSES, parseCampusFilters({ q })));
  assert.deepEqual(find("north"), ["c2"], "name");
  assert.deepEqual(find("main"), ["c1"], "name and code both match the same row once");
  assert.deepEqual(find("nehru"), ["c1"], "address");
  assert.deepEqual(find("OLD"), ["c3"], "a closed campus is still findable by search");
});

test("surrounding whitespace in the search box is not part of the search", () => {
  const filters = parseCampusFilters({ q: "  north  " });
  assert.equal(filters.q, "north");
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, filters)), ["c2"]);
});

test("a search box containing only spaces is not an active filter", () => {
  // Otherwise the page would say "no campuses match" while showing all of
  // them, and offer a Clear button that appears to do nothing.
  assert.equal(hasActiveCampusFilters(parseCampusFilters({ q: "   " })), false);
});

test("search and status combine rather than replace each other", () => {
  // "Old Town" matches the text and is excluded by the status; a filter that
  // replaced rather than narrowed would put it back.
  const filters = parseCampusFilters({ q: "o", status: "open" });
  assert.equal(hasActiveCampusFilters(filters), true);
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, filters)), ["c1", "c2"]);
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, parseCampusFilters({ q: "o" }))), [
    "c1",
    "c2",
    "c3",
  ]);
});

test("a repeated parameter collapses to the first value", () => {
  const filters = parseCampusFilters({ q: ["north", "main"], status: ["open", "closed"] });
  assert.deepEqual(filters, { q: "north", status: "open" });
});

test("a campus with no address on file is not excluded by a search", () => {
  // The null address must be treated as an empty string, not skipped with a
  // throw or matched by every query.
  const filters = parseCampusFilters({ q: "wing" });
  assert.deepEqual(ids(applyCampusFilters(CAMPUSES, filters)), ["c2"]);
});

test("nothing matching returns an empty list rather than the unfiltered one", () => {
  const filters = parseCampusFilters({ q: "campus that does not exist" });
  assert.deepEqual(applyCampusFilters(CAMPUSES, filters), []);
});
