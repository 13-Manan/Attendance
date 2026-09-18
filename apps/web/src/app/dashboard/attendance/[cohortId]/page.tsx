import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { requireSameInstitution } from "@/modules/authorization/service";
import { getCohortById } from "@/modules/cohorts/repository";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import { listCohortSubjectsForCapture } from "@/modules/attendance-capture/service";
import { listRecentSessionsForCohort } from "@/modules/attendance-review/repository";

interface PageProps {
  params: Promise<{ cohortId: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Not started",
  CAPTURING: "Capturing",
  PROCESSING: "Processing",
  REVIEW: "Awaiting your review",
  FINALIZED: "Finalized",
};

/**
 * Recent registers for this class. The way back to a review board a faculty
 * member has left — and, for a FINALIZED session, the entry point to the
 * authorized correction workflow.
 */
async function RecentSessions({ cohortId }: { cohortId: string }) {
  const sessions = await listRecentSessionsForCohort(cohortId);
  if (sessions.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-neutral-900">Recent registers</h2>
      <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-neutral-900">
                {s.sessionDate.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
                {s.cohortSubject?.subject ? ` · ${s.cohortSubject.subject.name}` : ""}
              </span>
              <span className="text-xs text-neutral-500">
                {STATUS_LABEL[s.status] ?? s.status}
                {s._count.attendanceRecords > 0
                  ? ` · ${s._count.attendanceRecords} students`
                  : " · no register yet"}
              </span>
            </div>
            {s._count.attendanceRecords > 0 ? (
              <Link
                href={`/dashboard/attendance/${cohortId}/review/${s.id}`}
                className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
              >
                {s.status === "FINALIZED" ? "View register" : "Review"}
              </Link>
            ) : (
              <span className="shrink-0 text-xs text-neutral-400">—</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Class/section landing.
 *
 *   SCHOOL (DAILY mode) → single "Start attendance" call-to-action.
 *   COLLEGE (SUBJECT_WISE)   → subject picker; capture link is per-subject.
 *
 * Server-side authorization is enforced here even though the sidebar
 * filters the link — a hidden link is not what makes a page safe.
 */
export default async function AttendanceCohortLandingPage({ params }: PageProps) {
  const { cohortId } = await params;
  const user = await requirePermissionOrRedirect("attendanceSession.create");

  const cohort = await getCohortById(cohortId);
  if (!cohort) redirect("/dashboard/attendance");
  requireSameInstitution(user, cohort.institutionId);
  await requireCohortAccess(user, cohort.id);

  const institution = await getInstitutionById(cohort.institutionId);
  if (!institution) redirect("/dashboard/attendance");
  const mode = resolveAttendanceMode(institution);

  if (mode === "DAILY") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Link href="/dashboard/attendance" className="text-xs text-neutral-500 hover:underline">
              ← All classes
            </Link>
            <h1 className="text-xl font-semibold text-neutral-900">{cohort.name}</h1>
            <p className="text-sm text-neutral-500">
              Daily attendance{cohort.termLabel ? ` · ${cohort.termLabel}` : ""}
            </p>
          </div>
          <Link
            href={`/dashboard/attendance/${cohort.id}/history`}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Attendance history
          </Link>
        </header>

        <section className="rounded-md border border-neutral-200 p-6">
          <p className="text-sm text-neutral-700">
            Ready to capture today&apos;s attendance for this class.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Only one attendance session per class per day is allowed. If a
            session was already opened today, resuming will continue it in
            place.
          </p>
          <Link
            href={`/dashboard/attendance/${cohort.id}/capture`}
            className="mt-4 inline-flex rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Start attendance
          </Link>
        </section>

        <RecentSessions cohortId={cohort.id} />
      </div>
    );
  }

  // SUBJECT_WISE
  const subjects = await listCohortSubjectsForCapture(user, cohort.id);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard/attendance" className="text-xs text-neutral-500 hover:underline">
            ← All classes
          </Link>
          <h1 className="text-xl font-semibold text-neutral-900">{cohort.name}</h1>
          <p className="text-sm text-neutral-500">
            Subject-wise attendance{cohort.termLabel ? ` · ${cohort.termLabel}` : ""}
          </p>
        </div>
        <Link
          href={`/dashboard/attendance/${cohort.id}/history`}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Attendance history
        </Link>
      </header>

      {subjects.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-500">
          No subjects have been attached to this cohort yet.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
          {subjects.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-neutral-900">{s.subjectName}</span>
                <span className="text-xs text-neutral-500">{s.subjectCode}</span>
              </div>
              <Link
                href={`/dashboard/attendance/${cohort.id}/capture?subject=${encodeURIComponent(s.id)}`}
                className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
              >
                Start attendance
              </Link>
            </li>
          ))}
        </ul>
      )}

      <RecentSessions cohortId={cohort.id} />
    </div>
  );
}
