import Link from "next/link";
import type { FacultySessionSummary } from "@/modules/attendance-analytics/types";
import { formatSessionDate, formatTime } from "@/components/ui/attendance-stat";

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Not started",
  CAPTURING: "Capturing",
  PROCESSING: "Processing",
  REVIEW: "Needs review",
  FINALIZED: "Confirmed",
  CANCELLED: "Cancelled",
};

const STATUS_CLASSES: Record<string, string> = {
  OPEN: "bg-neutral-100 text-neutral-600 ring-neutral-200",
  CAPTURING: "bg-blue-50 text-blue-700 ring-blue-200",
  PROCESSING: "bg-blue-50 text-blue-700 ring-blue-200",
  REVIEW: "bg-amber-50 text-amber-800 ring-amber-200",
  FINALIZED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  CANCELLED: "bg-neutral-100 text-neutral-500 ring-neutral-200",
};

export function SessionStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        STATUS_CLASSES[status] ?? STATUS_CLASSES.OPEN
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * Where a session row should take a faculty member.
 *
 * A register that has been generated — in review, or already confirmed —
 * opens on the review board, which is also the entry point for an authorized
 * post-finalization correction. Anything earlier goes to the class page,
 * where capture starts. The link never jumps straight into capture: starting
 * a capture is an action, and an action should not be something you arrive at
 * by tapping a list.
 */
export function sessionHref(session: FacultySessionSummary): string {
  if (session.status === "REVIEW" || session.status === "FINALIZED") {
    return `/dashboard/attendance/${session.cohortId}/review/${session.sessionId}`;
  }
  return `/dashboard/attendance/${session.cohortId}`;
}

/**
 * A session, as one tappable row: what class, what subject, when, how it
 * stands, and the Present/Absent/Review split.
 *
 * The counts wrap under the title on narrow screens rather than being
 * truncated — "43 present / 5 absent / 2 to review" is the point of the row.
 */
export function SessionRow({
  session,
  showDate = true,
}: {
  session: FacultySessionSummary;
  showDate?: boolean;
}) {
  const { counts } = session;
  return (
    <li>
      <Link
        href={sessionHref(session)}
        className="-mx-2 flex min-h-11 flex-col gap-1.5 rounded-md px-2 py-3 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-neutral-900">
            {session.subjectName ?? session.cohortName}
            {session.subjectName ? (
              <span className="ml-2 text-xs font-normal text-neutral-500">
                {session.cohortName}
              </span>
            ) : null}
          </span>
          <span className="text-xs text-neutral-500">
            {showDate ? `${formatSessionDate(session.sessionDate)} · ` : ""}
            {formatTime(session.startedAt)}
            {session.facultyName ? ` · ${session.facultyName}` : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {counts.total > 0 ? (
            <span className="text-xs tabular-nums text-neutral-600">
              <span className="text-emerald-700">{counts.present} present</span>
              {" · "}
              {counts.absent} absent
              {counts.needsReview > 0 ? (
                <span className="text-amber-700"> · {counts.needsReview} to review</span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-neutral-400">No register yet</span>
          )}
          <SessionStatusBadge status={session.status} />
        </span>
      </Link>
    </li>
  );
}
