import Link from "next/link";
import { RateBar, RatePercent, StatCard, StatGrid, rateTone } from "@/components/ui/attendance-stat";
import { EmptyState } from "@/components/ui/panel";
import type {
  InstitutionOverview,
  LowAttendanceRow,
  ReportPage,
  ReportRollupRow,
} from "@/modules/attendance-reporting/types";
import { reportHref, type ReportRequest } from "./report-query";

/**
 * The pieces every report surface is built from.
 *
 * Shared by the interactive workbench and the print view so the two cannot
 * drift: a printed report that disagrees with the screen it was printed from
 * is worse than no printed report. What differs between them is the chrome —
 * tabs, filter form, pagination — not the numbers or the columns.
 */

export function windowLabel(overview: { windowStart: string; windowEnd: string }): string {
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  // `windowEnd` is exclusive; a report labelled "to 17 Sep" that stops at the
  // 16th is a report nobody can reconcile against a register.
  const lastDay = new Date(new Date(overview.windowEnd).getTime() - 1).toISOString();
  return `${format(overview.windowStart)} – ${format(lastDay)}`;
}

export function OverviewStats({ overview }: { overview: InstitutionOverview }) {
  return (
    <StatGrid>
      <StatCard
        label="Attendance"
        value={
          overview.overall.percentage === null ? "—" : `${overview.overall.percentage.toFixed(1)}%`
        }
        hint={
          overview.overall.total === 0
            ? "No confirmed attendance in this period"
            : `${overview.overall.present} of ${overview.overall.total} marks`
        }
        tone={rateTone(overview.overall.percentage, overview.lowAttendanceThreshold)}
      />
      <StatCard
        label="Students"
        value={String(overview.totalStudents)}
        hint={`${overview.totalCohorts} class${overview.totalCohorts === 1 ? "" : "es"}`}
      />
      <StatCard
        label="Today"
        value={overview.today.percentage === null ? "—" : `${overview.today.percentage.toFixed(1)}%`}
        // Present and absent today, from confirmed registers only. The pending
        // count is stated beside them rather than folded in: an unconfirmed
        // register has no result the faculty member has stood behind yet.
        hint={
          overview.today.total === 0
            ? overview.todayAwaitingConfirmation > 0
              ? `${overview.todayAwaitingConfirmation} awaiting confirmation`
              : "Nothing confirmed today"
            : `${overview.today.present} present, ${overview.today.absent} absent` +
              (overview.todayAwaitingConfirmation > 0
                ? ` · ${overview.todayAwaitingConfirmation} pending`
                : "")
        }
      />
      <StatCard
        label={`Below ${overview.lowAttendanceThreshold}%`}
        value={String(overview.lowAttendanceCount)}
        hint={
          overview.sessionsAwaitingReview > 0
            ? `${overview.sessionsAwaitingReview} register${
                overview.sessionsAwaitingReview === 1 ? "" : "s"
              } still in review`
            : `${overview.finalizedSessions} confirmed session${
                overview.finalizedSessions === 1 ? "" : "s"
              }`
        }
        tone={overview.lowAttendanceCount > 0 ? "warning" : "neutral"}
      />
    </StatGrid>
  );
}

/**
 * A rollup, whatever it was grouped by.
 *
 * A table from `sm` up and stacked rows on phones: a six-column table on a
 * 390px screen is unreadable however it is styled.
 */
