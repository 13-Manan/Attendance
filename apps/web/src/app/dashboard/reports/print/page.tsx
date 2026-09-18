import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  MAX_PAGE_SIZE,
  getFilterOptions,
  getLowAttendance,
  getOverview,
  getRollup,
} from "@/modules/attendance-reporting/service";
import {
  DIMENSION_LABELS,
  parseReportQuery,
  reportHref,
  type SearchParams,
} from "@/components/reports/report-query";
import {
  LowAttendanceTable,
  OverviewStats,
  RollupTable,
  windowLabel,
} from "@/components/reports/report-views";

interface PageProps {
  searchParams: Promise<SearchParams>;
}

/**
 * The printable report.
 *
 * This is the "PDF-ready architecture" the brief asks for, and it is
 * deliberately not a PDF. The browser already has a typesetting engine and a
 * PDF writer; a server-side renderer would be a second layout engine to keep
 * in step with this one, and the first time the two disagreed the printed copy
 * would be the one somebody had already signed. So: a real page, print
 * stylesheets, and Ctrl-P. "Save as PDF" is a browser feature.
 *
 * It reads exactly the same query parameters as the workbench through
 * `parseReportQuery`, and renders the same components. The reader cannot print
 * something the screen did not show them.
 *
 * Two differences from the workbench, both about paper:
 *
 * - **No pagination controls.** The page size is raised to `MAX_PAGE_SIZE`,
 *   because a printout that stops at 25 rows with a "Next" button is useless.
 *   `?page=` still works, so a very large report can be printed in parts, and
 *   the header states which part this is.
 * - **The filters are spelled out.** On screen they are in the form; on paper
 *   there is no form, and a sheet of numbers whose scope is not stated is a
 *   sheet of numbers nobody can check. The header names the window, the
 *   threshold, every applied filter, and when it was generated.
 */
export default async function ReportPrintPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("institution.read");
  const params = await searchParams;
  const parsed = parseReportQuery(params, new Date());
  const request = {
    ...parsed,
    page: { page: parsed.page.page, pageSize: MAX_PAGE_SIZE },
  };

  let overview;
  let rollup;
  let lowAttendance;
  let options;
  try {
    [overview, rollup, lowAttendance, options] = await Promise.all([
      getOverview(user, request.filters, request.thresholdOverride),
      getRollup(user, request.dimension, request.filters, request.page, request.order),
      getLowAttendance(
        user,
        request.filters,
        { page: 1, pageSize: 50 },
        request.thresholdOverride,
      ),
      getFilterOptions(user),
    ]);
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/unauthorized");
    throw error;
  }

  // Ids resolved back to names. A printed header reading
  // "Faculty: clx8f2k910003" tells the reader nothing they can verify.
  const nameOf = (list: Array<{ id: string; name: string }>, ids: string[] | undefined) =>
    (ids ?? [])
      .map((id) => list.find((item) => item.id === id)?.name)
      .filter((name): name is string => Boolean(name));

  const applied: Array<[string, string[]]> = [
    ["Class", nameOf(options.cohorts, request.raw.cohortIds)],
    ["Academic unit", nameOf(options.academicUnits, request.raw.academicUnitIds)],
    ["Subject", nameOf(options.subjects, request.raw.subjectIds)],
    ["Faculty", nameOf(options.faculty, request.raw.facultyIds)],
    ["Status", request.raw.results ?? []],
  ];
  const activeFilters = applied.filter(([, values]) => values.length > 0);

  const generatedAt = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 print:max-w-none print:gap-4">
      {/* Screen-only: the way back, and a reminder of what this page is for.
          Gone on paper, where a "Print" button would be a wasted line. */}
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link
          href={reportHref("/dashboard/reports", parsed, {})}
          className="text-xs text-neutral-500 hover:underline"
        >
          ← Back to reports
        </Link>
        <p className="text-xs text-neutral-500">
          Use your browser&rsquo;s print command (⌘P / Ctrl-P) and choose Save as PDF.
        </p>
      </div>

      <header className="flex flex-col gap-1 border-b border-neutral-300 pb-3">
        <h1 className="text-lg font-semibold text-neutral-900">
          {overview.institutionName} — attendance by{" "}
          {DIMENSION_LABELS[request.dimension].toLowerCase()}
        </h1>
        <p className="text-xs text-neutral-600">{windowLabel(overview)}</p>
        <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-0.5 text-xs text-neutral-600">
          {activeFilters.map(([label, values]) => (
            <div key={label} className="flex gap-1">
              <dt className="font-medium text-neutral-500">{label}:</dt>
              <dd>{values.join(", ")}</dd>
            </div>
          ))}
          <div className="flex gap-1">
            <dt className="font-medium text-neutral-500">Low attendance below:</dt>
            <dd>{lowAttendance.threshold}%</dd>
          </div>
          <div className="flex gap-1">
            <dt className="font-medium text-neutral-500">Generated:</dt>
            <dd>{generatedAt}</dd>
          </div>
        </dl>
        {/*
          Stated on the page, not left to the reader to notice: confirmed
          registers only. Someone reading this on paper has no tooltip to
          hover and no way to ask where the number came from.
        */}
        <p className="mt-1 text-xs text-neutral-500">
          Figures cover confirmed registers only. Registers still awaiting faculty review are
          excluded from every percentage and are reported separately below.
        </p>
      </header>

      <OverviewStats overview={overview} />

      <section className="flex flex-col gap-2 break-inside-avoid">
        <h2 className="text-sm font-semibold text-neutral-900">
          By {DIMENSION_LABELS[request.dimension].toLowerCase()}
        </h2>
        <RollupTable
          page={rollup}
          threshold={overview.lowAttendanceThreshold}
          unitLabel={DIMENSION_LABELS[request.dimension]}
        />
        {rollup.totalRows > rollup.rows.length ? (
          // Which part of the report this sheet is. Without it, a stapled
          // printout of page 2 is indistinguishable from a complete report.
          <p className="text-xs text-neutral-500">
            Rows {(request.page.page - 1) * request.page.pageSize + 1}–
            {(request.page.page - 1) * request.page.pageSize + rollup.rows.length} of{" "}
            {rollup.totalRows.toLocaleString()}
            {rollup.hasMore ? " — continued on the next page of this report." : "."}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 break-before-auto">
        <h2 className="text-sm font-semibold text-neutral-900">
          Students below {lowAttendance.threshold}%
        </h2>
        <LowAttendanceTable rows={lowAttendance.rows} threshold={lowAttendance.threshold} />
        {lowAttendance.totalRows > lowAttendance.rows.length ? (
          <p className="text-xs text-neutral-500">
            The {lowAttendance.rows.length} lowest of {lowAttendance.totalRows.toLocaleString()}{" "}
            students below the threshold. Export the full list from the reports screen.
          </p>
        ) : null}
        <p className="text-xs text-neutral-500">
          This list is a filter over the period above, not a shortage determination. Check it
          against your institution&rsquo;s own rule before acting on it.
        </p>
      </section>
    </div>
  );
}
