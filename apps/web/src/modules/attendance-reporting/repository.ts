import { Prisma } from "@prisma/client";
import type { AcademicUnitKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ReportDimension, ReportFilters } from "./types";
import type { CohortScope } from "./unit-tree";

/**
 * Reporting queries.
 *
 * Unlike every other repository in this codebase these are raw SQL, and the
 * reason is measurable rather than stylistic. Prisma's query API cannot group
 * a model by a column of a related model, and every dimension this module
 * reports on — class, section, course, subject, faculty, day — lives on
 * `AttendanceSession` or beyond it, not on `AttendanceRecord`. The Phase 7
 * workaround was to fetch the rows and group them in JavaScript. Against a
 * seeded institution of 482,760 records that cost 5.5 s and 238 MB of heap;
 * the same rollup as a `GROUP BY` returned 36 rows in 29 ms.
 *
 * ## Injection
 *
 * Every value is bound as a parameter by `Prisma.sql`. The only SQL text that
 * varies is chosen from `DIMENSIONS` below — a closed, code-defined map — and
 * the caller's dimension string is narrowed by `isReportDimension` before it
 * ever reaches here. No caller input is ever concatenated into SQL.
 *
 * ## Four rules, each of them measured
 *
 * 1. **Group by a foreign key, join the name on afterwards.** Grouping the
 *    student rollup by `firstName || ' ' || lastName` made Postgres sort
 *    327,480 rows by a text key through 25 MB of temporary files (274 ms);
 *    grouping by `studentId` and naming the resulting 2,160 rows runs the
 *    same report in 25 ms.
 *
 * 2. **Never window over a raw row stream.** `count(*) OVER ()` on top of a
 *    grouped set is free — the groups are fully computed anyway to satisfy
 *    `ORDER BY`. On top of raw records it is ruinous, because a window
 *    function must see every row and so cancels the `LIMIT`'s top-N heapsort:
 *    316 ms against 29 ms + 13 ms for a separate `count(*)`.
 *
 * 3. **No recursive CTE in a hot query.** Referencing one makes the entire
 *    query parallel-restricted, which cost the unit-wise rollups their
 *    parallel index scan: 123 ms with the closure inline, 43 ms once the tree
 *    was resolved in TypeScript and the query saw only cohort ids. See
 *    `unit-tree.ts`.
 *
 * 4. **Let the planner see the date range.** Every query here goes through
 *    `reportQuery`, which runs it under `plan_cache_mode = force_custom_plan`.
 *    Without that, PostgreSQL switches to a parameter-blind generic plan on a
 *    statement's sixth execution and picks a nested loop on a 248x-low row
 *    estimate — 586 ms against 22 ms for the student rollup, 739 ms against
 *    32 ms for a filtered record page. The benchmark now runs each query six
 *    times for exactly this reason; an early version ran two and saw none of
 *    it.
 *
 * ## Shapes that were measured and rejected
 *
 *  - `count(DISTINCT s.id)` alongside the record aggregate: 291 ms vs 44 ms,
 *    because it forces a sort of the whole joined set to disk. Session counts
 *    are a separate 1 ms query over `AttendanceSession` alone instead.
 *  - Driving the join from a `MATERIALIZED` CTE of matching sessions, to
 *    "filter early": 21-78 ms vs 10-44 ms. Materializing hides the
 *    `institutionId` predicate from the planner, which then hash-joins the
 *    entire record table. Plain joins let it use the existing index.
 *
 * See `scripts/report-bench/` to reproduce all of it.
 */

// ---------------------------------------------------------------------------
// Academic structure
// ---------------------------------------------------------------------------

/**
 * The raw rows the unit tree is built from. Deliberately the whole
 * institution's structure and nothing else: two indexed reads of a few hundred
 * narrow rows, which is cheaper than any attempt to resolve the tree lazily.
 */
