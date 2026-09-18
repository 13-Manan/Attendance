import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getStudentDashboard } from "@/modules/attendance-analytics/service";
import type { StudentAttendanceItem } from "@/modules/attendance-analytics/types";
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
          description="Counts only classes your faculty has confirmed."
        >
          {dashboard.subjects.length === 0 ? (
            <EmptyState>No subject attendance recorded yet.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {dashboard.subjects.map((subject) => (
                <li key={subject.cohortSubjectId} className="flex flex-col gap-1.5">
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
