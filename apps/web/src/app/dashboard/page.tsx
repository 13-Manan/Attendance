import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getFacultyDashboard } from "@/modules/attendance-analytics/service";
import { hasPermission, isPlatformUser } from "@/modules/authorization/service";
import { getFaceServiceStatus, getInstitutionCounts } from "@/modules/institutions/overview";
import { getInstitutionType } from "@/modules/institutions/repository";
import { SessionRow } from "@/components/attendance/session-list";
import { QuickActionsPanel } from "@/components/dashboard/quick-actions-panel";
import { SystemStatusPanel } from "@/components/dashboard/system-status-panel";
import { StatCard, StatGrid, formatSessionDate } from "@/components/ui/attendance-stat";
import { Button } from "@/components/ui/button";
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

  /**
   * A platform account belongs to no institution, so every panel below —
   * today's sessions, my classes, institution counts — has no referent for
   * them. `getFacultyDashboard` says so itself and refuses with
   * `institution_scope_required`, which reached the browser as a bare
   * "Something went wrong" on the landing page a platform admin hits first.
   *
   * The refusal is correct and stays; what was wrong is asking at all. This
   * check is keyed on the *role*, not on permissions, and that distinction is
   * the whole bug: a platform super admin holds every permission in the
   * catalogue, so `hasPermission(user, "attendanceRecord.read")` below is true
   * for them and the page went on to treat them as institution staff. Only
   * `isPlatformUser` can tell the two apart.
   */
  if (isPlatformUser(user)) redirect("/dashboard/platform");

  if (!hasPermission(user, "attendanceRecord.read")) {
    // A student account: /dashboard has nothing for them, and an empty staff
    // shell is a worse answer than their own attendance.
    if (hasPermission(user, "attendanceRecord.read.own")) redirect("/portal");

    // Neither staff nor student — a role exists but grants no attendance view
    // at all. Rare, and previously a bare line of text; an account in this
    // state needs to be told what to do about it, not just what it is.
    const roleNames = user.roles.map((role) => role.name);
    return (
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <h1 className="text-xl font-semibold text-neutral-900">Welcome, {user.name}</h1>
        <Panel title="Nothing is assigned to you yet">
          <EmptyState>
            Your account is active
            {roleNames.length > 0 ? ` with the role ${roleNames.join(", ")}` : ""}, but it
            does not currently grant access to any attendance records. Ask your
            institution administrator to assign you to a class or grant the
            permissions your role needs.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  // `institution.read` is the administrator's gate, and the same permission
  // getInstitutionCounts enforces for itself — checked here only to decide
  // what to render, never as the thing that protects the data.
  const isInstitutionAdmin = hasPermission(user, "institution.read");

  // Independent reads, issued together. The two additions cannot take the
  // page down: counts are skipped entirely without the permission, and
  // getFaceServiceStatus resolves to "unavailable" rather than throwing.
  const [dashboard, counts, faceService, institutionKind] = await Promise.all([
    getFacultyDashboard(user),
    isInstitutionAdmin ? getInstitutionCounts(user) : Promise.resolve(null),
    isInstitutionAdmin ? getFaceServiceStatus() : Promise.resolve(null),
    user.institutionId ? getInstitutionType(user.institutionId) : Promise.resolve(null),
  ]);

  const isAdmin = dashboard.scope === "institution";
  const isCollege = dashboard.attendanceMode === "SUBJECT_WISE";
  const pendingStudents = dashboard.pendingReview.reduce((n, s) => n + s.counts.needsReview, 0);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {isAdmin ? "Institution overview" : "Today"}
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            Welcome, {user.name}
          </h1>
          <p className="text-sm text-neutral-500">
            {formatSessionDate(new Date().toISOString(), {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
            {isAdmin ? " · Institution-wide view" : ""}
          </p>
        </div>
        {isAdmin ? (
          <Link href="/dashboard/reports" className="shrink-0">
            <Button type="button" variant="secondary" className="w-full sm:w-auto">
              Institution reports →
            </Button>
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

      <QuickActionsPanel user={user} institutionKind={institutionKind} />

      {counts ? (
        <Panel
          title="Institution"
          description="Active records across this institution."
          action={
            <Link
              href="/dashboard/students"
              className="text-xs text-neutral-600 hover:underline"
            >
              Manage students
            </Link>
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Students"
              value={String(counts.students)}
              hint="Active enrolments"
            />
            <StatCard
              label="Faculty & staff"
              value={String(counts.faculty)}
              hint="Accounts with a role"
            />
            <StatCard label="Classes" value={String(counts.cohorts)} />
          </div>
        </Panel>
      ) : null}

      {dashboard.pendingReview.length > 0 ? (
        <Panel
          title="Needs review"
          description="These registers are not visible to students until you confirm them."
          action={
            <Link
              href="/dashboard/attendance/sessions?status=REVIEW"
              className="text-xs text-neutral-600 hover:underline"
            >
              View all
            </Link>
          }
        >
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.pendingReview.map((session) => (
              <SessionRow key={session.sessionId} session={session} returnTo="/dashboard" />
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
              <SessionRow
                key={session.sessionId}
                session={session}
                showDate={false}
                returnTo="/dashboard"
              />
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

      <Panel
        title="Recent attendance"
        action={
          <Link
            href="/dashboard/attendance/sessions"
            className="text-xs text-neutral-600 hover:underline"
          >
            All sessions
          </Link>
        }
      >
        {dashboard.recent.length === 0 ? (
          <EmptyState>No confirmed attendance yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.recent.map((session) => (
              <SessionRow key={session.sessionId} session={session} returnTo="/dashboard" />
            ))}
          </ul>
        )}
      </Panel>

      {faceService ? (
        // Last, because it is reference rather than a task — and admin-only,
        // because which model a deployment runs is operational detail a
        // classroom teacher has no action to take on.
        <SystemStatusPanel
          status={{
            // The counts above came back, so the database answered. Probing it
            // again to render a green dot would be a second round trip to
            // learn something this page has already proven.
            database: "operational",
            faceService,
          }}
        />
      ) : null}
    </div>
  );
}
