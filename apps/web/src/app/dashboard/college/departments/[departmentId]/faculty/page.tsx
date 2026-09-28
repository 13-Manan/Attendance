import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentFaculty } from "@/modules/college-setup/service";
import type { DepartmentFacultyFilters } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { AddFacultyForm, FacultyAccessButton } from "@/app/dashboard/college/college-controls";
import {
  LINK_PRIMARY,
  LINK_SECONDARY,
  MOMENT_FORMAT,
  SessionSwitcher,
  departmentHref,
  departmentPeopleHref,
  departmentTrail,
  first,
  readOrDeny,
  sectionHref,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** A filter value from the URL, or "" for anything the page does not offer. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | "" {
  return allowed.includes(value as T) ? (value as T) : "";
}

/**
 * The department's teachers: who they are, whether they can sign in, and the
 * sections each teaches this session — searchable and filterable, with
 * "+ Add faculty" (`?add=faculty`) to add a teacher to the department and a
 * page per person for their details, access and sections.
 *
 * Every account change goes through the Faculty page's own service, reached
 * for this department only: the server checks the department and the person
 * on every request.
 */
export default async function DepartmentFacultyPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const filters: DepartmentFacultyFilters = {
    sessionId: first(query.session),
    q: first(query.q)?.trim() ?? "",
    status: oneOf(first(query.status), ["active", "inactive"] as const),
    assigned: oneOf(first(query.assigned), ["assigned", "unassigned"] as const),
  };

  const result = await readOrDeny(() => getDepartmentFaculty(user, departmentId, filters));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Faculty" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();
  const { department, session, sessions, faculty, totalAll } = view;
  const here = departmentPeopleHref(department.id, "faculty");
  const listHref = withSession(here, session, sessions);
  const adding = first(query.add) === "faculty";
  const canAdd = !isAdmin || hasPermission(user, "user.invite");
  const addHref = `${listHref}${listHref.includes("?") ? "&" : "?"}add=faculty`;
  const filtered = Boolean(filters.q || filters.status || filters.assigned);
  const trail = departmentTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: withSession(departmentHref(department.id), session, sessions) },
    list: { label: "Faculty", href: listHref },
  });

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Faculty</h1>
          <p className="text-sm text-neutral-500">
            {isAdmin
              ? `The teachers of ${department.name}, and the sections each teaches${session ? ` in ${session.name}` : ""}.`
              : "Manage the teachers in your department and assign them to course sections."}
          </p>
        </header>
        <div className="flex flex-wrap items-end gap-2">
          {session ? <SessionSwitcher action={here} sessions={sessions} selectedId={session.id} /> : null}
          {canAdd && !adding ? (
            <Link href={addHref} className={LINK_PRIMARY}>
              + Add faculty
            </Link>
          ) : null}
        </div>
      </div>

      {adding && canAdd ? (
        <Panel
          title="Add faculty"
          description={`A new teacher in ${department.name}, with their own sign-in.`}
          action={
            <Link href={listHref} className={LINK_SECONDARY}>
              Close
            </Link>
          }
        >
          <AddFacultyForm departmentId={department.id} facultyHref={here} departmentFaculty={!isAdmin} />
        </Panel>
      ) : null}

      <form method="get" action={here} role="search" className="flex flex-wrap items-end gap-2">
        {session && !session.isCurrent ? <input type="hidden" name="session" value={session.id} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor="faculty-q" className="text-xs font-medium text-neutral-500">
            Search name, email or faculty ID
          </label>
          <Input id="faculty-q" name="q" defaultValue={filters.q} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="faculty-status" className="text-xs font-medium text-neutral-500">
            Account
          </label>
          <Select id="faculty-status" name="status" defaultValue={filters.status}>
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="inactive">Disabled</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="faculty-assigned" className="text-xs font-medium text-neutral-500">
            Sections
          </label>
          <Select id="faculty-assigned" name="assigned" defaultValue={filters.assigned}>
            <option value="">Any</option>
            <option value="assigned">Teaching a section</option>
            <option value="unassigned">No section yet</option>
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {filtered ? (
          <Link href={listHref} className={LINK_SECONDARY}>
            Clear
          </Link>
        ) : null}
      </form>

      <Panel title={`Faculty (${faculty.length})`}>
        {faculty.length === 0 ? (
          <EmptyState>
            {filtered || totalAll > 0 ? (
              "Nobody matches these filters."
            ) : (
              <span className="flex flex-col items-center gap-3">
                No faculty yet.
                {canAdd && !adding ? (
                  <Link href={addHref} className={LINK_PRIMARY}>
                    + Add faculty
                  </Link>
                ) : null}
              </span>
            )}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {faculty.map((person) => {
              const page = departmentPeopleHref(department.id, "faculty", person.userId);
              return (
                <li key={person.userId} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={page} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
                        {person.name}
                      </Link>
                      {person.isHead ? <Badge tone="info">Head of department</Badge> : null}
                      {person.departmentFaculty ? <Badge tone="neutral">Department faculty</Badge> : null}
                      {!person.member ? <Badge tone="neutral">From another department</Badge> : null}
                      {person.status === "ACTIVE" ? (
                        <Badge tone="positive">Active</Badge>
                      ) : (
                        <Badge tone="danger">Disabled</Badge>
                      )}
                    </div>
                    <p className="break-all text-sm text-neutral-600">
                      {person.email}
                      {person.employeeCode ? ` · Faculty ID ${person.employeeCode}` : ""}
                    </p>
                    {person.sections.length > 0 ? (
                      <ul className="flex flex-wrap gap-2" aria-label={`Sections ${person.name} teaches`}>
                        {person.sections.map((section) => (
                          <li key={section.sectionId}>
                            <Link
                              href={sectionHref(department.id, section.semesterId, section.courseId, section.sectionId)}
                              className="inline-flex min-h-8 items-center rounded-full border border-neutral-300 px-3 text-xs text-neutral-800 hover:bg-neutral-50"
                            >
                              {section.courseName} — {section.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-amber-700">No section assigned{session ? ` in ${session.name}` : ""}.</p>
                    )}
                    <p className="text-xs text-neutral-500">
                      {person.lastLoginAt ? `Last signed in ${MOMENT_FORMAT.format(person.lastLoginAt)}` : "Never signed in"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2 sm:max-w-sm sm:justify-end">
                    <Link href={page} className={LINK_SECONDARY}>
                      View<span className="sr-only"> {person.name}</span>
                    </Link>
                    {person.manageable ? (
                      <Link href={`${page}#details`} className={LINK_SECONDARY}>
                        Edit<span className="sr-only"> ({person.name})</span>
                      </Link>
                    ) : null}
                    {person.member && person.status === "ACTIVE" && session?.isActive ? (
                      <Link href={`${page}#assign`} className={LINK_SECONDARY}>
                        Assign to section<span className="sr-only"> ({person.name})</span>
                      </Link>
                    ) : null}
                    {person.manageable && (person.status === "ACTIVE" || person.enableable) ? (
                      <FacultyAccessButton
                        departmentId={department.id}
                        userId={person.userId}
                        active={person.status === "ACTIVE"}
                        personName={person.name}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