export function loadUnitTreeRows(institutionId: string) {
  return Promise.all([
    prisma.academicUnit.findMany({
      where: { institutionId },
      select: { id: true, parentId: true, kind: true },
    }),
    prisma.cohort.findMany({
      where: { institutionId },
      select: { id: true, academicUnitId: true },
    }),
  ]).then(([units, cohorts]) => ({ units, cohorts }));
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export const UNIT_KIND_BY_DIMENSION: Partial<Record<ReportDimension, AcademicUnitKind>> = {
  department: "DEPARTMENT",
  semester: "SEMESTER",
  course: "COURSE",
  grade: "GRADE",
  section: "SECTION",
};

interface DimensionSpec {
  /**
   * What to group by, evaluated against the record/session join. Always a
   * foreign key or a date bucket — never a name, never an expression built
   * from one. See rule 1 in the file header.
   */
  key: Prisma.Sql;
  /**
   * Joins the *key* needs, on top of `AttendanceSession`. Anything that exists
   * only to produce a readable name belongs in `decorate` instead.
   */
  keyJoins: Prisma.Sql;
  /**
   * Joins the grouped rows to whatever names them, aliased `d`. Runs against
   * the aggregate output — tens to a few thousand rows — not the record table.
   */
  decorate: Prisma.Sql;
  label: Prisma.Sql;
  sublabel: Prisma.Sql;
  /**
   * The same grouping expressed against `AttendanceSession` alone, used by the
   * session-count companion query. Null where the dimension has no meaning
   * without records — `student` is the only one.
   */
  sessionKey: Prisma.Sql | null;
  /** True when rows read best newest-first rather than alphabetically. */
  chronological: boolean;
}

/**
 * The cohort-to-bucket mapping, inlined as a `VALUES` list.
 *
 * One bound parameter per cohort per column, so an institution with 30,000
 * cohorts would exceed PostgreSQL's 65,535-parameter limit on a unit-wise
 * rollup. That is several orders of magnitude past any real institution, and
 * the failure would be a loud protocol error rather than a wrong number.
 */
function bucketJoin(buckets: Array<[string, string]>): Prisma.Sql {
  const rows = buckets.map(([cohortId, unitId]) => Prisma.sql`(${cohortId}, ${unitId})`);
  return Prisma.sql`
    JOIN (VALUES ${Prisma.join(rows)}) AS cu("cohortId", "ancId") ON cu."cohortId" = s."cohortId"`;
}

function unitDimension(buckets: Array<[string, string]>): DimensionSpec {
  const join = bucketJoin(buckets);
  return {
    key: Prisma.sql`cu."ancId"`,
    keyJoins: join,
    decorate: Prisma.sql`JOIN "AcademicUnit" d ON d.id = agg.key`,
    label: Prisma.sql`d.name`,
    sublabel: Prisma.sql`d.code`,
    sessionKey: Prisma.sql`cu."ancId"`,
    chronological: false,
  };
}

/**
 * Only `CohortSubject` is needed to identify the subject; `Subject` itself is
 * pure decoration. The join is inner, so DAILY sessions (which have no
 * `cohortSubjectId`) are absent from a subject-wise report rather than lumped
 * into a null subject.
 */
const SUBJECT_JOIN = Prisma.sql`JOIN "CohortSubject" cs ON cs.id = s."cohortSubjectId"`;

function dimensionSpec(dimension: ReportDimension, scope: CohortScope): DimensionSpec {
  switch (dimension) {
    // The five academic-unit dimensions differ only in which bucket each
    // cohort was mapped to, and the service has already done that mapping —
    // so they all produce the same SQL shape. Listed individually rather than
    // tested against `UNIT_KIND_BY_DIMENSION` so the switch stays exhaustive:
    // a twelfth dimension is then a compile error here, not a query that
    // returns nothing at runtime.
    case "department":
    case "semester":
    case "course":
    case "grade":
    case "section":
      return unitDimension(scope.buckets ?? []);
    case "cohort":
      return {
        key: Prisma.sql`s."cohortId"`,
        keyJoins: Prisma.empty,
        decorate: Prisma.sql`JOIN "Cohort" d ON d.id = agg.key`,
        label: Prisma.sql`d.name`,
        sublabel: Prisma.sql`d."termLabel"`,
        sessionKey: Prisma.sql`s."cohortId"`,
        chronological: false,
      };
    case "subject":
      return {
        key: Prisma.sql`cs."subjectId"`,
        keyJoins: SUBJECT_JOIN,
        decorate: Prisma.sql`JOIN "Subject" d ON d.id = agg.key`,
        label: Prisma.sql`d.name`,
        sublabel: Prisma.sql`d.code`,
        sessionKey: Prisma.sql`cs."subjectId"`,
        chronological: false,
      };
    case "faculty":
      // `AttendanceSession.facultyId` is NOT NULL and foreign-keyed, so
      // grouping on it and joining `User` afterwards selects exactly the rows
      // an inner join would — without hashing the user table against every
      // attendance record.
      return {
        key: Prisma.sql`s."facultyId"`,
        keyJoins: Prisma.empty,
        decorate: Prisma.sql`JOIN "User" d ON d.id = agg.key`,
        label: Prisma.sql`d.name`,
        sublabel: Prisma.sql`d."employeeCode"`,
        sessionKey: Prisma.sql`s."facultyId"`,
        chronological: false,
      };
    case "student":
      return {
        key: Prisma.sql`ar."studentId"`,
        keyJoins: Prisma.empty,
        decorate: Prisma.sql`JOIN "Student" d ON d.id = agg.key`,
        label: Prisma.sql`d."firstName" || ' ' || d."lastName"`,
        sublabel: Prisma.sql`d."studentCode"`,
        sessionKey: null,
        chronological: false,
      };
    case "day":
    case "month": {
      // Date buckets name themselves, so there is nothing to decorate.
      const format = dimension === "day" ? "YYYY-MM-DD" : "YYYY-MM";
      const bucket = Prisma.sql`to_char(s."sessionDate", ${format})`;
      return {
        key: bucket,
        keyJoins: Prisma.empty,
        decorate: Prisma.empty,
        label: Prisma.sql`agg.key`,
        sublabel: Prisma.sql`NULL`,
        sessionKey: bucket,
        chronological: true,
      };
    }
  }
}

/**
 * True when the dimension or the filters have narrowed the report to nothing
 * at all: a filter that matches no cohort, or a college asking for a
 * grade-wise rollup when no cohort sits under a GRADE.
 *
 * The queries return early on this rather than emitting `IN ()` or
 * `VALUES ()`, which are syntax errors — and, more importantly, rather than
 * dropping the predicate, which would silently widen an over-narrow filter
 * into a report on the whole institution.
 */
function scopeIsEmpty(dimension: ReportDimension, scope: CohortScope): boolean {
  if (scope.cohortIds?.length === 0) return true;
  return UNIT_KIND_BY_DIMENSION[dimension] !== undefined && scope.buckets?.length === 0;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * `sessionDate` is compared half-open. Both the record-side and session-side
 * `institutionId` predicates are present on purpose: the record-side one is
 * what lets the planner use `AttendanceRecord_institutionId_idx` (dropping it
 * produced a sequential scan in every measured plan), the session-side one
 * narrows the small table before the hash is built.
 */
function sessionConditions(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`s."institutionId" = ${institutionId}`,
    Prisma.sql`s.status = 'FINALIZED'::"SessionStatus"`,
    Prisma.sql`s."sessionDate" >= ${filters.from}`,
    Prisma.sql`s."sessionDate" < ${filters.to}`,
  ];
  // Already the intersection of the caller's cohort filter and whatever the
  // academic-unit filter resolved to; see `intersectCohortFilters`.
  if (scope.cohortIds?.length) {
    conditions.push(Prisma.sql`s."cohortId" IN (${Prisma.join(scope.cohortIds)})`);
  }
  if (filters.facultyIds?.length) {
    conditions.push(Prisma.sql`s."facultyId" IN (${Prisma.join(filters.facultyIds)})`);
  }
  if (filters.subjectIds?.length) {
    conditions.push(Prisma.sql`s."cohortSubjectId" IN (
      SELECT id FROM "CohortSubject" WHERE "subjectId" IN (${Prisma.join(filters.subjectIds)}))`);
  }
  return conditions;
}

function recordConditions(institutionId: string, filters: ReportFilters): Prisma.Sql[] {
  const conditions = [Prisma.sql`ar."institutionId" = ${institutionId}`];
  if (filters.studentIds?.length) {
    conditions.push(Prisma.sql`ar."studentId" IN (${Prisma.join(filters.studentIds)})`);
  }
  return conditions;
}

function and(conditions: Prisma.Sql[]): Prisma.Sql {
  return Prisma.join(conditions, " AND ");
}

function baseConditions(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
): Prisma.Sql {
  return and([
    ...recordConditions(institutionId, filters),
    ...sessionConditions(institutionId, filters, scope),
  ]);
}

/** Wraps the first stage of a group-then-name query. */
function withAgg(agg: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`WITH agg AS (${agg})`;
}

/**
 * A literal, never interpolated. `SET` does not accept bound parameters, so
 * this goes through `$executeRawUnsafe`; it is a compile-time constant with no
 * caller input in it.
 */
const FORCE_CUSTOM_PLAN = "SET LOCAL plan_cache_mode = force_custom_plan";

/**
 * Runs a reporting query with the planner allowed to see its parameters.
 *
 * Prisma prepares every `$queryRaw`. PostgreSQL plans a prepared statement
 * against real values five times, then switches to a parameter-blind *generic*
 * plan — so the generic plan is what a running server uses essentially always.
 * For these queries it is catastrophic: unable to see the date bounds, the
 * planner estimated a 5,458-row session scan at 22 rows, chose a nested loop
 * on the strength of that, and executed 5,458 index lookups into the record
 * table. Measured on the bench institution, the same `aggregateOverall` ran in
 * 15.8 ms with a custom plan and 107.9 ms without; the record listing was
 * worse, at 739 ms.
 *
 * `SET LOCAL` reverts when the transaction ends, so this touches nothing
 * outside the statement it wraps — no other module and no ORM query is
 * affected. The cost is one extra round trip and roughly 2 ms of planning per
 * call, which these queries repay many times over. That trade only holds
 * because reports are analytical, low-frequency and parameter-sensitive; it
 * would be the wrong default for the point lookups everywhere else in the
 * codebase, which is why it is scoped here rather than set on the connection.
 */
function reportQuery<T>(sql: Prisma.Sql): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(FORCE_CUSTOM_PLAN);
    return tx.$queryRaw<T>(sql);
  });
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

