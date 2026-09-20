import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  getFilterOptions,
  getLowAttendance,
  getOverview,
  getRollup,
} from "@/modules/attendance-reporting/service";
import { VALID_RESULTS } from "@/modules/attendance-reporting/service";
import {
  DIMENSION_LABELS,
  RESULT_LABELS,
  dimensionsFor,
  parseReportQuery,
  reportHref,
  type SearchParams,
} from "@/components/reports/report-query";
import {
  LowAttendanceTable,
  OverviewStats,
  Pagination,
  RollupTable,
  windowLabel,
} from "@/components/reports/report-views";
import { Panel } from "@/components/ui/panel";

interface PageProps {
  searchParams: Promise<SearchParams>;
}

/**
 * The institution reporting workbench.
 *
 * One screen, one URL, eleven reports. The dimension is a query parameter
 * rather than a route segment because everything else on the page — the
 * window, the filters, the sort — survives switching between them, and a
 * report is much more often "the same filters, grouped differently" than it is
 * a fresh start.
 *
 * ## No client JavaScript
 *
 * The filters are a GET form, the tabs and the pager are links, and the export
 * buttons are links to a route handler. Nothing here is a client component.
 * That is not austerity for its own sake: it makes every view of this report a
 * real URL that can be bookmarked, mailed, or opened by the print route, and
 * it means the export cannot show something the screen did not, because both
 * read the same query string through `parseReportQuery`.
 *
 * ## What is counted
 *
 * Confirmed registers only, everywhere on this page. Sessions still in review
 * are reported as a count of outstanding work, never as provisional results —
 * publishing a number the faculty member has not stood behind would make this
 * screen the place where an unreviewed AI guess becomes an official figure.
 *
 * ## Performance
 *
 * Every panel is a `GROUP BY` and a `LIMIT` in PostgreSQL. Nothing on this
 * page loads a result set to count it in JavaScript, which is what the Phase 7
 * version did — measured at 5.5 s and 238 MB on a 482,760-record institution
 * against 25 ms for the same figures aggregated in SQL. See
 * `modules/attendance-reporting/repository.ts` and `scripts/report-bench/`.
 */
