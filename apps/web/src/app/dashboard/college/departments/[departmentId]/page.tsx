import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentDetail } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  CurrentSemesterButton,
  EditDepartmentForm,
  HeadControls,
  NewSemesterForm,
} from "@/app/dashboard/college/college-controls";
import {
  Figure,
  MOMENT_FORMAT,
  Notice,
  SessionSwitcher,
  departmentHref,
  first,
  readOrDeny,
  semesterHref,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * One department: its head, its semesters and how large it is this session.
 *
 * An administrator names the head here — an existing member of staff or a new
 * account — and manages that head's sign-in: a new password shown once,
 * disable and enable. The head sees the same page for their own department
 * without those controls; there is no screen, for anyone, that shows a
 * current password.
 */
export default async function DepartmentPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() => getDepartmentDetail(user, departmentId, first(query.session)));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Department" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const department = result.value;
  if (!department) notFound();

  const { session, sessions, semesters, counts, hod } = department;
  const here = departmentHref(department.id);
  const created = first(query.created) === "1";
  const removed = first(query.removed);
  const headRemoved = first(query.headRemoved);
  const nextNumber = semesters.reduce((max, semester) => Math.max(max, semester.number), 0) + 1;
  const isOwnDepartment = !isAdmin && hod?.userId === user.userId;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={[...trailBase, { label: department.name }]} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-neutral-900">{department.name}</h1>
            {department.code ? <Badge tone="neutral">{department.code}</Badge> : null}
          </div>
          <p className="text-sm text-neutral-500">
            {session ? `Academic session ${session.name}` : "No academic session yet"}
            {isOwnDepartment ? " · You are the head of this department" : ""}
          </p>
        </header>
        {session ? <SessionSwitcher action={here} sessions={sessions} selectedId={session.id} /> : null}
      </div>

      {created ? (
        <Notice>{department.name} was created. Next: choose its head, then add its semesters.</Notice>
      ) : null}
      {removed ? <Notice>{removed} was removed.</Notice> : null}
      {headRemoved ? (
        <Notice>{headRemoved} no longer heads this department and is back to an ordinary teaching role.</Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Figure label="Semesters" value={counts.semesters} />
        <Figure label="Courses" value={counts.courses} />
        <Figure label="Sections" value={counts.sections} />
        <Figure label="Faculty" value={counts.faculty} href={`${here}/faculty`} />
        <Figure label="Students" value={counts.students} href={withSession(`${here}/students`, session, sessions)} />
      </div>

      <Panel
        title="Head of department"
        description="Signs in with their own email and password, and manages this department — and only this one."
      >
        {hod ? (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Name</dt>
                <dd className="text-neutral-900">{hod.name}</dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Login</dt>
                <dd className="break-all font-mono text-neutral-900">{hod.email}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Account</dt>
                <dd>
                  {hod.status === "ACTIVE" ? <Badge tone="positive">Active</Badge> : <Badge tone="danger">Disabled</Badge>}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs uppercase tracking-wide text-neutral-500">Last sign-in</dt>
                <dd className="text-neutral-900">
                  {hod.lastLoginAt ? MOMENT_FORMAT.format(hod.lastLoginAt) : <span className="text-neutral-400">Never</span>}
                </dd>
              </div>
              {hod.employeeCode ? (
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs uppercase tracking-wide text-neutral-500">Employee code</dt>
                  <dd className="text-neutral-900">{hod.employeeCode}</dd>
                </div>
              ) : null}
            </dl>
            {!hod.consistent ? (
              <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {hod.name} is named as this department&apos;s head, but their department or role has since been changed,
                so they can&apos;t manage it. Choose the head again below.
              </p>
            ) : null}
          </div>
        ) : (
          <EmptyState>{department.name} has no head yet.</EmptyState>
        )}
        {/* One instance in one place, so a password it has just issued survives
            the refresh that turns "no head yet" into the head's details. */}
        {isAdmin ? (
          <HeadControls
            departmentId={department.id}
            hasHead={Boolean(hod)}
            headId={hod?.userId ?? null}
            headActive={hod?.status === "ACTIVE"}
            candidates={department.hodCandidates}
          />
        ) : null}
      </Panel>

      <Panel
        title="Semesters"
        description="Courses are added to a semester; each course has its own sections."
      >
        {semesters.length === 0 ? (
          <EmptyState>No semesters yet. Add the first one below — for example semester 1.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {semesters.map((semester) => (
              <li key={semester.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={withSession(semesterHref(department.id, semester.id), session, sessions)}
                      className="text-base font-medium text-neutral-900 underline-offset-2 hover:underline"
                    >
                      {semester.name}
                    </Link>
                    {semester.isCurrent ? <Badge tone="info">Current semester</Badge> : null}
                  </div>
                  <p className="text-xs text-neutral-500">
                    {semester.courses} {semester.courses === 1 ? "course" : "courses"} · {semester.sections}{" "}
                    {semester.sections === 1 ? "section" : "sections"} · {semester.students}{" "}
                    {semester.students === 1 ? "student" : "students"}
                  </p>
                </div>
                <CurrentSemesterButton
                  departmentId={department.id}
                  semesterId={semester.id}
                  isCurrent={semester.isCurrent}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-neutral-200 pt-4">
          <h3 className="mb-3 text-sm font-semibold text-neutral-900">Add a semester</h3>
          <NewSemesterForm departmentId={department.id} suggestedNumber={nextNumber} />
        </div>
      </Panel>

      {isAdmin ? (
        <Panel title="Department details" description="The name and code shown across the college's screens.">
          <EditDepartmentForm departmentId={department.id} name={department.name} code={department.code ?? ""} />
        </Panel>
      ) : null}
    </div>
  );
}
