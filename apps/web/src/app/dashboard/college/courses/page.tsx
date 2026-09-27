import Link from "next/link";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getCoursesIndex } from "@/modules/college-setup/service";
import { COURSE_STATUS_LABEL } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import {
  COURSE_TONE,
  courseHref,
  courseTitle,
  first,
  readOrDeny,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Every course the viewer may see, with its sections and teachers this
 * session. Filtered by department and semester; courses are added on their
 * semester's page, where they belong.
 */
export default async function CoursesIndexPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const query = await searchParams;
  const filters = {
    sessionId: first(query.session),
    departmentId: first(query.department),
    semesterId: first(query.semester),
    q: first(query.q)?.trim() ?? "",
  };
  const result = await readOrDeny(() => getCoursesIndex(user, filters));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Courses" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const index = result.value;
  const { session, sessions, departments, courses, scope } = index;
  const semesterChoices = departments
    .filter((department) => !index.selectedDepartmentId || department.id === index.selectedDepartmentId)
    .flatMap((department) =>
      department.semesters.map((semester) => ({
        id: semester.id,
        label: scope === "admin" && !index.selectedDepartmentId ? `${department.code ?? department.name} · ${semester.name}` : semester.name,
      })),
    );

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={[{ label: "Courses" }]} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Courses</h1>
        <p className="text-sm text-neutral-500">
          {session ? `Sections and teachers for ${session.name}. ` : ""}Add a course from its semester&apos;s page.
        </p>
      </header>

      <form method="get" action="/dashboard/college/courses" className="flex flex-wrap items-end gap-2" role="search">
        {sessions.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="courses-session" className="text-xs font-medium text-neutral-500">
              Academic session
            </label>
            <Select id="courses-session" name="session" defaultValue={session?.id ?? ""}>
              {sessions.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                  {choice.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {scope === "admin" && departments.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="courses-department" className="text-xs font-medium text-neutral-500">
              Department
            </label>
            <Select id="courses-department" name="department" defaultValue={index.selectedDepartmentId ?? ""}>
              <option value="">All departments</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {semesterChoices.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="courses-semester" className="text-xs font-medium text-neutral-500">
              Semester
            </label>
            <Select id="courses-semester" name="semester" defaultValue={filters.semesterId ?? ""}>
              <option value="">All semesters</option>
              {semesterChoices.map((semester) => (
                <option key={semester.id} value={semester.id}>
                  {semester.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor="courses-q" className="text-xs font-medium text-neutral-500">
            Search code or name
          </label>
          <Input id="courses-q" name="q" defaultValue={filters.q} autoComplete="off" />
        </div>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      <Panel title={`Courses (${courses.length})`}>
        {courses.length === 0 ? (
          <EmptyState>
            {filters.q || filters.semesterId || filters.departmentId
              ? "No course matches these filters."
              : "No courses yet. Open a department's semester to add its first course."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {courses.map((course) => (
              <li key={course.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={withSession(courseHref(course.department.id, course.semester.id, course.id), session, sessions)}
                    className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                  >
                    {courseTitle(course)}
                  </Link>
                  <p className="text-xs text-neutral-500">
                    {scope === "admin" ? `${course.department.name} · ` : ""}
                    {course.semester.name} · {course.studentCount} students
                  </p>
                  {course.sections.length > 0 ? (
                    <p className="text-sm text-neutral-700">
                      {course.sections
                        .map((section) => `${section.label}: ${section.teacher?.name ?? "no teacher"}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
                <Badge tone={COURSE_TONE[course.status]}>{COURSE_STATUS_LABEL[course.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
