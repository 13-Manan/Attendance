import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ancestorsOrSelf,
  bucketCohortsByKind,
  buildUnitTree,
  cohortsUnderUnits,
  intersectCohortFilters,
} from "./unit-tree.ts";
import type { CohortRow, UnitRow } from "./unit-tree.ts";

/**
 * The academic tree used to be a recursive CTE. It is plain TypeScript now,
 * which is the whole reason these tests can exist — every case below would
 * otherwise need a seeded database.
 *
 * The shape: a college on the left, a school on the right, deliberately in one
 * institution so that the "a cohort has no ancestor of this kind" cases are
 * real rather than contrived.
 *
 *   dept-cs (DEPARTMENT)          grade-8 (GRADE)
 *     └ sem-3 (SEMESTER)            ├ sec-8a (SECTION)
 *         └ course-btech (COURSE)   └ sec-8b (SECTION)
 *             └ cohort: c-btech3
 *                                   cohorts: c-8a, c-8b
 */
const UNITS: UnitRow[] = [
  { id: "dept-cs", parentId: null, kind: "DEPARTMENT" },
  { id: "sem-3", parentId: "dept-cs", kind: "SEMESTER" },
  { id: "course-btech", parentId: "sem-3", kind: "COURSE" },
  { id: "grade-8", parentId: null, kind: "GRADE" },
  { id: "sec-8a", parentId: "grade-8", kind: "SECTION" },
  { id: "sec-8b", parentId: "grade-8", kind: "SECTION" },
];

const COHORTS: CohortRow[] = [
  { id: "c-btech3", academicUnitId: "course-btech" },
  { id: "c-8a", academicUnitId: "sec-8a" },
  { id: "c-8b", academicUnitId: "sec-8b" },
];

const tree = buildUnitTree(UNITS, COHORTS);

test("ancestorsOrSelf walks to the root, nearest first", () => {
  assert.deepEqual(ancestorsOrSelf(tree, "course-btech"), ["course-btech", "sem-3", "dept-cs"]);
  assert.deepEqual(ancestorsOrSelf(tree, "dept-cs"), ["dept-cs"]);
});

test("ancestorsOrSelf terminates on a cycle instead of hanging", () => {
  // The schema cannot express "no cycles" in a self-referencing parent link,
  // so a corrupt row must not become an infinite loop inside a request.
  const cyclic = buildUnitTree(
    [
      { id: "a", parentId: "b", kind: "DEPARTMENT" },
      { id: "b", parentId: "a", kind: "DEPARTMENT" },
    ],
    [],
  );
  assert.deepEqual(ancestorsOrSelf(cyclic, "a"), ["a", "b"]);
});

test("ancestorsOrSelf stops at a parent that is not in the tree", () => {
  // A unit whose parent belongs to another institution is not followed: the
  // loaded rows are institution-scoped, and a missing parent must end the walk
  // rather than crash it.
  const orphan = buildUnitTree([{ id: "x", parentId: "elsewhere", kind: "SECTION" }], []);
  assert.deepEqual(ancestorsOrSelf(orphan, "x"), ["x"]);
});

test("bucketCohortsByKind maps each cohort to its ancestor of that kind", () => {
  assert.deepEqual(bucketCohortsByKind(tree, "DEPARTMENT"), [["c-btech3", "dept-cs"]]);
  assert.deepEqual(bucketCohortsByKind(tree, "GRADE"), [
    ["c-8a", "grade-8"],
    ["c-8b", "grade-8"],
  ]);
});

test("a cohort with no ancestor of that kind is absent, not bucketed as unassigned", () => {
  // The college cohort has no GRADE above it. Inventing a bucket for it would
  // put a number under a heading that does not apply to it.
  const byGrade = bucketCohortsByKind(tree, "GRADE");
  assert.equal(
    byGrade.some(([cohortId]) => cohortId === "c-btech3"),
    false,
  );
});

test("a college asking for a grade-wise rollup gets no buckets at all", () => {
  const collegeOnly = buildUnitTree(
    UNITS.filter((u) => u.id.startsWith("dept") || u.id.startsWith("sem") || u.id.startsWith("course")),
    [{ id: "c-btech3", academicUnitId: "course-btech" }],
  );
  // The empty result is what lets the repository short-circuit to zero
  // queries rather than emit `VALUES ()`.
  assert.deepEqual(bucketCohortsByKind(collegeOnly, "GRADE"), []);
});

test("the nearest ancestor wins when a chain holds two units of one kind", () => {
  const nested = buildUnitTree(
    [
      { id: "outer", parentId: null, kind: "SECTION" },
      { id: "inner", parentId: "outer", kind: "SECTION" },
    ],
    [{ id: "c", academicUnitId: "inner" }],
  );
  assert.deepEqual(bucketCohortsByKind(nested, "SECTION"), [["c", "inner"]]);
});

test("cohortsUnderUnits selects everything below a unit, at any depth", () => {
  assert.deepEqual(cohortsUnderUnits(tree, ["grade-8"]).sort(), ["c-8a", "c-8b"]);
  assert.deepEqual(cohortsUnderUnits(tree, ["dept-cs"]), ["c-btech3"]);
  assert.deepEqual(cohortsUnderUnits(tree, ["sec-8a"]), ["c-8a"]);
});

test("cohortsUnderUnits returns empty for a unit with nothing under it", () => {
  // Empty means "no results", not "no filter" — the distinction decides
  // whether an over-narrow filter shows an empty report or the whole
  // institution.
  assert.deepEqual(cohortsUnderUnits(tree, ["sem-3", "unknown-unit"]), ["c-btech3"]);
  assert.deepEqual(cohortsUnderUnits(tree, ["unknown-unit"]), []);
});

test("intersectCohortFilters narrows rather than widening", () => {
  // Both filters narrow, so asking for "Grade 8" and "class 9C" is a
  // contradiction that must return nothing.
  assert.deepEqual(intersectCohortFilters(["c-9c"], ["c-8a", "c-8b"]), []);
  assert.deepEqual(intersectCohortFilters(["c-8a", "c-9c"], ["c-8a", "c-8b"]), ["c-8a"]);
});

test("intersectCohortFilters distinguishes an absent filter from an empty one", () => {
  // null means "the whole institution"; [] means "nothing matched".
  assert.equal(intersectCohortFilters(undefined, null), null);
  assert.deepEqual(intersectCohortFilters(["c-8a"], null), ["c-8a"]);
  assert.deepEqual(intersectCohortFilters(undefined, []), []);
  assert.deepEqual(intersectCohortFilters([], []), []);
});
