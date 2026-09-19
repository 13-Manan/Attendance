import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listAcademicSessionSummariesForRequest } from "@/modules/academic-sessions/service";
import { SESSION_STATE_LABEL, sessionState } from "@/modules/academic-sessions/policy";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";
import { AcademicSessionControls } from "./session-controls";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/academic/sessions";

/**
 * Formatted in UTC because the dates are stored as UTC midnight — the calendar
 * day the administrator typed. Formatting them in the reader's zone would show
 * "31 May" to anybody west of Greenwich for a year that starts on 1 June.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const STATE_TONE = {
  current: "positive",
  open: "info",
  archived: "neutral",
} as const;

/**
 * The academic years this institution runs.
 *
 * ## Why there are three states rather than two
 *
 * A year is archived, or it is the current one, or it is open but not current.
 * The third is the common case that a single "active" flag cannot express: an
 * institution sets next year up in March while this year is still running.
 * Merging them would make creating next year's calendar silently move every
 * default onto it.
 *
 * Gated on `academicStructure.manage` for reading as well as writing, which is
 * what this page has always required — there is no read-only academic
 * permission to offer instead.
 */
export default async function AcademicSessionsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to an institution, so there are no academic
        years to manage here.
      </p>
    );
  }

  const params = await searchParams;
  const sessions = await listAcademicSessionSummariesForRequest(user);
  const current = sessions.find((session) => session.isCurrent) ?? null;
  const open = sessions.filter((session) => session.isActive).length;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Academic years</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Every class, enrollment and register belongs to an academic year. One year at a time is
          the current one — the year a new class is set up in and the year a report means when it
          says &ldquo;this year&rdquo;.
        </p>
      </header>

      {params.saved === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Changes saved.
        </p>
      ) : null}

      {sessions.length > 0 && !current ? (
        // Stated rather than guessed at. Silently treating the newest year as
        // current would make every screen downstream confident about something
        // nobody chose.
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No year is marked as current. Choose one below — until then, screens that need to know
          which year it is have no answer.
        </p>
      ) : null}

      <Panel
        title="Years"
        description="The current year first, then open years, then archived ones."
        action={
          <Link
            href={`${BASE}/new`}
            className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            New year
          </Link>
        }
      >
        {sessions.length === 0 ? (
          <EmptyState>
            No academic years yet. Add the year this institution is in now — classes, enrollments
            and registers all hang off it, so nothing else can be set up until one exists.
          </EmptyState>
        ) : (
          <>
            <TableScroll minWidth="min-w-[48rem]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Year</th>
                    <th className="py-2 pr-4 font-medium">Runs</th>
                    <th className="py-2 pr-4 font-medium">Classes</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => {
                    const state = sessionState(session);
                    return (
                      <tr key={session.id} className="border-b border-neutral-100 align-top">
                        <td className="py-3 pr-4 text-sm font-medium text-neutral-900">
                          {session.name}
                        </td>
                        <td className="py-3 pr-4 text-sm text-neutral-600">
                          {DATE_FORMAT.format(session.startDate)} &ndash;{" "}
                          {DATE_FORMAT.format(session.endDate)}
                        </td>
                        <td className="py-3 pr-4 text-sm tabular-nums text-neutral-600">
                          {session.cohortCount.toLocaleString()}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge tone={STATE_TONE[state]}>{SESSION_STATE_LABEL[state]}</Badge>
                        </td>
                        <td className="py-3">
                          <div className="flex flex-col items-start gap-2">
                            <Link
                              href={`${BASE}/${session.id}/edit`}
                              className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
                            >
                              Edit
                            </Link>
                            <AcademicSessionControls session={session} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
            <p className="mt-3 text-xs tabular-nums text-neutral-500">
              {sessions.length} {sessions.length === 1 ? "year" : "years"}, {open} open
              {current ? `, current: ${current.name}` : ", none current"}
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
