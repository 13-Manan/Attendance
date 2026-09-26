import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getStudentSubjectDetail } from "@/modules/attendance-analytics/service";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  RateBar,
  RatePercent,
  ResultBadge,
  StatCard,
  StatGrid,
  formatSessionDate,
  rateTone,
} from "@/components/ui/attendance-stat";
import { BackToParent } from "@/components/nav/back-to-parent";
import { EmptyState, Panel } from "@/components/ui/panel";

interface PageProps {
  params: Promise<{ cohortSubjectId: string }>;
}

/**
 * One subject, opened by the student who studies it.
 *
 * The drill-down behind a subject row on the portal: the percentage, and then
 * the individual classes it was computed from. A student who is told they are
 * at 68% in Database Management is entitled to see which lectures that is —
 * an attendance figure nobody can audit is a figure nobody can dispute.
 *
 * The id in the URL is a lookup key, not a credential. `getStudentSubjectDetail`
 * selects from the caller's *own* finalized records, so a subject the caller
 * does not study resolves to nothing and lands on notFound() — the same
 * response as a subject that does not exist, so this page cannot be used to
 * probe for one.
 */
export default async function StudentSubjectPage({ params }: PageProps) {
  const { cohortSubjectId } = await params;
  const user = await requirePermissionOrRedirect("attendanceRecord.read.own");

  let detail;
  try {
    detail = await getStudentSubjectDetail(user, cohortSubjectId);
  } catch (e) {
    if (e instanceof ForbiddenError) redirect("/unauthorized");
    throw e;
  }
  if (!detail) notFound();

  const { rate } = detail;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <BackToParent href="/portal" label="My attendance" />
        <h1 className="text-xl font-semibold text-neutral-900">{detail.subjectName}</h1>
        <p className="text-xs text-neutral-500">
          {detail.subjectCode ? `${detail.subjectCode} · ` : ""}
          {detail.cohortName}
          {detail.facultyName ? ` · ${detail.facultyName}` : ""}
        </p>
      </div>

      <StatGrid>
        <StatCard
          label="Attendance"
          value={rate.percentage === null ? "—" : `${rate.percentage.toFixed(1)}%`}
          hint={`${rate.present} of ${rate.total} lectures`}
          tone={rateTone(rate.percentage, detail.lowAttendanceThreshold)}
        />
        <StatCard label="Present" value={String(rate.present)} hint="Confirmed by faculty" />
        <StatCard label="Absent" value={String(rate.absent)} tone="neutral" />
        <StatCard label="Lectures held" value={String(rate.total)} hint="Confirmed registers" />
      </StatGrid>

      <div className="flex flex-col gap-1.5">
        <RateBar rate={rate} threshold={detail.lowAttendanceThreshold} />
        <p className="text-xs text-neutral-500">
          <RatePercent rate={rate} /> attended. Your institution treats below{" "}
          {detail.lowAttendanceThreshold}% as low attendance.
        </p>
      </div>

      <Panel
        title="Lecture history"
        description="Every confirmed register for this subject, newest first."
      >
        {detail.sessions.length === 0 ? (
          <EmptyState>No confirmed lectures for this subject yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {detail.sessions.map((item) => (
              <li key={item.attendanceRecordId}>
                <Link
                  href={`/portal/attendance/${item.attendanceRecordId}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-neutral-50"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-neutral-900">
                      {formatSessionDate(item.sessionDate, {
                        weekday: "short",
                        day: "numeric",
                        month: "long",
                      })}
                    </span>
                    {item.isManuallyCorrected ? (
                      <span className="text-xs text-neutral-500">Corrected by faculty</span>
                    ) : null}
                  </span>
                  <ResultBadge result={item.result} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-xs text-neutral-500">
        Only lectures your faculty has confirmed are counted here. A class held
        today may not appear until its register is confirmed.
      </p>
    </div>
  );
}
