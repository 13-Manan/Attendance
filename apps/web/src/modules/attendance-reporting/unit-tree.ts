import type { AcademicUnitKind } from "@prisma/client";

/**
 * The academic tree, resolved in memory.
 *
 * This logic used to be a recursive CTE inside every report query, and moving
 * it out was the single largest measured win in the module. A reference to a
 * recursive CTE makes the whole query parallel-restricted, so the 327,480-row
 * aggregate underneath it ran single-threaded in a nested loop: 123 ms with
 * the CTE, 43 ms once the tree was resolved separately and the hot query saw
 * nothing but cohort ids (`scripts/report-bench/`).
 *
 * It is also the better shape on its own terms. "Which grade does 8B roll up
 * into" is a question about the academic structure, not about attendance, and
 * answering it here makes it plain TypeScript that a unit test can check
 * without a database. The tree is small — units and cohorts number in the
 * hundreds for a school and the low thousands for a university — so resolving
 * all of it costs one cheap pair of queries and a walk.
 */

export interface UnitRow {
  id: string;
  parentId: string | null;
  kind: AcademicUnitKind;
}

export interface CohortRow {
  id: string;
  academicUnitId: string;
}

export interface UnitTree {
  parentOf: Map<string, string | null>;
  kindOf: Map<string, AcademicUnitKind>;
  /** Cohort id to the unit it hangs off directly. */
  unitOfCohort: Map<string, string>;
}

export function buildUnitTree(units: UnitRow[], cohorts: CohortRow[]): UnitTree {
  return {
    parentOf: new Map(units.map((u) => [u.id, u.parentId])),
    kindOf: new Map(units.map((u) => [u.id, u.kind])),
    unitOfCohort: new Map(cohorts.map((c) => [c.id, c.academicUnitId])),
  };
}

/**
 * A unit and every ancestor above it, nearest first.
 *
 * Guarded against cycles. The schema cannot express "no cycles" in a
 * self-referencing parent link, and a cycle here would be an infinite loop
 * inside a request rather than a bad number on a page, so the walk tracks
 * what it has seen and stops. A cycle is a data problem for someone else to
 * fix; this function's job is to not hang because of it.
 *
 * Only units present in the tree are returned. The tree holds one
 * institution's units, so a `parentId` pointing outside it is either corrupt
 * data or another institution's unit — and since `cohortsUnderUnits` matches
 * caller-supplied ids against this chain, emitting such an id would let a
 * filter naming a foreign unit select local cohorts. The walk stops at the
 * institution boundary instead.
 */
export function ancestorsOrSelf(tree: UnitTree, unitId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = unitId;
  while (current && !seen.has(current) && tree.parentOf.has(current)) {
    seen.add(current);
    chain.push(current);
    current = tree.parentOf.get(current) ?? null;
  }
  return chain;
}

/**
 * Maps each cohort to the ancestor-or-self unit of the requested kind.
 *
 * A cohort with no such ancestor is simply absent — a college cohort has no
 * grade, and inventing an "Unassigned" bucket for it would put a number under
 * a heading that does not apply to it. Where a chain somehow holds two units
 * of the same kind, the nearest wins, which is what "the section this class
 * belongs to" means.
 */
export function bucketCohortsByKind(
  tree: UnitTree,
  kind: AcademicUnitKind,
): Array<[cohortId: string, unitId: string]> {
  const pairs: Array<[string, string]> = [];
  for (const [cohortId, unitId] of tree.unitOfCohort) {
    const match = ancestorsOrSelf(tree, unitId).find((id) => tree.kindOf.get(id) === kind);
    if (match) pairs.push([cohortId, match]);
  }
  return pairs;
}

/**
 * Every cohort sitting at or below any of the selected units.
 *
 * This is the `academicUnitIds` filter: picking a grade selects its sections,
 * picking a department selects everything under it. Returns an empty array
 * when nothing matches, which the caller must treat as "no results" rather
 * than as "no filter" — the distinction decides whether an over-narrow filter
 * shows an empty report or the whole institution.
 */
export function cohortsUnderUnits(tree: UnitTree, unitIds: string[]): string[] {
  const wanted = new Set(unitIds);
  const matched: string[] = [];
  for (const [cohortId, unitId] of tree.unitOfCohort) {
    if (ancestorsOrSelf(tree, unitId).some((id) => wanted.has(id))) matched.push(cohortId);
  }
  return matched;
}

/**
 * What the report queries are allowed to see of the academic structure: a list
 * of cohort ids, and — for a unit-wise rollup — which bucket each rolls into.
 */
export interface CohortScope {
  /**
   * The cohorts a report is restricted to, or null for "the whole
   * institution". Null rather than an exhaustive list on purpose: listing
   * every cohort would put one bound parameter per cohort into every query
   * for no gain, when `institutionId` already says the same thing.
   */
  cohortIds: string[] | null;
  /** Cohort-to-bucket pairs, set only for the five academic-unit dimensions. */
  buckets: Array<[cohortId: string, unitId: string]> | null;
}

/**
 * Combines an explicit cohort filter with a unit filter.
 *
 * Both narrow, so the result is their intersection: asking for "Grade 8" and
 * "class 9C" is a contradiction and must return nothing, not the union of the
 * two. An empty intersection stays an empty list — see `cohortsUnderUnits`.
 */
export function intersectCohortFilters(
  explicit: string[] | undefined,
  underUnits: string[] | null,
): string[] | null {
  if (!explicit?.length) return underUnits;
  if (!underUnits) return explicit;
  const allowed = new Set(underUnits);
  return explicit.filter((id) => allowed.has(id));
}