export interface RollupSqlRow {
  key: string | null;
  label: string | null;
  sublabel: string | null;
  present: number;
  absent: number;
  unresolved: number;
  totalRows: number;
}

export type RollupOrder = "label" | "rate";

/**
 * One dimension, aggregated in the database and paginated there too.
 *
 * Two stages. `agg` groups the record table by the dimension's foreign key and
 * nothing else; the outer query joins the names on and pages the result.
 */
export function aggregateByDimension(
  institutionId: string,
  dimension: ReportDimension,
  filters: ReportFilters,
  scope: CohortScope,
  order: RollupOrder,
  limit: number,
  offset: number,
): Promise<RollupSqlRow[]> {
  // Checked before the spec is built: an empty scope would ask `bucketJoin`
  // for a `VALUES` list with no rows.
  if (scopeIsEmpty(dimension, scope)) return Promise.resolve([]);
  const spec = dimensionSpec(dimension, scope);

  const agg = Prisma.sql`
    SELECT ${spec.key} AS key,
           count(*) FILTER (WHERE ar."finalResult" = 'PRESENT')::int AS present,
           count(*) FILTER (WHERE ar."finalResult" = 'ABSENT')::int  AS absent,
           count(*) FILTER (WHERE ar."finalResult" IN ('NEEDS_REVIEW','NOT_EVALUATED'))::int
             AS unresolved
    FROM "AttendanceRecord" ar
    JOIN "AttendanceSession" s ON s.id = ar."sessionId"
    ${spec.keyJoins}
    WHERE ${baseConditions(institutionId, filters, scope)}
    GROUP BY 1`;

  // Over plain integer columns now, rather than a repeat of the FILTER
  // aggregates. Nothing decided means there is no rate — not a rate of zero.
  const rateExpr = Prisma.sql`
    CASE WHEN agg.present + agg.absent = 0 THEN NULL
         ELSE agg.present::numeric / (agg.present + agg.absent)
    END`;
  const orderBy =
    order === "rate"
      ? Prisma.sql`${rateExpr} ASC NULLS LAST, 2 ASC`
      : spec.chronological
        ? Prisma.sql`1 DESC`
        : Prisma.sql`2 ASC, 1 ASC`;

  return reportQuery<RollupSqlRow[]>(Prisma.sql`
    ${withAgg(agg)}
    SELECT agg.key AS key,
           ${spec.label} AS label,
           ${spec.sublabel} AS sublabel,
           agg.present AS present,
           agg.absent AS absent,
           agg.unresolved AS unresolved,
           count(*) OVER ()::int AS "totalRows"
    FROM agg
    ${spec.decorate}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`);
}

