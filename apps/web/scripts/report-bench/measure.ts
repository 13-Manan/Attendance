/**
 * Times every reporting query against the seeded bench database.
 *
 * Two jobs. The obvious one is the brief's "measure query performance first" —
 * an index is worth adding when a plan says so, not when it sounds prudent.
 * The less obvious one is that this is the only thing that *executes* the raw
 * SQL in `attendance-reporting/repository.ts`: a typo in a column name is a
 * runtime error there, not a compile error, so every query gets run once here
 * before anyone believes the module works.
 */
import { prisma } from "@/lib/prisma";
import * as repo from "@/modules/attendance-reporting/repository";
import { resolveScope } from "@/modules/attendance-reporting/service";
import { REPORT_DIMENSIONS } from "@/modules/attendance-reporting/types";
import type { ReportDimension, ReportFilters } from "@/modules/attendance-reporting/types";
import type { CohortScope } from "@/modules/attendance-reporting/unit-tree";

const INSTITUTION = process.env.BENCH_INSTITUTION ?? "inst_c";
const filters: ReportFilters = {
  from: new Date("2026-06-18T00:00:00Z"),
  to: new Date("2026-09-17T00:00:00Z"),
};

let failures = 0;

/**
 * Runs a query enough times to reach its steady-state plan, and reports both.
 *
 * PostgreSQL plans a prepared statement with the actual parameter values for
 * its first five executions, then compares that cost against a
 * parameter-blind *generic* plan and usually switches to it. Prisma prepares
 * every `$queryRaw`, so the generic plan is what a running server spends
 * almost all of its time on — and it can be an order of magnitude worse. An
 * early version of this harness ran each query twice and reported 22 ms for a
 * rollup that costs 214 ms in production.
 *
 * Hence `first` (custom plan, what a cold or rarely-used query gets) and
 * `steady` (generic plan, what everything else gets). A large gap between
 * them is the finding, not noise.
 */
const PLAN_CACHE_THRESHOLD = 5;

async function measure(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const firstStart = process.hrtime.bigint();
    await run();
    const first = Number(process.hrtime.bigint() - firstStart) / 1e6;

    for (let i = 1; i < PLAN_CACHE_THRESHOLD; i += 1) await run();

    const steadyStart = process.hrtime.bigint();
    const result = await run();
    const steady = Number(process.hrtime.bigint() - steadyStart) / 1e6;

    const rows = Array.isArray(result) ? result.length : 1;
    const flag = steady > 250 ? "  <-- SLOW" : steady > first * 3 ? "  <-- PLAN FLIP" : "";
    console.log(
      `${label.padEnd(40)} ${steady.toFixed(1).padStart(8)} ms steady` +
        ` (${first.toFixed(1).padStart(7)} ms first)  rows=${rows}${flag}`,
    );
  } catch (error) {
    failures += 1;
    console.log(`${label.padEnd(40)} ${"FAILED".padStart(8)}  ${(error as Error).message}`);
  }
}

console.log(`\nreport-bench: institution=${INSTITUTION}\n`);

/** The scope every query now takes, resolved the way the service resolves it. */
const scopeFor = (dimension: ReportDimension | null, f: ReportFilters = filters) =>
  resolveScope(INSTITUTION, dimension, f);
const NO_SCOPE: CohortScope = { cohortIds: null, buckets: null };

const counts = await prisma.$queryRaw<Array<{ records: bigint; sessions: bigint }>>`
  SELECT (SELECT count(*) FROM "AttendanceRecord") AS records,
         (SELECT count(*) FROM "AttendanceSession") AS sessions`;
console.log(
  `dataset: ${counts[0].records} attendance records, ${counts[0].sessions} sessions\n`,
);

for (const dimension of REPORT_DIMENSIONS) {
  const scope = await scopeFor(dimension);
  await measure(`rollup: ${dimension}`, () =>
    repo.aggregateByDimension(INSTITUTION, dimension, filters, scope, "label", 25, 0),
  );
  await measure(`  session counts: ${dimension}`, () =>
    repo.countSessionsByDimension(INSTITUTION, dimension, filters, scope),
  );
}

console.log("");
await measure("rollup: cohort ordered by rate", () =>
  repo.aggregateByDimension(INSTITUTION, "cohort", filters, NO_SCOPE, "rate", 25, 0),
);
await measure("low attendance (threshold 75)", () =>
  repo.listLowAttendanceStudents(INSTITUTION, filters, NO_SCOPE, 75, 25, 0),
);
await measure("low attendance count", () =>
  repo.countLowAttendanceStudents(INSTITUTION, filters, NO_SCOPE, 75),
);
await measure("overall rate", () => repo.aggregateOverall(INSTITUTION, filters, NO_SCOPE));
await measure("records page 1", () => repo.listRecords(INSTITUTION, filters, NO_SCOPE, 25, 0));
await measure("records count", () => repo.countRecords(INSTITUTION, filters, NO_SCOPE));
await measure("records deep page (offset 100k)", () =>
  repo.listRecords(INSTITUTION, filters, NO_SCOPE, 25, 100_000),
);
await measure("export page (5000 rows)", () =>
  repo.listRecords(INSTITUTION, filters, NO_SCOPE, 5000, 0),
);
await measure("institution entity counts", () => repo.countInstitutionEntities(INSTITUTION));
await measure("filter options", () => repo.listFilterOptions(INSTITUTION));

console.log("\n--- filtered variants (server-side filtering must narrow, not post-filter) ---");
const cohorts = await prisma.cohort.findMany({
  where: { institutionId: INSTITUTION },
  select: { id: true, academicUnitId: true },
  take: 3,
});
const units = await prisma.academicUnit.findMany({
  where: { institutionId: INSTITUTION, kind: "SEMESTER" },
  select: { id: true },
  take: 2,
});

const cohortFilters = { ...filters, cohortIds: cohorts.map((c) => c.id) };
const cohortScope = await scopeFor("student", cohortFilters);
await measure("rollup: student, one cohort", () =>
  repo.aggregateByDimension(INSTITUTION, "student", cohortFilters, cohortScope, "rate", 25, 0),
);

const unitFilters = { ...filters, academicUnitIds: units.map((u) => u.id) };
const unitScope = await scopeFor("cohort", unitFilters);
await measure("rollup: cohort, ancestor unit filter", () =>
  repo.aggregateByDimension(INSTITUTION, "cohort", unitFilters, unitScope, "label", 25, 0),
);

await measure("records: status filter", () =>
  repo.listRecords(INSTITUTION, { ...filters, results: ["ABSENT"] }, NO_SCOPE, 25, 0),
);
await measure("unit tree resolution (department)", () => scopeFor("department"));

console.log(failures === 0 ? "\nall queries ran\n" : `\n${failures} QUERY FAILURE(S)\n`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
