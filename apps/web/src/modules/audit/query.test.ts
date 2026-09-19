import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_ACTIONS,
  AUDIT_MODULES,
  auditModuleForAction,
  auditPagination,
  buildAuditWhere,
  EMPTY_AUDIT_FILTERS,
  hasActiveAuditFilters,
  parseAuditFilters,
} from "./query.ts";

/**
 * Filter semantics for the audit search.
 *
 * The property under test throughout is the same one: a filter either narrows
 * the query in the way the person meant, or it is dropped. What it must never
 * do is reach the database as a value that matches nothing, because an empty
 * result on a search screen reads as "that never happened".
 */

// ---------------------------------------------------------------------------
// The module catalogue
// ---------------------------------------------------------------------------

test("every action belongs to exactly one module", () => {
  const seen = new Map<string, string>();
  for (const group of AUDIT_MODULES) {
    for (const action of group.actions) {
      const previous = seen.get(action);
      assert.equal(previous, undefined, `${action} is in both ${previous} and ${group.key}`);
      seen.set(action, group.key);
    }
  }
  assert.equal(seen.size, AUDIT_ACTIONS.length);
});

test("module keys are unique", () => {
  const keys = AUDIT_MODULES.map((module) => module.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("a known action resolves to its module and an unknown one to null", () => {
  assert.equal(auditModuleForAction("attendance.finalized")?.key, "attendance");
  assert.equal(auditModuleForAction("institution.face_policy_updated")?.key, "settings");
  assert.equal(auditModuleForAction("something.invented"), null);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("an empty query string yields the empty filters", () => {
  assert.deepEqual(parseAuditFilters({}), EMPTY_AUDIT_FILTERS);
  assert.equal(hasActiveAuditFilters(EMPTY_AUDIT_FILTERS), false);
});

test("an unknown action or module is dropped rather than passed through", () => {
  const filters = parseAuditFilters({ action: "attendance.deleted", module: "payroll" });
  assert.equal(filters.action, "");
  assert.equal(filters.module, "");
  assert.equal(hasActiveAuditFilters(filters), false);
});

test("a known action and module survive parsing", () => {
  const filters = parseAuditFilters({ action: "auth.login.failure", module: "face" });
  assert.equal(filters.action, "auth.login.failure");
  assert.equal(filters.module, "face");
  assert.equal(hasActiveAuditFilters(filters), true);
});

test("a date that does not exist is dropped instead of rolling over into the next month", () => {
  // new Date("2026-02-31") is a valid Date in JavaScript — it becomes March 3.
  assert.equal(parseAuditFilters({ from: "2026-02-31" }).from, "");
  assert.equal(parseAuditFilters({ from: "not-a-date" }).from, "");
  assert.equal(parseAuditFilters({ from: "2026-2-9" }).from, "");
  assert.equal(parseAuditFilters({ from: "2026-02-28" }).from, "2026-02-28");
});

test("a reversed date range is read as the typo it is, not as an empty range", () => {
  const filters = parseAuditFilters({ from: "2026-06-30", to: "2026-06-01" });
  assert.equal(filters.from, "2026-06-01");
  assert.equal(filters.to, "2026-06-30");
});

test("page and page size fall back rather than producing a negative offset", () => {
  assert.equal(parseAuditFilters({ page: "0" }).page, 1);
  assert.equal(parseAuditFilters({ page: "-4" }).page, 1);
  assert.equal(parseAuditFilters({ page: "2.5" }).page, 1);
  assert.equal(parseAuditFilters({ page: "7" }).page, 7);
  assert.equal(parseAuditFilters({ pageSize: "1000" }).pageSize, EMPTY_AUDIT_FILTERS.pageSize);
  assert.equal(parseAuditFilters({ pageSize: "25" }).pageSize, 25);
});

test("whitespace-only values are treated as absent", () => {
  const filters = parseAuditFilters({ actorUserId: "   ", entityType: "\t", entityId: " " });
  assert.equal(hasActiveAuditFilters(filters), false);
});

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

test("the institution is always in the where clause and comes from the caller", () => {
  const where = buildAuditWhere("inst-1", parseAuditFilters({}));
  assert.equal(where.institutionId, "inst-1");
});

test("no query-string value can change the institution searched", () => {
  const where = buildAuditWhere(
    "inst-1",
    parseAuditFilters({ institutionId: "inst-2", actorUserId: "u-1" }),
  );
  assert.equal(where.institutionId, "inst-1");
});

test("a module filter expands to that module's actions", () => {
  const where = buildAuditWhere("inst-1", parseAuditFilters({ module: "settings" }));
  assert.deepEqual(where.action, {
    in: [
      "institution.profile_updated",
      "institution.attendance_policy_updated",
      "institution.face_policy_updated",
      "institution.face_enrollment_policy_updated",
    ],
  });
});

test("an explicit action wins over the module it belongs to", () => {
  const where = buildAuditWhere(
    "inst-1",
    parseAuditFilters({ module: "settings", action: "auth.logout" }),
  );
  assert.equal(where.action, "auth.logout");
});

test("the date range is half-open so the last day is included in full", () => {
  const where = buildAuditWhere(
    "inst-1",
    parseAuditFilters({ from: "2026-06-01", to: "2026-06-30" }),
  );
  assert.equal(where.createdAt?.gte?.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(where.createdAt?.lt?.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("a from-only range has no upper bound and a to-only range has no lower one", () => {
  const from = buildAuditWhere("inst-1", parseAuditFilters({ from: "2026-06-01" }));
  assert.ok(from.createdAt?.gte);
  assert.equal(from.createdAt?.lt, undefined);

  const to = buildAuditWhere("inst-1", parseAuditFilters({ to: "2026-06-01" }));
  assert.equal(to.createdAt?.gte, undefined);
  assert.ok(to.createdAt?.lt);
});

test("the resource filter matches on entity type and id", () => {
  const where = buildAuditWhere(
    "inst-1",
    parseAuditFilters({ entityType: "Student", entityId: "stu-1" }),
  );
  assert.equal(where.entityType, "Student");
  assert.equal(where.entityId, "stu-1");
});

test("an unset filter is absent from the query rather than present and empty", () => {
  const where = buildAuditWhere("inst-1", parseAuditFilters({}));
  assert.deepEqual(Object.keys(where), ["institutionId"]);
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test("a page past the end lands on the last page instead of on nothing", () => {
  const filters = parseAuditFilters({ page: "99", pageSize: "25" });
  const result = auditPagination(filters, 60);
  assert.equal(result.totalPages, 3);
  assert.equal(result.page, 3);
  assert.equal(result.skip, 50);
  assert.equal(result.take, 25);
});

test("an empty log still reports one page", () => {
  const result = auditPagination(parseAuditFilters({}), 0);
  assert.equal(result.totalPages, 1);
  assert.equal(result.page, 1);
  assert.equal(result.skip, 0);
});