/**
 * How many registers each group covers.
 *
 * Deliberately a second query. Folding it into the rollup above as
 * `count(DISTINCT s.id)` was measured at 291 ms against 44 ms + 1 ms for the
 * pair, because the distinct count forces the whole joined set through a
 * disk sort. This one touches `AttendanceSession` only, which is three orders
 * of magnitude smaller than `AttendanceRecord`.
 */
export function countSessionsByDimension(
  institutionId: string,
  dimension: ReportDimension,
  filters: ReportFilters,
  scope: CohortScope,
): Promise<Array<{ key: string | null; sessions: number }>> {
  if (scopeIsEmpty(dimension, scope)) return Promise.resolve([]);
  const spec = dimensionSpec(dimension, scope);
  if (!spec.sessionKey) return Promise.resolve([]);

  return reportQuery<Array<{ key: string | null; sessions: number }>>(Prisma.sql`
    SELECT ${spec.sessionKey} AS key, count(*)::int AS sessions
    FROM "AttendanceSession" s
    ${spec.keyJoins}
    WHERE ${and(sessionConditions(institutionId, filters, scope))}
    GROUP BY 1`);
}

// ---------------------------------------------------------------------------
// Low attendance
// ---------------------------------------------------------------------------

export interface LowAttendanceSqlRow {
  studentId: string;
  studentCode: string;
  studentName: string;
  cohortName: string | null;
  present: number;
  absent: number;
  totalRows: number;
}

