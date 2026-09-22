import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getCohortAttendanceHistory } from "@/modules/attendance-analytics/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { SessionStatusBadge, sessionHref } from "@/components/attendance/session-list";
import {
  RateBar,
  RatePercent,
  ResultBadge,
  StatCard,
  StatGrid,
  correctionSourceLabel,
  formatSessionDate,
  formatTime,
  rateTone,
} from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";

interface PageProps {
  params: Promise<{ cohortId: string }>;
}

/**
 * Class attendance history — the class-teacher view.
 *
 * Covers the four things a class teacher needs and a subject lecturer needs a
 * slice of: class attendance, day-by-day (or lecture-by-lecture) history, who
 * was absent, and every correction made to the register.
 *
 * Access is resolved in the service. A class teacher or an admin sees the
 * whole class; a college lecturer who reaches this class only through an
 * assigned subject sees only that subject's sessions. Nobody else gets here.
 */
export default async function CohortAttendanceHistoryPage({ params }: PageProps) {
  const { cohortId } = await params;
  const user = await requirePermissionOrRedirect("attendanceRecord.read");

  let history;
  try {
    history = await getCohortAttendanceHistory(user, cohortId);
  } catch (e) {
    if (e instanceof ForbiddenError) redirect("/unauthorized");
    if (e instanceof Error && e.message === "cohort_not_found") notFound();
    throw e;
  }

  const isCollege = history.attendanceMode === "SUBJECT_WISE";
  const finalizedCount = history.sessions.filter((s) => s.isFinalized).length;
  const awaitingCount = history.sessions.filter(
    (s) => s.status === "REVIEW" || s.status === "PROCESSING",
  ).length;

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link
          href={`/dashboard/attendance/${cohortId}`}
          className="w-fit text-xs text-neutral-500 hover:text-neutral-900 hover:underline"
        >
          ← Back to class
        </Link>
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Attendance history
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          {history.cohortName}
        </h1>
        <p className="text-sm text-neutral-500">
          {history.termLabel ? `${history.termLabel} · ` : ""}
          {isCollege ? "Subject-wise attendance" : "Daily attendance"} · last{" "}
          {history.sessions.length} session{history.sessions.length === 1 ? "" : "s"}
        </p>
      </header>

      <StatGrid>
        <StatCard label="Students" value={String(history.studentCount)} />
        <StatCard
          label="Class attendance"
          value={
            history.overall.percentage === null
              ? "—"
              : `${history.overall.percentage.toFixed(1)}%`
          }
          hint={
            history.overall.total === 0
              ? "No confirmed sessions"
              : `${history.overall.present} of ${history.overall.total} marks`
          }
          tone={rateTone(history.overall.percentage, history.lowAttendanceThreshold)}
        />
        <StatCard label="Confirmed sessions" value={String(finalizedCount)} />
        <StatCard
          label="Awaiting review"
          value={String(awaitingCount)}
          tone={awaitingCount > 0 ? "warning" : "neutral"}
        />
      </StatGrid>

      <Panel
        title={isCollege ? "Session history" : "Daily attendance"}
        description="Open a session to review or correct it."
      >
        {history.sessions.length === 0 ? (
          <EmptyState>No attendance has been taken for this class yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {history.sessions.map((session) => (
              <li key={session.sessionId} className="flex flex-col gap-2 py-3">
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <Link
                    href={sessionHref(session)}
                    className="flex min-w-0 flex-col gap-0.5 hover:underline"
                  >
                    <span className="truncate text-sm font-medium text-neutral-900">
                      {formatSessionDate(session.sessionDate, {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })}
                      {session.subjectName ? ` · ${session.subjectName}` : ""}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {formatTime(session.startedAt)}
                      {session.facultyName ? ` · ${session.facultyName}` : ""}
                    </span>
                  </Link>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs tabular-nums text-neutral-600">
                      {session.counts.present}/{session.counts.total} present
                      {session.counts.needsReview > 0 ? (
                        <span className="text-amber-700">
                          {" "}
                          · {session.counts.needsReview} to review
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs font-semibold tabular-nums text-neutral-900">
                      <RatePercent rate={session.rate} />
                    </span>
                    <SessionStatusBadge status={session.status} />
                  </div>
                </div>
                <RateBar rate={session.rate} threshold={history.lowAttendanceThreshold} />
                {session.absentStudents.length > 0 ? (
                  // <details> rather than a toggle with state: the absent list
                  // is long and secondary, and this works without JavaScript.
                  <details className="text-xs">
                    <summary className="cursor-pointer text-neutral-600 hover:text-neutral-900">
                      {session.absentStudents.length} absent
                    </summary>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-neutral-700">
                      {session.absentStudents.map((student) => (
                        <li key={student.studentId} className="tabular-nums">
                          {student.studentCode} · {student.firstName} {student.lastName}
                          {student.isManuallyCorrected ? (
                            <span className="text-neutral-400"> (corrected)</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : session.isFinalized ? (
                  <p className="text-xs text-emerald-700">Full attendance.</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Corrections"
        description="Every manual change to this class's attendance, most recent first."
      >
        {history.corrections.length === 0 ? (
          <EmptyState>No attendance has been manually corrected for this class.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {history.corrections.map((correction) => (
              <li key={correction.id} className="flex flex-col gap-1 py-2.5">
                <span className="flex flex-wrap items-center gap-2 text-sm text-neutral-900">
                  <span className="font-medium">{correction.studentName}</span>
                  <span className="text-xs tabular-nums text-neutral-500">
                    {correction.studentCode}
                  </span>
                  <ResultBadge result={correction.previousResult} />
                  <span aria-hidden className="text-neutral-400">
                    →
                  </span>
                  <span className="sr-only">changed to</span>
                  <ResultBadge result={correction.newResult} />
                </span>
                <span className="text-xs text-neutral-500">
                  {correction.sessionDate ? `${formatSessionDate(correction.sessionDate)} · ` : ""}
                  {correctionSourceLabel(correction.source)}
                  {correction.changedByName ? ` by ${correction.changedByName}` : ""} ·{" "}
                  {formatSessionDate(correction.changedAt)} at {formatTime(correction.changedAt)}
                  {correction.reason ? ` · “${correction.reason}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