export function RollupTable({
  page,
  threshold,
  unitLabel,
  hrefFor,
}: {
  page: ReportPage<ReportRollupRow>;
  threshold: number;
  unitLabel: string;
  /**
   * Where clicking a row goes, when it goes anywhere.
   *
   * Used for drill-down: clicking a student narrows the whole report to that
   * student, which is how the student filter is reached without a `<select>`
   * of every student in the institution. Returns null for rows that are not
   * an entity — a day or a month has no id to filter by. The print view
   * passes nothing, because a link on paper is a dead end.
   */
  hrefFor?: (row: ReportRollupRow) => string | null;
}) {
  if (page.rows.length === 0) {
    return <EmptyState>No confirmed attendance matches these filters.</EmptyState>;
  }

  return (
    <ul className="flex flex-col divide-y divide-neutral-100">
      <li className="hidden py-2 text-xs font-medium text-neutral-500 sm:flex sm:items-center sm:gap-3">
        <span className="min-w-0 flex-1">{unitLabel}</span>
        <span className="w-20 text-right">Sessions</span>
        <span className="w-20 text-right">Marks</span>
        <span className="w-32 text-right">Attendance</span>
      </li>
      {page.rows.map((row) => (
        <li key={row.key} className="py-3">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
              {(() => {
                const href = hrefFor?.(row) ?? null;
                return href ? (
                  <Link href={href} className="hover:underline">
                    {row.label}
                  </Link>
                ) : (
                  row.label
                );
              })()}
              {row.sublabel ? (
                <span className="ml-2 text-xs font-normal text-neutral-500">{row.sublabel}</span>
              ) : null}
            </span>
            <span className="text-xs tabular-nums text-neutral-600 sm:w-20 sm:text-right">
              {/* Null means this dimension has no session count to give — see
                  ReportRollupRow.sessionCount — not that it held zero. */}
              {row.sessionCount === null ? "—" : row.sessionCount}
              <span className="sm:hidden"> sessions</span>
            </span>
            <span className="text-xs tabular-nums text-neutral-600 sm:w-20 sm:text-right">
              {row.rate.total}
              <span className="sm:hidden"> marks</span>
            </span>
            <span className="text-sm font-semibold tabular-nums text-neutral-900 sm:w-32 sm:text-right">
              <RatePercent rate={row.rate} />
              <span className="ml-2 text-xs font-normal text-neutral-500">
                {row.rate.present}/{row.rate.total}
              </span>
            </span>
          </div>
          <div className="mt-2">
            <RateBar rate={row.rate} threshold={threshold} />
          </div>
          {row.unresolved > 0 ? (
            // Stated rather than hidden. These rows still owe a human a
            // decision and are in neither the numerator nor the denominator.
            <p className="mt-1 text-xs text-amber-700">
              {row.unresolved} mark{row.unresolved === 1 ? "" : "s"} awaiting review, not counted
              above
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function LowAttendanceTable({
  rows,
  threshold,
}: {
  rows: LowAttendanceRow[];
  threshold: number;
}) {
  if (rows.length === 0) {
    return <EmptyState>No student is below {threshold}% for this period.</EmptyState>;
  }
  return (
    <ul className="flex flex-col divide-y divide-neutral-100">
      {rows.map((student) => (
        <li
          key={student.studentId}
          className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-neutral-900">{student.studentName}</span>
            <span className="text-xs tabular-nums text-neutral-500">
              {student.studentCode}
              {student.cohortName ? ` · ${student.cohortName}` : ""}
            </span>
          </span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-amber-700">
            <RatePercent rate={student.rate} />
            <span className="ml-2 text-xs font-normal text-neutral-500">
              {student.rate.present}/{student.rate.total} attended
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Page links, and a statement of how many rows there are.
 *
 * The count is from a separate `count(*)`, not from the page — so "showing
 * 1–25 of 2,160" is a fact rather than an inference. Rendered as links rather
 * than buttons so paging works without JavaScript and each page is its own
 * bookmarkable URL.
 */
export function Pagination({
  base,
  request,
  page,
}: {
  base: string;
  request: ReportRequest;
  page: { page: number; pageSize: number; totalRows: number; hasMore: boolean };
}) {
  if (page.totalRows === 0) return null;
  const first = (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.page * page.pageSize, page.totalRows);

  const linkClass =
    "rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50";
  const disabledClass =
    "rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-300";

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <p className="text-xs tabular-nums text-neutral-500">
        Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
        {page.totalRows.toLocaleString()}
      </p>
      <div className="flex gap-1 print:hidden">
        {page.page > 1 ? (
          <Link className={linkClass} href={reportHref(base, request, { page: page.page - 1 })}>
            Previous
          </Link>
        ) : (
          <span className={disabledClass}>Previous</span>
        )}
        {page.hasMore ? (
          <Link className={linkClass} href={reportHref(base, request, { page: page.page + 1 })}>
            Next
          </Link>
        ) : (
          <span className={disabledClass}>Next</span>
        )}
      </div>
    </div>
  );
}
