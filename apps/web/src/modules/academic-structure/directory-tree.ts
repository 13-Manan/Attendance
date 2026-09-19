import type { ParentChoice, UnitRow, UnitTreeNode } from "./directory-types";

/**
 * Turning a flat list of units into the tree it describes.
 *
 * Pure — no Prisma, no session — so the ordering and the orphan handling can be
 * tested without a database.
 *
 * `service.ts` already has a `buildAcademicUnitTree` for the raw Prisma row.
 * This one is for the administrative row, which carries the counts and a depth,
 * and it differs in one way that matters: a unit whose parent is missing from
 * the list is surfaced at the top rather than dropped. Dropping it would hide a
 * grade from the only screen that can fix it.
 */

function compare(a: UnitRow, b: UnitRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  // Two units with the same name and order are indistinguishable otherwise,
  // and an unstable order makes the page move under the reader.
  return a.id.localeCompare(b.id);
}

export function buildUnitTree(rows: UnitRow[]): UnitTreeNode[] {
  const byId = new Map<string, UnitTreeNode>();
  for (const row of rows) byId.set(row.id, { ...row, children: [], depth: 0 });

  const roots: UnitTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const setDepth = (nodes: UnitTreeNode[], depth: number) => {
    nodes.sort(compare);
    for (const node of nodes) {
      node.depth = depth;
      setDepth(node.children, depth + 1);
    }
  };
  setDepth(roots, 0);

  return roots;
}

/** The tree as rows, parents immediately before their children. */
export function flattenUnitTree(nodes: UnitTreeNode[]): UnitTreeNode[] {
  const out: UnitTreeNode[] = [];
  const walk = (list: UnitTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The tree as a dropdown: indented, in reading order.
 *
 * Every unit can be a parent, including one that already has children — a
 * college nests a department inside nothing and a semester inside a course, and
 * which nesting is meaningful is the institution's business, not ours.
 */
export function toParentChoices(nodes: UnitTreeNode[]): ParentChoice[] {
  return flattenUnitTree(nodes).map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    depth: node.depth,
  }));
}
