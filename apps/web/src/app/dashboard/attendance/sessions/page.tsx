import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { isPlatformUser } from "@/modules/authorization/service";
import {
  listFacultySessions,
  normalizeSessionFilters,
} from "@/modules/attendance-analytics/service";
import { SESSION_STATUSES } from "@/modules/attendance-analytics/types";
import type { FacultySessionFilters } from "@/modules/attendance-analytics/types";
import { SessionRow } from "@/components/attendance/session-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";

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

  // Same reason as /dashboard: a register belongs to an institution, and a
  // platform account belongs to none, so `listFacultySessions` refuses with
  // `institution_scope_required`. The permission gate above cannot catch it —
  // a platform super admin holds `attendanceRecord.read` like every other
  // permission — so the scope has to be checked by role.
  if (isPlatformUser(user)) redirect("/dashboard/platform");

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
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {list.scope === "institution" ? "Institution sessions" : "My sessions"}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            Attendance sessions
          </h1>
          <p className="text-sm text-neutral-500">
            {list.scope === "institution"
              ? "Every register in this institution."
              : "Registers for the classes and subjects assigned to you."}
          </p>
        </div>
        <Link href="/dashboard/attendance" className="shrink-0">
          <Button type="button" className="w-full sm:w-auto">
            + Take attendance
          </Button>
        </Link>
      </header>

      <Panel
        title="Filter"
        description="Filters compose into the URL — a filtered view is a shareable link."
      >
        {/* A plain GET form: submitting rewrites the query string, which is
            the page's entire state. No action, no Server Action, nothing to
            authorize — reading this page is already gated above. */}
        <form method="get" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-neutral-600">
              From
              <Input type="date" name="from" defaultValue={filters.from ?? ""} />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-neutral-600">
              To
              <Input type="date" name="to" defaultValue={filters.to ?? ""} />
            </label>

            <label className="flex flex-col gap-1.5 text-xs font-medium text-neutral-600">
              Class
              <Select name="cohortId" defaultValue={filters.cohortId ?? ""}>
                <option value="">All classes</option>
                {list.cohorts.map((cohort) => (
                  <option key={cohort.cohortId} value={cohort.cohortId}>
                    {cohort.name}
                  </option>
                ))}
              </Select>
            </label>

            {isCollege ? (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-neutral-600">
                Subject
                <Select name="cohortSubjectId" defaultValue={filters.cohortSubjectId ?? ""}>
                  <option value="">All subjects</option>
                  {list.subjects.map((subject) => (
                    <option key={subject.cohortSubjectId} value={subject.cohortSubjectId}>
                      {subject.subjectName} · {subject.cohortName}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}

            <label className="flex flex-col gap-1.5 text-xs font-medium text-neutral-600">
              Status
              <Select name="status" defaultValue={filters.status ?? ""}>
                <option value="">Any status</option>
                {SESSION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </label>

            <label className="flex items-center gap-2 sm:mt-7">
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

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Apply filters</Button>
            {hasFilters ? (
              <Link href="/dashboard/attendance/sessions">
                <Button type="button" variant="secondary">
                  Clear
                </Button>
              </Link>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-3 text-xs">
              <Link
                href="/dashboard/attendance/sessions?today=1"
                className="text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline"
              >
                Today
              </Link>
              <Link
                href="/dashboard/attendance/sessions?status=REVIEW"
                className="text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline"
              >
                Needs review
              </Link>
            </div>
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
