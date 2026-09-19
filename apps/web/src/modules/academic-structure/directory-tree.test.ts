import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnitTree, flattenUnitTree, toParentChoices } from "./directory-tree.ts";
import type { UnitRow } from "./directory-types.ts";

/**
 * Turning a flat list of units into the tree it describes.
 *
 * The cases that matter are the ones a database will eventually produce and a
 * naive grouping gets wrong: a unit whose parent is not in the list, a parent
 * that appears after its child, and two units that sort identically.
 */

function row(overrides: Partial<UnitRow> & { id: string }): UnitRow {
  return {
    name: overrides.id,
    kind: "GENERIC",
    code: null,
    sortOrder: 0,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    parentId: null,
    parentName: null,
    campusId: null,
    campusName: null,
    cohortCount: 0,
    childCount: 0,
    facultyCount: 0,
    ...overrides,
  };
}

test("children are nested under their parent and given a depth", () => {
  const tree = buildUnitTree([
    row({ id: "dept", name: "Computer Science", kind: "DEPARTMENT" }),
    row({ id: "sem", name: "Semester 3", kind: "SEMESTER", parentId: "dept" }),
    row({ id: "sec", name: "A", kind: "SECTION", parentId: "sem" }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "dept");
  assert.equal(tree[0].depth, 0);
  assert.equal(tree[0].children[0].id, "sem");
  assert.equal(tree[0].children[0].depth, 1);
  assert.equal(tree[0].children[0].children[0].id, "sec");
  assert.equal(tree[0].children[0].children[0].depth, 2);
});

test("a parent listed after its child is still a parent", () => {
  // The repository orders for reading, not for tree-building, so arrival order
  // cannot be relied on.
  const tree = buildUnitTree([
    row({ id: "child", parentId: "parent" }),
    row({ id: "parent" }),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "parent");
  assert.equal(tree[0].children[0].id, "child");
});

test("a unit whose parent is missing surfaces at the top instead of vanishing", () => {
  // Dropping it would hide it from the only screen that can fix it.
  const tree = buildUnitTree([row({ id: "orphan", parentId: "not-in-this-list" })]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "orphan");
  assert.equal(tree[0].depth, 0);
});

test("siblings sort by order, then name, then id", () => {
  const tree = buildUnitTree([
    row({ id: "c", name: "Zeta", sortOrder: 1 }),
    row({ id: "a", name: "Alpha", sortOrder: 2 }),
    row({ id: "b", name: "Alpha", sortOrder: 2 }),
  ]);

  // sortOrder first...
  assert.deepEqual(
    tree.map((n) => n.id),
    ["c", "a", "b"],
  );
});

test("two units with the same order and name keep a stable order", () => {
  const input = [
    row({ id: "b2", name: "A", sortOrder: 0 }),
    row({ id: "a1", name: "A", sortOrder: 0 }),
  ];
  const first = buildUnitTree(input).map((n) => n.id);
  const second = buildUnitTree([...input].reverse()).map((n) => n.id);

  // Falling back to the id keeps the page from moving under the reader.
  assert.deepEqual(first, ["a1", "b2"]);
  assert.deepEqual(second, ["a1", "b2"]);
});

test("children are sorted too, not only roots", () => {
  const tree = buildUnitTree([
    row({ id: "p" }),
    row({ id: "second", name: "Second", sortOrder: 2, parentId: "p" }),
    row({ id: "first", name: "First", sortOrder: 1, parentId: "p" }),
  ]);

  assert.deepEqual(
    tree[0].children.map((n) => n.id),
    ["first", "second"],
  );
});

test("building a tree does not mutate the rows it was given", () => {
  const rows = [row({ id: "p" }), row({ id: "c", parentId: "p" })];
  buildUnitTree(rows);

  assert.equal("children" in rows[0], false);
  assert.equal("depth" in rows[0], false);
});

test("flattening puts a parent immediately before its children", () => {
  const tree = buildUnitTree([
    row({ id: "p1", name: "P1", sortOrder: 1 }),
    row({ id: "p1c", name: "C", parentId: "p1" }),
    row({ id: "p2", name: "P2", sortOrder: 2 }),
  ]);

  assert.deepEqual(
    flattenUnitTree(tree).map((n) => n.id),
    ["p1", "p1c", "p2"],
  );
});

test("an empty list is an empty tree", () => {
  assert.deepEqual(buildUnitTree([]), []);
  assert.deepEqual(flattenUnitTree([]), []);
  assert.deepEqual(toParentChoices([]), []);
});

test("every unit can be chosen as a parent, carrying its depth", () => {
  const tree = buildUnitTree([
    row({ id: "dept", name: "Computer Science", kind: "DEPARTMENT" }),
    row({ id: "sem", name: "Semester 3", kind: "SEMESTER", parentId: "dept" }),
  ]);

  // Including one that already has children: which nesting is meaningful is
  // the institution's business.
  assert.deepEqual(toParentChoices(tree), [
    { id: "dept", name: "Computer Science", kind: "DEPARTMENT", depth: 0 },
    { id: "sem", name: "Semester 3", kind: "SEMESTER", depth: 1 },
  ]);
});
