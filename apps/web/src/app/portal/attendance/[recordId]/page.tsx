import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getOwnAttendanceDetail } from "@/modules/attendance-analytics/service";
import { ForbiddenError } from "@/modules/authorization/types";
import {
  ResultBadge,
  correctionSourceLabel,
  formatSessionDate,
  formatTime,
} from "@/components/ui/attendance-stat";
import { Panel } from "@/components/ui/panel";

interface PageProps {
  params: Promise<{ recordId: string }>;
}

/**
 * One attendance record, opened by the student it belongs to.
 *
 * Read-only. The page shows what was decided, who is accountable for it, and
 * every change that was made to it — but offers no way to change it. A
 * student who believes a record is wrong is pointed at the faculty member who
 * owns the register, which is where a correction has to come from: every
 * correction is attributable to a staff actor, and that is the property that
 * makes the audit trail worth anything.
 */
export default async function StudentAttendanceDetailPage({ params }: PageProps) {
  const { recordId } = await params;
  const user = await requirePermissionOrRedirect("attendanceRecord.read.own");

  let detail;
  try {
    detail = await getOwnAttendanceDetail(user, recordId);
  } catch (e) {
    if (e instanceof ForbiddenError) redirect("/unauthorized");
    throw e;
  }
  // Null covers both "no such record" and "the register is not confirmed
  // yet" — deliberately indistinguishable, so this page cannot be used to
  // probe for the existence of another student's record.
  if (!detail) notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href="/portal"
          className="w-fit text-xs text-neutral-500 hover:text-neutral-900 hover:underline"
        >
          ← Back to my attendance
        </Link>
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Attendance record
        </span>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            {detail.subjectName ?? detail.cohortName}
          </h1>
          <ResultBadge result={detail.result} />
        </div>
        <p className="text-sm text-neutral-500">
          {formatSessionDate(detail.sessionDate, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
      </div>

      <Panel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="Date">
            {formatSessionDate(detail.sessionDate, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </Row>
          <Row label="Class">{detail.cohortName || "—"}</Row>
          <Row label="Subject">
            {detail.subjectName
              ? `${detail.subjectName}${detail.subjectCode ? ` (${detail.subjectCode})` : ""}`
              : "Daily attendance"}
          </Row>
          <Row label="Faculty">{detail.facultyName ?? "—"}</Row>
          <Row label="Attendance status">
            <ResultBadge result={detail.result} />
          </Row>
          <Row label="Confirmed">
            {detail.finalizedAt
              ? `${formatSessionDate(detail.finalizedAt)} at ${formatTime(detail.finalizedAt)}`
              : "—"}
          </Row>
        </dl>
      </Panel>

      <Panel title="Session" description="How this class's register was taken.">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="Started">{formatTime(detail.startedAt)}</Row>
          <Row label="Ended">{detail.endedAt ? formatTime(detail.endedAt) : "—"}</Row>
          <Row label="Method">
            {detail.generationSource === "recognition"
              ? "Face recognition, reviewed by faculty"
              : detail.generationSource === "manual"
                ? "Manual roll call"
                : "—"}
          </Row>
          {detail.generationSource === "recognition" ? (
            <Row label="Photos taken">{detail.captureCount || "—"}</Row>
          ) : null}
        </dl>
        {detail.generationSource === "recognition" ? (
          <p className="text-xs text-neutral-500">
            Face recognition only suggests attendance. Every result on this
            register was confirmed by the faculty member before it was
            published.
          </p>
        ) : null}
      </Panel>

      {detail.corrections.length > 0 ? (
        <Panel title="Changes to this record">
          <ol className="flex flex-col gap-3">
            {detail.corrections.map((correction) => (
              <li key={correction.id} className="flex flex-col gap-1 text-sm">
                <span className="flex flex-wrap items-center gap-2 text-neutral-900">
                  <ResultBadge result={correction.previousResult} />
                  <span aria-hidden className="text-neutral-400">
                    →
                  </span>
                  <span className="sr-only">changed to</span>
                  <ResultBadge result={correction.newResult} />
                </span>
                <span className="text-xs text-neutral-500">
                  {correctionSourceLabel(correction.source)}
                  {correction.changedByName ? ` by ${correction.changedByName}` : ""} ·{" "}
                  {formatSessionDate(correction.changedAt)} at {formatTime(correction.changedAt)}
                </span>
                {correction.reason ? (
                  <span className="text-xs text-neutral-600">“{correction.reason}”</span>
                ) : null}
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      <p className="text-xs text-neutral-500">
        Attendance can only be changed by your faculty. If you think this record
        is wrong, contact
        {detail.facultyName ? ` ${detail.facultyName}` : " your faculty"} with the
        date and subject above.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-neutral-500">{label}</dt>
      <dd className="text-sm text-neutral-900">{children}</dd>
    </div>
  );
}
