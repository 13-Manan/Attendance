import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listCapturableCohortsForActor } from "@/modules/attendance-capture/service";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";

/**
 * Phase 4 entry point — "Faculty opens Attendance → Select class/section".
 *
 * The list is scoped by the same rules the server enforces on any subsequent
 * action: admins see the whole institution, everyone else sees only cohorts
 * they teach. A visitor without `attendanceSession.create` is redirected out
 * before this page renders anything.
 */
export default async function AttendanceLandingPage() {
  const user = await requirePermissionOrRedirect("attendanceSession.create");
  const cohorts = await listCapturableCohortsForActor(user);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Take attendance
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Attendance
        </h1>
        <p className="text-sm text-neutral-500">
          Pick a class to start today&apos;s attendance capture.
        </p>
      </header>

      {cohorts.length === 0 ? (
        <Panel title="No classes assigned">
          <EmptyState>
            You do not currently teach any classes. Ask an administrator to
            link you as faculty for a cohort.
          </EmptyState>
        </Panel>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
          {cohorts.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-neutral-50 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-neutral-900">
                  {c.name}
                </span>
                <span className="text-xs text-neutral-500">
                  {c.termLabel ? `${c.termLabel} · ` : ""}
                  {c.attendanceMode === "DAILY"
                    ? "Daily attendance"
                    : "Subject-wise attendance"}
                </span>
              </div>
              <Link href={`/dashboard/attendance/${c.id}`} className="shrink-0">
                <Button type="button" className="w-full sm:w-auto">
                  Open →
                </Button>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
