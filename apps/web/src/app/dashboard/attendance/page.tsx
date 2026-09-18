import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listCapturableCohortsForActor } from "@/modules/attendance-capture/service";

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
        <h1 className="text-xl font-semibold text-neutral-900">Attendance</h1>
        <p className="text-sm text-neutral-500">
          Pick a class to start today&apos;s attendance capture.
        </p>
      </header>

      {cohorts.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500">
          You do not currently teach any classes. Ask an administrator to link
          you as faculty for a cohort.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
          {cohorts.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-neutral-900">{c.name}</span>
                <span className="text-xs text-neutral-500">
                  {c.termLabel ? `${c.termLabel} · ` : ""}
                  {c.attendanceMode === "DAILY"
                    ? "Daily attendance"
                    : "Subject-wise attendance"}
                </span>
              </div>
              <Link
                href={`/dashboard/attendance/${c.id}`}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