/**
 * Students under a threshold, decided in SQL.
 *
 * The threshold is a bound parameter, not a literal — this query is the only
 * place the comparison happens, and the number reaching it came from
 * `resolveLowAttendanceThreshold`.
 *
 * Students with no decided rows in the window are excluded by `decided > 0`.
 * "No attendance recorded" is not "0% attendance", and listing a student who
 * has not had a class yet as at-risk would be a false accusation with
 * consequences.
 */
export function listLowAttendanceStudents(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
  threshold: number,
  limit: number,
  offset: number,
): Promise<LowAttendanceSqlRow[]> {
  if (scope.cohortIds?.length === 0) return Promise.resolve([]);

  // Grouped by student id alone; the name, code and class are joined on
  // afterwards, against however few students are actually under the
  // threshold. `min(s."cohortId")` is an aggregate, not a grouping column, so
  // it does not split a student into one row per class.
  const agg = Prisma.sql`
    SELECT ar."studentId" AS key,
           min(s."cohortId") AS "cohortId",
           count(*) FILTER (WHERE ar."finalResult" = 'PRESENT')::int AS present,
           count(*) FILTER (WHERE ar."finalResult" = 'ABSENT')::int  AS absent
    FROM "AttendanceRecord" ar
    JOIN "AttendanceSession" s ON s.id = ar."sessionId"
    WHERE ${baseConditions(institutionId, filters, scope)}
    GROUP BY 1
    HAVING count(*) FILTER (WHERE ar."finalResult" IN ('PRESENT','ABSENT')) > 0
       AND 100.0 * count(*) FILTER (WHERE ar."finalResult" = 'PRESENT')
           / count(*) FILTER (WHERE ar."finalResult" IN ('PRESENT','ABSENT')) < ${threshold}`;

  // The HAVING clause guarantees present + absent > 0, so this division is
  // safe without a guard.
  return reportQuery<LowAttendanceSqlRow[]>(Prisma.sql`
    ${withAgg(agg)}
    SELECT agg.key AS "studentId",
           st."studentCode" AS "studentCode",
           st."firstName" || ' ' || st."lastName" AS "studentName",
           co.name AS "cohortName",
           agg.present AS present,
           agg.absent AS absent,
           count(*) OVER ()::int AS "totalRows"
    FROM agg
    JOIN "Student" st ON st.id = agg.key
    LEFT JOIN "Cohort" co ON co.id = agg."cohortId"
    ORDER BY agg.present::numeric / (agg.present + agg.absent) ASC, st."studentCode" ASC
    LIMIT ${limit} OFFSET ${offset}`);
}

