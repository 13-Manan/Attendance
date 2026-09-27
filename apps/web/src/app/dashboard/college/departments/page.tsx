import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentsOverview } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { NewDepartmentForm } from "@/app/dashboard/college/college-controls";
import {
  Notice,
  SessionSwitcher,
  departmentHref,
  first,
  readOrDeny,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The college's departments, each with its head and its size this session.
 *
 * Where a college is set up from: departments first, then each one's head,
 * semesters and courses. A head of department has one department, so this
 * list is theirs alone and they are taken straight to it.
 */
export default async function DepartmentsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const query = await searchParams;
  const search = first(query.q)?.trim() ?? "";
  const result = await readOrDeny(() => getDepartmentsOverview(user, first(query.session), search));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Departments" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const { session, sessions, departments } = result.value;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  if (!isAdmin && departments.length === 1 && !search) redirect(departmentHref(departments[0].id));

  const needsHead = departments.filter((department) => !department.hod).length;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={[{ label: "Departments" }]} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Departments</h1>
          <p className="max-w-2xl text-sm text-neutral-500">
            {session
              ? `Academic session ${session.name}. Each department has a head, semesters, courses and their sections.`
              : "Each department has a head, semesters, courses and their sections."}
          </p>
        </header>
        {session ? (
          <SessionSwitcher action="/dashboard/college/departments" sessions={sessions} selectedId={session.id} />
        ) : null}
      </div>

      {!session ? (
        <Notice tone="info">
          No academic session is set up yet. Departments, semesters and courses can be added now; sections are added
          to a course for a session.{" "}
          {isAdmin ? (
            <Link href="/dashboard/academic/sessions" className="font-medium underline underline-offset-2">
              Set up an academic session
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {departments.length > 0 && needsHead > 0 && isAdmin ? (
        <Notice tone="info">
          {needsHead === 1 ? "1 department has" : `${needsHead} departments have`} no head yet. Open it to choose one.
        </Notice>
      ) : null}

      <form method="get" action="/dashboard/college/departments" role="search" className="flex flex-wrap items-end gap-2">
        {session && !session.isCurrent ? <input type="hidden" name="session" value={session.id} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor="departments-q" className="text-xs font-medium text-neutral-500">
            Search by name or code
          </label>
          <Input id="departments-q" name="q" defaultValue={search} autoComplete="off" />
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {search ? (
          <Link href="/dashboard/college/departments" className="text-sm text-neutral-600 underline underline-offset-2">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel title="Departments" description="Open a department to manage its head, semesters and courses.">
        {departments.length === 0 ? (
          <EmptyState>
            {search
              ? `No department matches “${search}”.`
              : `No departments yet. ${isAdmin ? "Create your first department below to start setting up the college." : ""}`}
          </EmptyState>
        ) : (
          <>
            <ul className="flex flex-col gap-3 md:hidden">
              {departments.map((department) => (
                <li key={department.id} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={withSession(departmentHref(department.id), session, sessions)}
                      className="text-base font-medium text-neutral-900 underline-offset-2 hover:underline"
                    >
                      {department.name}
                    </Link>
                    {department.code ? <Badge tone="neutral">{department.code}</Badge> : null}
                  </div>
                  <p className="text-sm text-neutral-700">
                    Head: {department.hod ? department.hod.name : <span className="text-amber-700">not chosen</span>}
                    {department.hod && department.hod.status !== "ACTIVE" ? " (disabled)" : ""}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {department.semesters} semesters · {department.courses} courses · {department.sections} sections ·{" "}
                    {department.faculty} faculty · {department.students} students
                  </p>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Department</th>
                    <th className="py-2 pr-4 font-medium">Head of department</th>
                    <th className="py-2 pr-4 text-right font-medium">Semesters</th>
                    <th className="py-2 pr-4 text-right font-medium">Courses</th>
                    <th className="py-2 pr-4 text-right font-medium">Sections</th>
                    <th className="py-2 pr-4 text-right font-medium">Faculty</th>
                    <th className="py-2 text-right font-medium">Students</th>
                  </tr>
                </thead>
                <tbody>
                  {departments.map((department) => (
                    <tr key={department.id} className="border-b border-neutral-100 align-top text-sm">
                      <td className="py-3 pr-4">
                        <Link
                          href={withSession(departmentHref(department.id), session, sessions)}
                          className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                        >
                          {department.name}
                        </Link>
                        {department.code ? (
                          <span className="ml-2 font-mono text-xs text-neutral-500">{department.code}</span>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-neutral-700">
                        {department.hod ? (
                          <>
                            {department.hod.name}
                            {department.hod.status !== "ACTIVE" ? (
                              <span className="ml-2">
                                <Badge tone="danger">Disabled</Badge>
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-amber-700">Not chosen</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">{department.semesters}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{department.courses}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{department.sections}</td>
                      <td className="py-3 pr-4 text-right tabular-nums">{department.faculty}</td>
                      <td className="py-3 text-right tabular-nums">{department.students}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>

      {isAdmin ? (
        <Panel title="Add a department" description="A name and a short code, such as Computer Science and CSE.">
          <NewDepartmentForm />
        </Panel>
      ) : null}

      {isAdmin ? (
        <p className="text-xs text-neutral-500">
          Classes, programmes and subjects set up on the older screens are still available from{" "}
          <Link href="/dashboard/academic/cohorts" className="font-medium text-neutral-700 underline underline-offset-2">
            the classes list
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
