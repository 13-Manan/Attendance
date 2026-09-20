import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  listFacultySessions,
  normalizeSessionFilters,
} from "@/modules/attendance-analytics/service";
import { SESSION_STATUSES } from "@/modules/attendance-analytics/types";
import type { FacultySessionFilters } from "@/modules/attendance-analytics/types";
import { SessionRow } from "@/components/attendance/session-list";
import { EmptyState, Panel } from "@/components/ui/panel";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Not started",
  CAPTURING: "Capturing",
  PROCESSING: "Processing",
  REVIEW: "Needs review",
  FINALIZED: "Confirmed",
  CANCELLED: "Cancelled",
};

function one(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * Every attendance session this faculty member may see, filtered.
 *
 * The dashboard answers "what needs me today". This answers the other
 * question a teacher actually asks — "what happened in 9B last month", "which
 * registers did I leave in review" — which the dashboard's three fixed panels
 * could not, because they are scoped to today and to the most recent few.
 *
 * ## The URL is the filter
 *
 * A GET form and links, no client JavaScript, following
 * `/dashboard/reports`. A filtered list is then a real URL: a class teacher
 * can bookmark "my classes, needs review" and mail it to a colleague, and it
 * still works with JavaScript off. `today` is a flag rather than a
 * pre-computed date range so that a bookmarked "today" is still today
 * tomorrow.
 *
 * ## Why the filter values are safe to take from the URL
 *
 * They are not authorization. `listFacultySessions` resolves the actor's own
 * scope server-side and ANDs it with these filters, so a `cohortId` for a
 * class this actor does not teach narrows an already-restricted query and
 * matches nothing. Typing somebody else's class id into the address bar
 * returns an empty list, not their register.
 */
export default async function FacultySessionsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("attendanceRecord.read");
  const params = await searchParams;

  const filters = normalizeSessionFilters({
    today: one(params, "today"),
    from: one(params, "from"),
    to: one(params, "to"),
    cohortId: one(params, "cohortId"),
    cohortSubjectId: one(params, "cohortSubjectId"),
    status: one(params, "status"),
  });

  const list = await listFacultySessions(user, filters);
  const isCollege = list.attendanceMode === "SUBJECT_WISE";
  const hasFilters = isFiltered(filters);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Attendance sessions</h1>
          <p className="text-sm text-neutral-500">
            {list.scope === "institution"
              ? "Every register in this institution."
              : "Registers for the classes and subjects assigned to you."}
          </p>
        </div>
        <Link
          href="/dashboard/attendance"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Take attendance
        </Link>
      </header>

      <Panel title="Filter">
        {/* A plain GET form: submitting rewrites the query string, which is
            the page's entire state. No action, no Server Action, nothing to
            authorize — reading this page is already gated above. */}
        <form method="get" className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">From</span>
              <input
                type="date"
                name="from"
                defaultValue={filters.from ?? ""}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">To</span>
              <input
                type="date"
                name="to"
                defaultValue={filters.to ?? ""}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">Class</span>
              <select
                name="cohortId"
                defaultValue={filters.cohortId ?? ""}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              >
                <option value="">All classes</option>
                {list.cohorts.map((cohort) => (
                  <option key={cohort.cohortId} value={cohort.cohortId}>
                    {cohort.name}
                  </option>
                ))}
              </select>
            </label>

            {isCollege ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-600">Subject</span>
                <select
                  name="cohortSubjectId"
                  defaultValue={filters.cohortSubjectId ?? ""}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
                >
                  <option value="">All subjects</option>
                  {list.subjects.map((subject) => (
                    <option key={subject.cohortSubjectId} value={subject.cohortSubjectId}>
                      {subject.subjectName} · {subject.cohortName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600">Status</span>
              <select
                name="status"
                defaultValue={filters.status ?? ""}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-900 focus:outline-none"
              >
                <option value="">Any status</option>
                {SESSION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 sm:mt-6">
              <input
                type="checkbox"
                name="today"
                value="1"
                defaultChecked={filters.today}
                className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
              />
              <span className="text-sm text-neutral-700">Today only</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              Apply filters
            </button>
            {hasFilters ? (
              <Link
                href="/dashboard/attendance/sessions"
                className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Clear
              </Link>
            ) : null}
            <Link
              href="/dashboard/attendance/sessions?today=1"
              className="text-sm text-neutral-600 hover:underline"
            >
              Today
            </Link>
            <Link
              href="/dashboard/attendance/sessions?status=REVIEW"
              className="text-sm text-neutral-600 hover:underline"
            >
              Needs review
            </Link>
          </div>
        </form>
      </Panel>

      <Panel
        title="Sessions"
        description={describeResult(list.sessions.length, list.truncated, hasFilters)}
      >
        {list.sessions.length === 0 ? (
          <EmptyState>
            {hasFilters
              ? "No sessions match these filters. Try widening the date range or clearing the class filter."
              : list.cohorts.length === 0
                ? "You are not linked to any class yet. Ask an administrator to add you as faculty for a cohort."
                : "No attendance sessions have been held yet. Start one from Take attendance."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {list.sessions.map((session) => (
              <SessionRow key={session.sessionId} session={session} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function isFiltered(filters: FacultySessionFilters): boolean {
  return Boolean(
    filters.today ||
      filters.from ||
      filters.to ||
      filters.cohortId ||
      filters.cohortSubjectId ||
      filters.status,
  );
}

function describeResult(count: number, truncated: boolean, filtered: boolean): string {
  if (count === 0) return filtered ? "Nothing matched." : "Nothing recorded yet.";
  const noun = `${count} session${count === 1 ? "" : "s"}`;
  if (truncated) {
    return `Showing the most recent ${noun}. Narrow the date range to see older ones.`;
  }
  return filtered ? `${noun} matched.` : `${noun}, newest first.`;
}