// ---------------------------------------------------------------------------
// Record listing
// ---------------------------------------------------------------------------

export interface RecordSqlRow {
  attendanceRecordId: string;
  sessionId: string;
  sessionDate: Date;
  studentId: string;
  studentCode: string;
  studentName: string;
  cohortName: string;
  subjectName: string | null;
  subjectCode: string | null;
  facultyName: string | null;
  result: string;
  isManuallyCorrected: boolean;
}

/**
 * The record listing's filter, shared by the page query and its count so the
 * two can never disagree about what they are describing.
 */
function recordListConditions(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
): Prisma.Sql[] {
  const conditions = [
    ...recordConditions(institutionId, filters),
    ...sessionConditions(institutionId, filters, scope),
  ];
  if (filters.results?.length) {
    // Compared as text so the bound parameters stay plain strings rather than
    // needing an enum cast per element.
    conditions.push(Prisma.sql`ar."finalResult"::text IN (${Prisma.join(filters.results)})`);
  }
  return conditions;
}

/**
 * Individual records, paginated. Backs student attendance history and the
 * raw-rows export.
 *
 * This is the one query the `results` status filter applies to, and the only
 * one that returns per-record data at all. It is always paginated — a caller
 * asking for "every record" gets a page and a total, and the exporter walks
 * pages rather than asking the database for an unbounded set.
 *
 * No `count(*) OVER ()` here, deliberately: see rule 2 in the file header.
 * `countRecords` is the companion, and costs 13 ms.
 */
export function listRecords(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
  limit: number,
  offset: number,
): Promise<RecordSqlRow[]> {
  if (scope.cohortIds?.length === 0) return Promise.resolve([]);

  return reportQuery<RecordSqlRow[]>(Prisma.sql`
    SELECT ar.id AS "attendanceRecordId",
           s.id AS "sessionId",
           s."sessionDate" AS "sessionDate",
           ar."studentId" AS "studentId",
           st."studentCode" AS "studentCode",
           st."firstName" || ' ' || st."lastName" AS "studentName",
           co.name AS "cohortName",
           sub.name AS "subjectName",
           sub.code AS "subjectCode",
           fu.name AS "facultyName",
           ar."finalResult"::text AS result,
           ar."isManuallyCorrected" AS "isManuallyCorrected"
    FROM "AttendanceRecord" ar
    JOIN "AttendanceSession" s ON s.id = ar."sessionId"
    JOIN "Cohort" co ON co.id = s."cohortId"
    JOIN "Student" st ON st.id = ar."studentId"
    LEFT JOIN "CohortSubject" cs ON cs.id = s."cohortSubjectId"
    LEFT JOIN "Subject" sub ON sub.id = cs."subjectId"
    LEFT JOIN "User" fu ON fu.id = s."facultyId"
    WHERE ${and(recordListConditions(institutionId, filters, scope))}
    ORDER BY s."sessionDate" DESC, st."studentCode" ASC
    LIMIT ${limit} OFFSET ${offset}`);
}

/**
 * How many records the listing's filter matches.
 *
 * Joins only what the filter reads — no `Student`, no `Subject`, no `User` —
 * because none of them can change the count.
 */
