import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  describeEnrollment,
  getStudentDashboard,
} from "@/modules/attendance-analytics/service";
import type {
  AttendanceTrendPoint,
  StudentAttendanceItem,
} from "@/modules/attendance-analytics/types";
import {
  RateBar,
  RatePercent,
  ResultBadge,
  StatCard,
  StatGrid,
  formatSessionDate,
  rateTone,
} from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";

/**
 * The student portal dashboard.
 *
 * Read-only by construction: the STUDENT role holds no attendance-mutating
 * permission, and this page's data comes from `attendance-analytics`, a module
 * with no write path at all. There is no control here that could alter
 * attendance, and no server action behind one.
 *
 * Only finalized registers are shown. A class whose register the faculty
 * member has not confirmed yet is reported as a pending count, never as a
 * provisional Present or Absent.
 */
export default async function StudentPortalHome() {
  const user = await requirePermissionOrRedirect("attendanceRecord.read.own");
  const dashboard = await getStudentDashboard(user);

  if (!dashboard) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-xl font-semibold text-neutral-900">My attendance</h1>
        <EmptyState>
          Your account is not linked to a student profile yet. Please contact
          your institution&apos;s administrator.
        </EmptyState>
      </div>
    );
  }

  const isCollege = dashboard.attendanceMode === "SUBJECT_WISE";
  const { overall } = dashboard;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          Welcome, {dashboard.fullName.split(" ")[0]}
        </h1>
        <p className="text-xs text-neutral-500">
          {dashboard.studentCode} ·{" "}
          {isCollege ? "Subject-wise attendance" : "Daily attendance"}
        </p>
        {/* A percentage is meaningless without the class and year it is a
            percentage of. Most students have exactly one active enrollment;
            the list handles the student who has moved or takes an elective
            cohort, rather than silently showing the first one. */}
        {dashboard.enrollments.length > 0 ? (
          <ul className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-neutral-600">
            {dashboard.enrollments.map((enrollment) => (
              <li
                key={enrollment.cohortId}
                className="rounded-md border border-neutral-200 px-2 py-0.5"
              >
                {describeEnrollment(enrollment).map((part, index) => (
                  <span key={part} className={index === 0 ? "font-medium text-neutral-900" : ""}>
                    {index === 0 ? "" : " · "}
                    {part}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      <StatGrid>
        <StatCard
          label="Overall attendance"
          value={overall.percentage === null ? "—" : `${overall.percentage.toFixed(1)}%`}
          hint={
            overall.total === 0
              ? "No classes recorded yet"
              : `${overall.present} of ${overall.total} classes`
          }
          tone={rateTone(overall.percentage, dashboard.lowAttendanceThreshold)}
        />
        <StatCard label="Present" value={String(overall.present)} hint="Confirmed by faculty" />
        <StatCard label="Absent" value={String(overall.absent)} tone="neutral" />
        <StatCard
          label="Today"
          value={String(dashboard.today.length)}
          hint={
            dashboard.todayAwaitingConfirmation > 0
              ? `${dashboard.todayAwaitingConfirmation} awaiting confirmation`
              : "classes recorded"
          }
        />
      </StatGrid>

      <Panel
        title="Today"
        description={formatSessionDate(new Date().toISOString(), {
          weekday: "long",
          day: "numeric",
          month: "long",
        })}
      >
        {dashboard.today.length === 0 ? (
          <EmptyState>
            {dashboard.todayAwaitingConfirmation > 0
              ? `${dashboard.todayAwaitingConfirmation} class${
                  dashboard.todayAwaitingConfirmation === 1 ? "" : "es"
                } today — attendance has not been confirmed by faculty yet.`
              : "No attendance recorded for today."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.today.map((item) => (
              <AttendanceRow key={item.attendanceRecordId} item={item} showDate={false} />
            ))}
          </ul>
        )}
        {dashboard.today.length > 0 && dashboard.todayAwaitingConfirmation > 0 ? (
          <p className="text-xs text-neutral-500">
            {dashboard.todayAwaitingConfirmation} more class
            {dashboard.todayAwaitingConfirmation === 1 ? "" : "es"} today are still
            being confirmed by faculty.
          </p>
        ) : null}
      </Panel>

      {isCollege ? (
        <Panel
          title="Subject-wise attendance"
          description="Counts only classes your faculty has confirmed. Open a subject for its lecture history."
        >
          {dashboard.subjects.length === 0 ? (
            <EmptyState>No subject attendance recorded yet.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {dashboard.subjects.map((subject) => (
                <li key={subject.cohortSubjectId}>
                  <Link
                    href={`/portal/subjects/${subject.cohortSubjectId}`}
                    className="-mx-2 flex flex-col gap-1.5 rounded-md px-2 py-1.5 hover:bg-neutral-50"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="text-sm font-medium text-neutral-900">
                        {subject.subjectName}
                        {subject.subjectCode ? (
                          <span className="ml-2 text-xs font-normal text-neutral-500">
                            {subject.subjectCode}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-neutral-900">
                        <RatePercent rate={subject.rate} />
                      </span>
                    </div>
                    <RateBar rate={subject.rate} threshold={dashboard.lowAttendanceThreshold} />
                    <span className="text-xs text-neutral-500">
                      Present: {subject.rate.present} · Total: {subject.rate.total}
                      {subject.facultyName ? ` · ${subject.facultyName}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : (
        <Panel title="Daily attendance" description="Your last 30 confirmed school days.">
          {dashboard.daily.length === 0 ? (
            <EmptyState>No attendance recorded yet.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100">
              {dashboard.daily.map((day) => (
                <li key={day.attendanceRecordId}>
                  <Link
                    href={`/portal/attendance/${day.attendanceRecordId}`}
                    className="flex items-center justify-between gap-3 py-2.5 hover:bg-neutral-50"
                  >
                    <span className="text-sm text-neutral-900">
                      {formatSessionDate(day.sessionDate, { day: "numeric", month: "long" })}
                    </span>
                    <span className="flex items-center gap-2">
                      {day.isManuallyCorrected ? (
                        <span className="text-xs text-neutral-400">corrected</span>
                      ) : null}
                      <ResultBadge result={day.result} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {dashboard.trend.length > 1 ? (
        <Panel title="Trend" description="Your attendance month by month.">
          <TrendChart
            points={dashboard.trend}
            threshold={dashboard.lowAttendanceThreshold}
          />
        </Panel>
      ) : null}

      <Panel
        title="Recent attendance"
        action={
          <Link href="/portal/attendance" className="text-xs text-neutral-600 hover:underline">
            View all
          </Link>
        }
      >
        {dashboard.recent.length === 0 ? (
          <EmptyState>Nothing to show yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.recent.map((item) => (
              <AttendanceRow key={item.attendanceRecordId} item={item} showDate />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/**
 * The trend, as bars.
 *
 * Deliberately not a line chart: a month with four lectures and a month with
 * twenty are not comparable points on a line, and joining them draws a slope
 * that was never measured. Each month is its own bar, labelled with its own
 * denominator, and the table underneath is the real content — the bars are
 * the decoration. Everything here is also stated in text, because a chart
 * that only works visually communicates by colour and shape alone.
 */
function TrendChart({
  points,
  threshold,
}: {
  points: AttendanceTrendPoint[];
  threshold: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex items-end gap-2 sm:gap-3" aria-hidden>
        {points.map((point) => {
          const height = point.rate.percentage ?? 0;
          const low = point.rate.percentage !== null && point.rate.percentage < threshold;
          return (
            <li key={point.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex h-24 w-full items-end rounded-sm bg-neutral-100">
                <div
                  className={`w-full rounded-sm ${low ? "bg-amber-500" : "bg-neutral-900"}`}
                  style={{ height: `${Math.max(height, 2)}%` }}
                />
              </div>
              <span className="w-full truncate text-center text-[10px] text-neutral-500">
                {point.label}
              </span>
            </li>
          );
        })}
      </ol>
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Attendance by month</caption>
        <thead>
          <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
            <th scope="col" className="py-1.5 pr-4 font-medium">
              Month
            </th>
            <th scope="col" className="py-1.5 pr-4 font-medium">
              Present
            </th>
            <th scope="col" className="py-1.5 font-medium">
              Attendance
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.month} className="border-b border-neutral-100 last:border-0">
              <th scope="row" className="py-1.5 pr-4 text-sm font-normal text-neutral-900">
                {point.label}
              </th>
              <td className="py-1.5 pr-4 text-sm tabular-nums text-neutral-600">
                {point.rate.present} / {point.rate.total}
              </td>
              <td className="py-1.5 text-sm font-medium tabular-nums text-neutral-900">
                <RatePercent rate={point.rate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One tappable row. The whole row is the link so it works on a phone. */
function AttendanceRow({ item, showDate }: { item: StudentAttendanceItem; showDate: boolean }) {
  return (
    <li>
      <Link
        href={`/portal/attendance/${item.attendanceRecordId}`}
        className="flex items-center justify-between gap-3 py-2.5 hover:bg-neutral-50"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-neutral-900">
            {item.subjectName ?? item.cohortName}
          </span>
          <span className="truncate text-xs text-neutral-500">
            {showDate ? formatSessionDate(item.sessionDate) : null}
            {showDate && item.subjectName ? " · " : ""}
            {item.subjectName ? item.cohortName : null}
          </span>
        </span>
        <ResultBadge result={item.result} />
      </Link>
    </li>
  );
}