export default async function InstitutionReportsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("attendanceRecord.read");
  const params = await searchParams;
  const request = parseReportQuery(params, new Date());

  let overview;
  let rollup;
  let lowAttendance;
  let options;
  try {
    // One round of queries, in parallel. They are independent, and running
    // them in sequence would make the page as slow as their sum.
    [overview, rollup, lowAttendance, options] = await Promise.all([
      getOverview(user, request.filters, request.thresholdOverride),
      getRollup(user, request.dimension, request.filters, request.page, request.order),
      getLowAttendance(
        user,
        request.filters,
        { page: 1, pageSize: 10 },
        request.thresholdOverride,
      ),
      getFilterOptions(user),
    ]);
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/unauthorized");
    throw error;
  }

  const base = "/dashboard/reports";
  const dimensions = dimensionsFor(overview.attendanceMode);
  const fromValue = request.filters.from.toISOString().slice(0, 10);
  const toValue = new Date(request.filters.to.getTime() - 1).toISOString().slice(0, 10);

  const exportHref = (format: "csv" | "xlsx", kind: "rollup" | "low-attendance" | "records") =>
    reportHref("/api/reports/export", request, { format, kind, page: undefined });

  /**
   * Drill-down: clicking a row narrows the whole report to that entity.
   *
   * This is how the brief's per-student filter is reached. An institution can
   * have tens of thousands of students, so there is no student `<select>` —
   * "group by student, then click one" gets there in two clicks and scales.
   * The other three map to their own filters for the same reason.
   *
   * Only these four dimensions: a day or a month is not an entity and has no
   * id to filter by, and the academic-unit dimensions all key on a unit the
   * `academicUnitIds` filter already covers.
   */
  const DRILL_PARAM: Partial<Record<typeof request.dimension, string>> = {
    student: "studentIds",
    cohort: "cohortIds",
    subject: "subjectIds",
    faculty: "facultyIds",
  };
  const drillHref = (row: { key: string }) => {
    const param = DRILL_PARAM[request.dimension];
    if (!param) return null;
    return reportHref(base, request, { [param]: row.key, page: undefined });
  };

  const tabClass = (active: boolean) =>
    `rounded-md border px-2.5 py-1.5 text-xs font-medium ${
      active
        ? "border-neutral-900 bg-neutral-900 text-white"
        : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
    }`;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard" className="text-xs text-neutral-500 hover:underline">
            ← Overview
          </Link>
          <h1 className="text-xl font-semibold text-neutral-900">Attendance reports</h1>
          <p className="text-xs text-neutral-500">
            {overview.institutionName} · {windowLabel(overview)}
          </p>
          {overview.scope === "assigned" ? (
            // Stated once, near the title, rather than repeated on every
            // panel. Without it a lecturer's 78% is indistinguishable from
            // the institution's 78%, and those are very different sentences.
            <p className="text-xs font-medium text-amber-700">
              Your classes and subjects only — not institution-wide figures.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          <Link
            href={reportHref("/dashboard/reports/print", request, {})}
            target="_blank"
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Print
          </Link>
          <Link
            href={exportHref("csv", "rollup")}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            CSV
          </Link>
          <Link
            href={exportHref("xlsx", "rollup")}
            className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Excel
          </Link>
        </div>
      </header>

      <OverviewStats overview={overview} />

      {/*
        A GET form, so submitting it produces a URL. Every control is named
        after the query parameter it sets, which is why no JavaScript is
        needed to keep the two in step.
      */}
      <Panel
        title="Filters"
        description="Applied to every figure on this page and to every export taken from it."
      >
        <form method="get" action={base} className="flex flex-col gap-3">
          <input type="hidden" name="dimension" value={request.dimension} />
          {/*
            The student filter has no control of its own — it is set by
            clicking a row in the student rollup. Carried as a hidden field so
            pressing Apply does not silently drop it; the chip below is how it
            is cleared.
          */}
          {(request.raw.studentIds ?? []).map((id) => (
            <input key={id} type="hidden" name="studentIds" value={id} />
          ))}
          {request.raw.studentIds?.length ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
              <span className="rounded-md bg-neutral-100 px-2 py-1">
                Narrowed to {request.raw.studentIds.length} student
                {request.raw.studentIds.length === 1 ? "" : "s"}
              </span>
              <Link
                href={reportHref(base, request, { studentIds: undefined, page: undefined })}
                className="text-neutral-500 hover:underline"
              >
                Clear
              </Link>
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              From
              <input
                type="date"
                name="from"
                defaultValue={fromValue}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              To
              <input
                type="date"
                name="to"
                defaultValue={toValue}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              Class
              <select
                name="cohortIds"
                defaultValue={request.raw.cohortIds?.[0] ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              >
                <option value="">All classes</option>
                {options.cohorts.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.name}
                    {cohort.termLabel ? ` · ${cohort.termLabel}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              {/* Any level of the tree: picking a department selects
                  everything under it, without the reader enumerating it. */}
              Academic unit
              <select
                name="academicUnitIds"
                defaultValue={request.raw.academicUnitIds?.[0] ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              >
                <option value="">All units</option>
                {options.academicUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                    {unit.code ? ` (${unit.code})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {overview.attendanceMode === "SUBJECT_WISE" ? (
              <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
                Subject
                <select
                  name="subjectIds"
                  defaultValue={request.raw.subjectIds?.[0] ?? ""}
                  className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
                >
                  <option value="">All subjects</option>
                  {options.subjects.map((subject) => (
                    <option key={subject.id} value={subject.id}>
                      {subject.name}
                      {subject.code ? ` (${subject.code})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              Faculty
              <select
                name="facultyIds"
                defaultValue={request.raw.facultyIds?.[0] ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              >
                <option value="">All faculty</option>
                {options.faculty.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              {/* An override, not a setting: it changes this view only. The
                  institution's own rule is in settings, and this box is for
                  "what would 80% look like". */}
              Low attendance below
              <input
                type="number"
                name="threshold"
                min={0}
                max={100}
                placeholder={String(overview.lowAttendanceThreshold)}
                defaultValue={request.thresholdOverride ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              {/* Applies to the record listing only — the service ignores it
                  for rollups on purpose. Filtering a percentage by "Absent"
                  would give every group 0%: arithmetic working correctly, and
                  a report meaning nothing. Said on the control rather than
                  discovered by an administrator who trusts the output. */}
              Status <span className="font-normal text-neutral-400">(record listing only)</span>
              <select
                name="results"
                defaultValue={request.raw.results?.[0] ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              >
                <option value="">All results</option>
                {VALID_RESULTS.map((result) => (
                  <option key={result} value={result}>
                    {RESULT_LABELS[result]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
              Order
              <select
                name="order"
                defaultValue={request.order}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900"
              >
                <option value="label">By name</option>
                <option value="rate">Lowest attendance first</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
            >
              Apply
            </button>
            <Link
              href={base}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Reset
            </Link>
          </div>
        </form>
      </Panel>

      <nav aria-label="Group attendance by" className="flex flex-wrap gap-1">
        {dimensions.map((dimension) => (
          <Link
            key={dimension}
            // Paging resets on a dimension change: page 7 of "by course" is
            // not page 7 of "by faculty", and keeping it would land the reader
            // on an empty page for no stated reason.
            href={reportHref(base, request, { dimension, page: undefined })}
            aria-current={dimension === request.dimension ? "page" : undefined}
            className={tabClass(dimension === request.dimension)}
          >
            {DIMENSION_LABELS[dimension]}
          </Link>
        ))}
      </nav>

      <Panel
        title={`By ${DIMENSION_LABELS[request.dimension].toLowerCase()}`}
        description="Confirmed registers only. Registers still in review are excluded from every percentage."
        action={
          <span className="flex gap-1 text-xs">
            <Link href={exportHref("csv", "rollup")} className="text-neutral-500 hover:underline">
              CSV
            </Link>
            <span className="text-neutral-300">·</span>
            <Link href={exportHref("xlsx", "rollup")} className="text-neutral-500 hover:underline">
              Excel
            </Link>
          </span>
        }
      >
        <RollupTable
          page={rollup}
          threshold={overview.lowAttendanceThreshold}
          unitLabel={DIMENSION_LABELS[request.dimension]}
          hrefFor={drillHref}
        />
        <Pagination base={base} request={request} page={rollup} />
      </Panel>

      <Panel
        title={`Below ${lowAttendance.threshold}%`}
        description="A filter over this period's confirmed attendance — not a shortage determination. Verify against your institution's own rule before acting."
        action={
          <span className="flex gap-1 text-xs">
            <Link
              href={exportHref("csv", "low-attendance")}
              className="text-neutral-500 hover:underline"
            >
              CSV
            </Link>
            <span className="text-neutral-300">·</span>
            <Link
              href={exportHref("xlsx", "low-attendance")}
              className="text-neutral-500 hover:underline"
            >
              Excel
            </Link>
          </span>
        }
      >
        <LowAttendanceTable rows={lowAttendance.rows} threshold={lowAttendance.threshold} />
        {lowAttendance.totalRows > lowAttendance.rows.length ? (
          <p className="text-xs text-neutral-500">
            Showing the {lowAttendance.rows.length} lowest of{" "}
            {lowAttendance.totalRows.toLocaleString()}. Export for the full list.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Individual records"
        description="Every mark behind the figures above, one row per student per session — for an audit or a student attendance history."
      >
        <p className="text-xs text-neutral-500">
          The record listing is large by nature and is offered as a download rather than a page.
          These filters apply to it unchanged.
        </p>
        <div className="flex gap-2">
          <Link
            href={exportHref("csv", "records")}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Download CSV
          </Link>
          <Link
            href={exportHref("xlsx", "records")}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Download Excel
          </Link>
        </div>
      </Panel>
    </div>
  );
}