export function countRecords(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
): Promise<Array<{ count: number }>> {
  if (scope.cohortIds?.length === 0) return Promise.resolve([{ count: 0 }]);

  return reportQuery<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count
    FROM "AttendanceRecord" ar
    JOIN "AttendanceSession" s ON s.id = ar."sessionId"
    WHERE ${and(recordListConditions(institutionId, filters, scope))}`);
}

// ---------------------------------------------------------------------------
// Headline figures
// ---------------------------------------------------------------------------

export interface OverviewSqlRow {
  present: number;
  absent: number;
}

export function aggregateOverall(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
): Promise<OverviewSqlRow[]> {
  if (scope.cohortIds?.length === 0) return Promise.resolve([{ present: 0, absent: 0 }]);

  return reportQuery<OverviewSqlRow[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE ar."finalResult" = 'PRESENT')::int AS present,
           count(*) FILTER (WHERE ar."finalResult" = 'ABSENT')::int  AS absent
    FROM "AttendanceRecord" ar
    JOIN "AttendanceSession" s ON s.id = ar."sessionId"
    WHERE ${baseConditions(institutionId, filters, scope)}`);
}

/**
 * How many students are under the threshold, without paging through them.
 * Kept separate from `listLowAttendanceStudents` so the headline number on
 * the overview does not depend on a page size.
 */
export function countLowAttendanceStudents(
  institutionId: string,
  filters: ReportFilters,
  scope: CohortScope,
  threshold: number,
): Promise<Array<{ count: number }>> {
  if (scope.cohortIds?.length === 0) return Promise.resolve([{ count: 0 }]);

  return reportQuery<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count FROM (
      SELECT ar."studentId"
      FROM "AttendanceRecord" ar
      JOIN "AttendanceSession" s ON s.id = ar."sessionId"
      WHERE ${baseConditions(institutionId, filters, scope)}
      GROUP BY 1
      HAVING count(*) FILTER (WHERE ar."finalResult" IN ('PRESENT','ABSENT')) > 0
         AND 100.0 * count(*) FILTER (WHERE ar."finalResult" = 'PRESENT')
             / count(*) FILTER (WHERE ar."finalResult" IN ('PRESENT','ABSENT')) < ${threshold}
    ) low`);
}

/** Institution-wide counts that do not depend on the report window. */
export function countInstitutionEntities(institutionId: string) {
  return Promise.all([
    prisma.student.count({ where: { institutionId, status: "ACTIVE" } }),
    prisma.cohort.count({ where: { institutionId } }),
    prisma.attendanceSession.count({
      where: { institutionId, status: { in: ["REVIEW", "PROCESSING"] } },
    }),
  ]).then(([students, cohorts, sessionsAwaitingReview]) => ({
    students,
    cohorts,
    sessionsAwaitingReview,
  }));
}

export function countFinalizedSessions(
  institutionId: string,
  from: Date,
  to: Date,
): Promise<number> {
  return prisma.attendanceSession.count({
    where: { institutionId, status: "FINALIZED", sessionDate: { gte: from, lt: to } },
  });
}

export function countSessionsAwaitingConfirmation(
  institutionId: string,
  from: Date,
  to: Date,
): Promise<number> {
  return prisma.attendanceSession.count({
    where: {
      institutionId,
      sessionDate: { gte: from, lt: to },
      status: { notIn: ["FINALIZED", "CANCELLED"] },
    },
  });
}

// ---------------------------------------------------------------------------
// Filter option lists
// ---------------------------------------------------------------------------

export function listFilterOptions(institutionId: string) {
  return Promise.all([
    prisma.cohort.findMany({
      where: { institutionId },
      select: { id: true, name: true, termLabel: true },
      orderBy: { name: "asc" },
    }),
    prisma.academicUnit.findMany({
      where: { institutionId },
      select: { id: true, name: true, code: true, kind: true, parentId: true },
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.subject.findMany({
      where: { institutionId },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      // Only staff who have actually held a register: a faculty filter listing
      // every account in the institution is a list nobody can use.
      where: { institutionId, status: "ACTIVE", openedSessions: { some: {} } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]).then(([cohorts, academicUnits, subjects, faculty]) => ({
    cohorts,
    academicUnits,
    subjects,
    faculty,
  }));
}
