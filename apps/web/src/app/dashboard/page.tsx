import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getFacultyDashboard } from "@/modules/attendance-analytics/service";
import { hasPermission } from "@/modules/authorization/service";
import { SessionRow } from "@/components/attendance/session-list";
import { StatCard, StatGrid, formatSessionDate } from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";

/**
 * The staff landing page.
 *
 * Role-aware rather than one-size-fits-all:
 *
 *  - A student who lands here (a bookmark, a shared link) is sent to their
 *    own portal rather than shown an empty staff dashboard.
 *  - Faculty get today's sessions, their review queue, their classes and
 *    subjects, and recent registers — all scoped to what they are assigned.
 *  - An institution admin gets the same, institution-wide, plus the reports
 *    entry point.
 *
 * Everything on the page is scoped by `resolveFacultyScope`, so a college
 * lecturer sees their own subjects and classes and nothing else.
 */
export default async function DashboardHomePage() {
  const user = await requireUser();

  if (!hasPermission(user, "attendanceRecord.read")) {
    // A student account: /dashboard has nothing for them, and an empty staff
    // shell is a worse answer than their own attendance.
    if (hasPermission(user, "attendanceRecord.read.own")) redirect("/portal");

    const roleNames = user.roles.map((role) => role.name).join(", ") || "No role assigned";
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-neutral-900">Welcome, {user.name}</h1>
        <p className="text-sm text-neutral-500">Roles: {roleNames}</p>
      </div>
    );
  }

  const dashboard = await getFacultyDashboard(user);
  const isAdmin = dashboard.scope === "institution";
  const isCollege = dashboard.attendanceMode === "SUBJECT_WISE";
  const pendingStudents = dashboard.pendingReview.reduce((n, s) => n + s.counts.needsReview, 0);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Welcome, {user.name}</h1>
          <p className="text-xs text-neutral-500">
            {formatSessionDate(new Date().toISOString(), {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
            {isAdmin ? " · Institution-wide view" : ""}
          </p>
        </div>
        {isAdmin ? (
          <Link
            href="/dashboard/reports"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Institution reports
          </Link>
        ) : null}
      </header>

      <StatGrid>
        <StatCard label="Today's sessions" value={String(dashboard.today.length)} />
        <StatCard
          label="Pending review"
          value={String(dashboard.pendingReview.length)}
          hint={
            pendingStudents > 0
              ? `${pendingStudents} student${pendingStudents === 1 ? "" : "s"} unresolved`
              : "Nothing waiting"
          }
          tone={dashboard.pendingReview.length > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label={isAdmin ? "Classes" : "My classes"}
          value={String(dashboard.cohorts.length)}
        />
        <StatCard
          label={isAdmin ? "Subjects" : "My subjects"}
          value={String(dashboard.subjects.length)}
          hint={isCollege ? undefined : "Daily attendance"}
        />
      </StatGrid>

      {dashboard.pendingReview.length > 0 ? (
        <Panel
          title="Needs review"
          description="These registers are not visible to students until you confirm them."
        >
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.pendingReview.map((session) => (
              <SessionRow key={session.sessionId} session={session} />
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Today's sessions"
        action={
          hasPermission(user, "attendanceSession.create") ? (
            <Link href="/dashboard/attendance" className="text-xs text-neutral-600 hover:underline">
              Take attendance
            </Link>
          ) : null
        }
      >
        {dashboard.today.length === 0 ? (
          <EmptyState>
            No attendance sessions today yet.
            {hasPermission(user, "attendanceSession.create")
              ? " Start one from Attendance."
              : ""}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.today.map((session) => (
              <SessionRow key={session.sessionId} session={session} showDate={false} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={isAdmin ? "Classes" : "My classes"}
        description={
          dashboard.isClassTeacher
            ? "You are the class teacher for the classes marked below."
            : undefined
        }
      >
        {dashboard.cohorts.length === 0 ? (
          <EmptyState>
            You are not linked to any class yet. Ask an administrator to add you
            as faculty for a cohort.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {dashboard.cohorts.map((cohort) => (
              <li key={cohort.cohortId}>
                <Link
                  href={`/dashboard/attendance/${cohort.cohortId}/history`}
                  className="flex h-full flex-col gap-1 rounded-md border border-neutral-200 p-3 hover:bg-neutral-50"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-neutral-900">
                      {cohort.name}
                    </span>
                    {cohort.facultyRole === "PRIMARY" ? (
                      <span className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                        Class teacher
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {cohort.termLabel ? `${cohort.termLabel} · ` : ""}
                    {cohort.studentCount} student{cohort.studentCount === 1 ? "" : "s"}
                  </span>
                  <span className="text-xs text-neutral-400">
                    {cohort.lastSessionDate
                      ? `Last confirmed ${formatSessionDate(cohort.lastSessionDate)}`
                      : "No confirmed attendance yet"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {isCollege ? (
        <Panel
          title={isAdmin ? "Subjects" : "My subjects"}
          description={
            isAdmin ? undefined : "Only subjects assigned to you are listed here."
          }
        >
          {dashboard.subjects.length === 0 ? (
            <EmptyState>No subjects are assigned to you.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100">
              {dashboard.subjects.map((subject) => (
                <li key={subject.cohortSubjectId}>
                  <Link
                    href={`/dashboard/attendance/${subject.cohortId}/history`}
                    className="flex items-center justify-between gap-3 py-2.5 hover:bg-neutral-50"
                  >
                    <span className="min-w-0 truncate text-sm text-neutral-900">
                      {subject.subjectName}
                      <span className="ml-2 text-xs text-neutral-500">{subject.subjectCode}</span>
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">{subject.cohortName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <Panel title="Recent attendance">
        {dashboard.recent.length === 0 ? (
          <EmptyState>No confirmed attendance yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.recent.map((session) => (
              <SessionRow key={session.sessionId} session={session} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
