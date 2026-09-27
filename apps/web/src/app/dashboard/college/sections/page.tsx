import Link from "next/link";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getCoursesIndex } from "@/modules/college-setup/service";
import { SECTION_STATUS_LABEL } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import {
  SECTION_TONE,
  courseTitle,
  first,
  readOrDeny,
  sectionHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Every course section of one session the viewer may see — the list a head
 * of department works down: who teaches each, how full it is, and which
 * still need a teacher.
 */
export default async function SectionsIndexPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const query = await searchParams;
  const needsTeacherOnly = first(query.show) === "needs-teacher";
  const result = await readOrDeny(() =>
    getCoursesIndex(user, { sessionId: first(query.session), departmentId: first(query.department) }),
  );
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Sections" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const { session, sessions, departments, courses, scope, selectedDepartmentId } = result.value;
  const rows = courses.flatMap((course) =>
    course.sections
      .filter((section) => !needsTeacherOnly || section.status !== "ready")
      .map((section) => ({ course, section })),
  );

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={[{ label: "Sections" }]} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Sections</h1>
        <p className="text-sm text-neutral-500">
          {session ? `Every course section in ${session.name}.` : "No academic session yet."} Sections are added on their
          course&apos;s page.
        </p>
      </header>

      <form method="get" action="/dashboard/college/sections" className="flex flex-wrap items-end gap-2">
        {sessions.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sections-session" className="text-xs font-medium text-neutral-500">
              Academic session
            </label>
            <Select id="sections-session" name="session" defaultValue={session?.id ?? ""}>
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
            <label htmlFor="sections-department" className="text-xs font-medium text-neutral-500">
              Department
            </label>
            <Select id="sections-department" name="department" defaultValue={selectedDepartmentId ?? ""}>
              <option value="">All departments</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="sections-show" className="text-xs font-medium text-neutral-500">
            Show
          </label>
          <Select id="sections-show" name="show" defaultValue={needsTeacherOnly ? "needs-teacher" : ""}>
            <option value="">All sections</option>
            <option value="needs-teacher">Needing a teacher</option>
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      <Panel title={`Sections (${rows.length})`}>
        {rows.length === 0 ? (
          <EmptyState>
            {needsTeacherOnly
              ? "Every section has a teacher."
              : "No sections yet. Open a course to add its sections for the session."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {rows.map(({ course, section }) => (
              <li key={section.id} className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <Link
                    href={sectionHref(course.department.id, course.semester.id, course.id, section.id)}
                    className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                  >
                    {courseTitle(course)} — {section.label}
                  </Link>
                  <p className="text-xs text-neutral-500">
                    {scope === "admin" ? `${course.department.name} · ` : ""}
                    {course.semester.name} · {section.teacher ? section.teacher.name : "No teacher"} ·{" "}
                    {section.studentCount} students
                  </p>
                </div>
                <Badge tone={SECTION_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
