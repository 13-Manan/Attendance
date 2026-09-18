import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_PAGE_SIZE,
  MAX_WINDOW_DAYS,
  buildReportExport,
  collectForExport,
  getLowAttendance,
  getOverview,
  getRecords,
  getRollup,
  isReportKind,
  normalizeFilters,
  normalizePage,
  resolveScope,
  resolveThreshold,
} from "./service.ts";
import type { ReportingDeps } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { ReportPage } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeUser(permissions: string[], institutionId: string | null = "inst-A"): SessionUser {
  return {
    userId: "user-1",
    email: "admin@example.com",
    name: "Admin",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const ADMIN = makeUser(["institution.read", "attendanceRecord.read"]);

function institution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: "inst-A",
    name: "Bench College",
    type: "COLLEGE",
    settings: {},
    ...overrides,
  } as Institution;
}

const WINDOW = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-07-01T00:00:00Z") };

/** Every dep stubbed to an empty result, so a test overrides only what it means to assert on. */
function baseDeps(overrides: ReportingDeps = {}): ReportingDeps {
  return {
    getInstitutionById: async () => institution(),
    aggregateByDimension: async () => [],
    countSessionsByDimension: async () => [],
    listLowAttendanceStudents: async () => [],
    countLowAttendanceStudents: async () => [{ count: 0 }],
    listRecords: async () => [],
    countRecords: async () => [{ count: 0 }],
    aggregateOverall: async () => [{ present: 0, absent: 0 }],
    countInstitutionEntities: async () => ({ students: 0, cohorts: 0, sessionsAwaitingReview: 0 }),
    countFinalizedSessions: async () => 0,
    countSessionsAwaitingConfirmation: async () => 0,
    listFilterOptions: async () => ({ cohorts: [], academicUnits: [], subjects: [], faculty: [] }),
    loadUnitTreeRows: async () => ({ units: [], cohorts: [] }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("institution.read alone is not enough to read an attendance report", async () => {
  let queried = false;
  const deps = baseDeps({
    aggregateByDimension: async () => {
      queried = true;
      return [];
    },
  });
  await assert.rejects(
    () => getRollup(makeUser(["institution.read"]), "cohort", WINDOW, { page: 1, pageSize: 25 }, "label", deps),
    ForbiddenError,
  );
  assert.equal(queried, false, "the denial must precede any query");
});

test("attendanceRecord.read alone is not enough either", async () => {
  await assert.rejects(
    () =>
      getRollup(
        makeUser(["attendanceRecord.read"]),
        "cohort",
        WINDOW,
        { page: 1, pageSize: 25 },
        "label",
        baseDeps(),
      ),
    ForbiddenError,
  );
});

test("a student cannot reach institution-wide records", async () => {
  // The student portal's own permission grants nothing here: a report is
  // institution-wide by construction, and `attendanceRecord.read.own` is not
  // `attendanceRecord.read`.
  await assert.rejects(
    () =>
      getRecords(
        makeUser(["attendanceRecord.read.own"]),
        WINDOW,
        { page: 1, pageSize: 25 },
        baseDeps(),
      ),
    ForbiddenError,
  );
});

test("a platform user with no institution cannot report on one", async () => {
  // Every report is institution-scoped. Someone with the permissions but no
  // institution of their own has nothing to scope to, and must not fall
  // through to an unscoped query.
  await assert.rejects(
    () =>
      getOverview(
        makeUser(["institution.read", "attendanceRecord.read"], null),
        WINDOW,
        undefined,
        baseDeps(),
      ),
    ForbiddenError,
  );
});

test("the institution comes from the session, not from the caller", async () => {
  let seen: string | null = null;
  await getRollup(ADMIN, "cohort", WINDOW, { page: 1, pageSize: 25 }, "label", baseDeps({
    aggregateByDimension: async (institutionId) => {
      seen = institutionId;
      return [];
    },
  }));
  assert.equal(seen, "inst-A");
});

// ---------------------------------------------------------------------------
// Filter normalization
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-16T11:30:00Z");

test("an absent window defaults to the last 30 days, ending today", () => {
  const filters = normalizeFilters({}, NOW);
  assert.equal(filters.to.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.equal(filters.from.toISOString(), "2026-08-18T00:00:00.000Z");
  const days = (filters.to.getTime() - filters.from.getTime()) / 86_400_000;
  assert.equal(days, DEFAULT_WINDOW_DAYS);
});

test("`to` is inclusive of the day the caller names", () => {
  // A user asking for "up to 30 June" means the 30th is in the report. The
  // range is half-open internally, so the boundary moves to the next midnight.
  const filters = normalizeFilters({ from: "2026-06-01", to: "2026-06-30" }, NOW);
  assert.equal(filters.from.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(filters.to.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("an unparseable date falls back to the default window rather than erroring", () => {
  // A stale bookmark should still show this month's figures, not an error page.
  const filters = normalizeFilters({ from: "not-a-date", to: "also-not" }, NOW);
  assert.equal(filters.to.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.ok(filters.from < filters.to);
});

test("an over-long range is clamped back from `to`, never widened", () => {
  const filters = normalizeFilters({ from: "2000-01-01", to: "2026-09-16" }, NOW);
  const days = (filters.to.getTime() - filters.from.getTime()) / 86_400_000;
  assert.equal(days, MAX_WINDOW_DAYS);
  assert.equal(filters.to.toISOString(), "2026-09-17T00:00:00.000Z");
});

test("a reversed range is repaired instead of returning nothing", () => {
  const filters = normalizeFilters({ from: "2026-06-30", to: "2026-06-01" }, NOW);
  assert.ok(filters.from < filters.to, "from must precede to after normalization");
});

test("an unknown attendance status is dropped, not passed to SQL", () => {
  const filters = normalizeFilters({ results: ["PRESENT", "SOMETHING_ELSE", "PRESENT"] }, NOW);
  assert.deepEqual(filters.results, ["PRESENT"]);
});

test("blank and duplicate ids are cleaned out of every id filter", () => {
  const filters = normalizeFilters({ cohortIds: ["a", " a ", "", "  ", "b"] }, NOW);
  assert.deepEqual(filters.cohortIds, ["a", "b"]);
  // An all-blank filter becomes absent rather than an empty list, which would
  // mean "match nothing".
  assert.equal(normalizeFilters({ cohortIds: ["", " "] }, NOW).cohortIds, undefined);
});

test("page size is clamped and page number floors at 1", () => {
  assert.deepEqual(normalizePage({}), { page: 1, pageSize: 25 });
  assert.deepEqual(normalizePage({ page: -5, pageSize: 10_000 }), { page: 1, pageSize: MAX_PAGE_SIZE });
  assert.deepEqual(normalizePage({ page: 3.7, pageSize: 50 }), { page: 3, pageSize: 50 });
});

// ---------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------

test("the threshold comes from institution settings, not from a literal", async () => {
  const deps = baseDeps({
    getInstitutionById: async () => institution({ settings: { lowAttendanceThreshold: 80 } }),
  });
  assert.equal(await resolveThreshold("inst-A", undefined, deps), 80);
});

test("an institution that has not configured one gets the platform default", async () => {
  assert.equal(await resolveThreshold("inst-A", undefined, baseDeps()), 75);
});

test("an explicit override is honoured but clamped to a percentage", async () => {
  const deps = baseDeps();
  assert.equal(await resolveThreshold("inst-A", 90, deps), 90);
  assert.equal(await resolveThreshold("inst-A", 150, deps), 100);
  assert.equal(await resolveThreshold("inst-A", -10, deps), 0);
  // NaN is not a threshold; fall back rather than compare everything to NaN,
  // which would silently return an empty low-attendance list.
  assert.equal(await resolveThreshold("inst-A", Number.NaN, deps), 75);
});

test("the threshold the report used is reported alongside the rows", async () => {
  // The number is stated, not assumed. A list headed "low attendance" with no
  // stated rule invites the reader to supply their own.
  const deps = baseDeps({
    getInstitutionById: async () => institution({ settings: { lowAttendanceThreshold: 60 } }),
  });
  const page = await getLowAttendance(ADMIN, WINDOW, { page: 1, pageSize: 25 }, undefined, deps);
  assert.equal(page.threshold, 60);
});

test("the resolved threshold is what reaches the query", async () => {
  let passed: number | undefined;
  const deps = baseDeps({
    getInstitutionById: async () => institution({ settings: { lowAttendanceThreshold: 80 } }),
    listLowAttendanceStudents: async (_i, _f, _s, threshold) => {
      passed = threshold;
      return [];
    },
  });
  await getLowAttendance(ADMIN, WINDOW, { page: 1, pageSize: 25 }, undefined, deps);
  assert.equal(passed, 80);
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

const TREE_ROWS = {
  units: [
    { id: "grade-8", parentId: null, kind: "GRADE" as const },
    { id: "sec-8a", parentId: "grade-8", kind: "SECTION" as const },
    { id: "sec-8b", parentId: "grade-8", kind: "SECTION" as const },
  ],
  cohorts: [
    { id: "c-8a", academicUnitId: "sec-8a" },
    { id: "c-8b", academicUnitId: "sec-8b" },
  ],
};

test("no unit filter and no unit dimension reads no tree at all", async () => {
  // The cheapest query is the one that does not run. A cohort-wise or
  // faculty-wise rollup needs nothing from the academic tree.
  let loaded = false;
  const deps = baseDeps({
    loadUnitTreeRows: async () => {
      loaded = true;
      return TREE_ROWS;
    },
  });
  const scope = await resolveScope("inst-A", "faculty", WINDOW, deps);
  assert.equal(loaded, false);
  assert.deepEqual(scope, { cohortIds: null, buckets: null });
});

test("a unit filter is resolved to cohort ids before any attendance query", async () => {
  const deps = baseDeps({ loadUnitTreeRows: async () => TREE_ROWS });
  const scope = await resolveScope("inst-A", null, { ...WINDOW, academicUnitIds: ["grade-8"] }, deps);
  assert.deepEqual(scope.cohortIds?.sort(), ["c-8a", "c-8b"]);
  assert.equal(scope.buckets, null);
});

test("a unit dimension produces cohort-to-bucket pairs", async () => {
  const deps = baseDeps({ loadUnitTreeRows: async () => TREE_ROWS });
  const scope = await resolveScope("inst-A", "grade", WINDOW, deps);
  assert.deepEqual(scope.buckets, [
    ["c-8a", "grade-8"],
    ["c-8b", "grade-8"],
  ]);
});

test("a cohort filter and a unit filter intersect rather than union", async () => {
  // Asking for "Grade 8" and "class 8A" means 8A. Asking for "Grade 8" and a
  // cohort outside it is a contradiction and must return nothing.
  const deps = baseDeps({ loadUnitTreeRows: async () => TREE_ROWS });
  const narrowed = await resolveScope(
    "inst-A",
    null,
    { ...WINDOW, academicUnitIds: ["grade-8"], cohortIds: ["c-8a"] },
    deps,
  );
  assert.deepEqual(narrowed.cohortIds, ["c-8a"]);

  const contradiction = await resolveScope(
    "inst-A",
    null,
    { ...WINDOW, academicUnitIds: ["grade-8"], cohortIds: ["c-elsewhere"] },
    deps,
  );
  assert.deepEqual(contradiction.cohortIds, [], "an empty list means no results, not no filter");
});

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

test("a rollup row reports a rate computed from present and absent only", async () => {
  const deps = baseDeps({
    aggregateByDimension: async () => [
      {
        key: "c-1",
        label: "CS 3A",
        sublabel: "2026-1",
        present: 90,
        absent: 10,
        unresolved: 7,
        totalRows: 1,
      },
    ],
    countSessionsByDimension: async () => [{ key: "c-1", sessions: 12 }],
  });
  const page = await getRollup(ADMIN, "cohort", WINDOW, { page: 1, pageSize: 25 }, "label", deps);
  assert.equal(page.rows[0].rate.percentage, 90);
  assert.equal(page.rows[0].rate.total, 100, "unresolved rows are not in the denominator");
  // Carried rather than dropped, so a reader can see that 7 rows still owe a
  // human decision instead of assuming the register is settled.
  assert.equal(page.rows[0].unresolved, 7);
  assert.equal(page.rows[0].sessionCount, 12);
});

test("a group with nothing decided has no rate, not a rate of zero", async () => {
  const deps = baseDeps({
    aggregateByDimension: async () => [
      { key: "c-1", label: "New class", sublabel: null, present: 0, absent: 0, unresolved: 4, totalRows: 1 },
    ],
  });
  const page = await getRollup(ADMIN, "cohort", WINDOW, { page: 1, pageSize: 25 }, "label", deps);
  assert.equal(page.rows[0].rate.percentage, null);
});

test("a group the session count query did not return is 0 sessions, not null", async () => {
  // null is reserved for "this dimension has no session count" (student);
  // a dimension that has one and returned no row for this group means zero.
  const deps = baseDeps({
    aggregateByDimension: async () => [
      { key: "c-1", label: "CS 3A", sublabel: null, present: 1, absent: 0, unresolved: 0, totalRows: 1 },
    ],
    countSessionsByDimension: async () => [{ key: "c-2", sessions: 5 }],
  });
  const page = await getRollup(ADMIN, "cohort", WINDOW, { page: 1, pageSize: 25 }, "label", deps);
  assert.equal(page.rows[0].sessionCount, 0);
});

test("the student dimension reports no session count at all", async () => {
  const deps = baseDeps({
    aggregateByDimension: async () => [
      { key: "s-1", label: "Aisha Khan", sublabel: "S001", present: 8, absent: 2, unresolved: 0, totalRows: 1 },
    ],
    countSessionsByDimension: async () => [],
  });
  const page = await getRollup(ADMIN, "student", WINDOW, { page: 1, pageSize: 25 }, "label", deps);
  assert.equal(page.rows[0].sessionCount, null);
});

test("a status filter never reaches a rollup", async () => {
  // A percentage computed over "the absent rows" is 0% by construction, which
  // reads as a collapse rather than as a filtered view.
  let seenResults: unknown;
  const deps = baseDeps({
    aggregateByDimension: async (_i, _d, filters) => {
      seenResults = filters.results;
      return [];
    },
  });
  await getRollup(
    ADMIN,
    "cohort",
    { ...WINDOW, results: ["ABSENT"] },
    { page: 1, pageSize: 25 },
    "label",
    deps,
  );
  // The service passes filters through untouched; the repository's rollup
  // conditions are what ignore `results`. This asserts the contract the
  // repository relies on: the filter is not stripped on the way in.
  assert.deepEqual(seenResults, ["ABSENT"]);
});

test("paging reports the total from the count query, not the page length", async () => {
  const deps = baseDeps({
    listRecords: async () => [],
    countRecords: async () => [{ count: 4_312 }],
  });
  const page = await getRecords(ADMIN, WINDOW, { page: 2, pageSize: 25 }, deps);
  assert.equal(page.totalRows, 4_312);
  assert.equal(page.hasMore, true);
});

test("hasMore is false on the last page", async () => {
  const deps = baseDeps({ countRecords: async () => [{ count: 40 }] });
  const page = await getRecords(ADMIN, WINDOW, { page: 2, pageSize: 25 }, deps);
  assert.equal(page.hasMore, false);
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

test("today's headline counts confirmed registers only", async () => {
  // An unconfirmed register has no result the faculty member has stood behind
  // yet. Its rows are carried as a pending count, never folded into a rate.
  const deps = baseDeps({
    aggregateOverall: async (_i, filters) =>
      filters.from.getTime() === new Date("2026-09-16T00:00:00Z").getTime()
        ? [{ present: 40, absent: 10 }]
        : [{ present: 900, absent: 100 }],
    countSessionsAwaitingConfirmation: async () => 6,
    now: () => NOW,
  });
  const overview = await getOverview(ADMIN, WINDOW, undefined, deps);
  assert.equal(overview.overall.percentage, 90);
  assert.equal(overview.today.percentage, 80);
  assert.equal(overview.todayAwaitingConfirmation, 6);
});

test("the overview states the threshold it counted against", async () => {
  const deps = baseDeps({
    getInstitutionById: async () => institution({ settings: { lowAttendanceThreshold: 85 } }),
    countLowAttendanceStudents: async () => [{ count: 31 }],
    now: () => NOW,
  });
  const overview = await getOverview(ADMIN, WINDOW, undefined, deps);
  assert.equal(overview.lowAttendanceThreshold, 85);
  assert.equal(overview.lowAttendanceCount, 31);
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test("isReportKind accepts exactly the three reports", () => {
  assert.equal(isReportKind("rollup"), true);
  assert.equal(isReportKind("low-attendance"), true);
  assert.equal(isReportKind("records"), true);
  assert.equal(isReportKind("everything"), false);
});

test("collectForExport walks pages until the result set is exhausted", async () => {
  const requested: number[] = [];
  const result = await collectForExport(async ({ page, pageSize }) => {
    requested.push(page);
    const rows = page < 3 ? Array.from({ length: pageSize }, (_, i) => `p${page}-${i}`) : ["last"];
    return { rows, page, pageSize, totalRows: 2 * pageSize + 1, hasMore: page < 3 };
  });
  assert.deepEqual(requested, [1, 2, 3]);
  assert.equal(result.truncated, false);
  assert.equal(result.rows.at(-1), "last");
});

test("collectForExport stops at the ceiling and says so", async () => {
  // A spreadsheet quietly missing its last 10,000 rows is worse than one that
  // admits it is partial.
  const result = await collectForExport(
    async ({ page, pageSize }) => ({
      rows: Array.from({ length: pageSize }, (_, i) => `r${page}-${i}`),
      page,
      pageSize,
      totalRows: 100_000,
      hasMore: true,
    }),
    10,
  );
  assert.equal(result.rows.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.totalRows, 100_000);
});

test("collectForExport does not loop forever on a page that returns nothing", async () => {
  let calls = 0;
  const result = await collectForExport(async ({ page, pageSize }) => {
    calls += 1;
    return { rows: [], page, pageSize, totalRows: 500, hasMore: true } as ReportPage<string>;
  });
  assert.equal(calls, 1);
  assert.equal(result.rows.length, 0);
});

test("an export is denied for the same actors the screen denies", async () => {
  // The export must not be a second, weaker door to the same data.
  await assert.rejects(
    () =>
      buildReportExport(
        makeUser(["attendanceRecord.read.own"]),
        "records",
        "cohort",
        WINDOW,
        "csv",
        {},
        baseDeps(),
      ),
    ForbiddenError,
  );
});

test("a CSV export carries the same rows the screen would show", async () => {
  const deps = baseDeps({
    listRecords: async () => [
      {
        attendanceRecordId: "ar-1",
        sessionId: "s-1",
        sessionDate: new Date("2026-06-15T09:00:00Z"),
        studentId: "st-1",
        studentCode: "S001",
        studentName: "Aisha Khan",
        cohortName: "CS 3A",
        subjectName: "Databases",
        subjectCode: "CS301",
        facultyName: "Dr Rao",
        result: "PRESENT",
        isManuallyCorrected: true,
      },
    ],
    countRecords: async () => [{ count: 1 }],
  });
  const file = await buildReportExport(ADMIN, "records", "cohort", WINDOW, "csv", {}, deps);
  const text = file.body.toString("utf8");
  assert.match(text, /S001,Aisha Khan,CS 3A,Databases,CS301,Dr Rao,PRESENT,Yes/);
  assert.match(text, /^﻿Date,Student code,/);
  assert.equal(file.truncated, false);
});

test("the export filename names the report and its window", async () => {
  // A spreadsheet outlives the URL that produced it, so it has to identify
  // itself a year later.
  const file = await buildReportExport(
    ADMIN,
    "rollup",
    "course",
    { from: new Date("2026-06-18T00:00:00Z"), to: new Date("2026-09-17T00:00:00Z") },
    "xlsx",
    {},
    baseDeps(),
  );
  assert.equal(file.filename, "attendance-by-course-2026-06-18-to-2026-09-16.xlsx");
});

test("a low-attendance export is headed by the threshold it used", async () => {
  const deps = baseDeps({
    getInstitutionById: async () => institution({ settings: { lowAttendanceThreshold: 80 } }),
    listLowAttendanceStudents: async () => [
      {
        studentId: "st-1",
        studentCode: "S001",
        studentName: "Aisha Khan",
        cohortName: "CS 3A",
        present: 6,
        absent: 4,
        totalRows: 1,
      },
    ],
  });
  const file = await buildReportExport(ADMIN, "low-attendance", "cohort", WINDOW, "csv", {}, deps);
  assert.match(file.body.toString("utf8"), /S001,Aisha Khan,CS 3A,60/);
});
