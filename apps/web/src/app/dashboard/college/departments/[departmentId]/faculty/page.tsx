import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentFaculty } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  SessionSwitcher,
  departmentHref,
  first,
  readOrDeny,
  sectionHref,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The department's teaching staff, and the sections each teaches this
 * session. Accounts — adding staff, passwords, stopping access — stay on the
 * Faculty page, where an administrator manages every account in one place.
 */
export default async function DepartmentFacultyPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() => getDepartmentFaculty(user, departmentId, first(query.session)));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Faculty" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();
  const { department, session, sessions, faculty } = view;
  const here = `${departmentHref(department.id)}/faculty`;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail
        items={[
          ...trailBase,
          { label: department.name, href: withSession(departmentHref(department.id), session, sessions) },
          { label: "Faculty" },
        ]}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">{department.name} faculty</h1>
          <p className="text-sm text-neutral-500">
            Staff of the department{session ? `, and the sections they teach in ${session.name}` : ""}.
          </p>
        </header>
        {session ? <SessionSwitcher action={here} sessions={sessions} selectedId={session.id} /> : null}
      </div>

      <Panel title={`Faculty (${faculty.length})`}>
        {faculty.length === 0 ? (
          <EmptyState>
            Nobody is in this department yet.
            {isAdmin ? " Add staff on the Faculty page and choose this department for them." : ""}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {faculty.map((person) => (
              <li key={person.userId} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-neutral-900">{person.name}</span>
                  {person.isHead ? <Badge tone="info">Head of department</Badge> : null}
                  {!person.member ? <Badge tone="neutral">From another department</Badge> : null}
                  {person.status !== "ACTIVE" ? <Badge tone="danger">Can&apos;t sign in</Badge> : null}
                </div>
                <p className="break-all text-sm text-neutral-600">
                  {person.email}
                  {person.employeeCode ? ` · ${person.employeeCode}` : ""}
                </p>
                {person.sections.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {person.sections.map((section) => (
                      <li key={section.sectionId}>
                        <Link
                          href={sectionHref(department.id, section.semesterId, section.courseId, section.sectionId)}
                          className="inline-flex min-h-8 items-center rounded-full border border-neutral-300 px-3 font-mono text-xs text-neutral-800 hover:bg-neutral-50"
                        >
                          {section.groupName}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-neutral-500">No section this session.</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? (
          <p className="text-xs text-neutral-500">
            Accounts are managed on the{" "}
            <Link href="/dashboard/faculty" className="font-medium text-neutral-700 underline underline-offset-2">
              Faculty page
            </Link>
            .
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
