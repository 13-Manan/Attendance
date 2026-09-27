import Link from "next/link";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getCoursesIndex } from "@/modules/college-setup/service";
import { COURSE_STATUS_LABEL, type CourseRow } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { AddCourseForm } from "@/app/dashboard/college/college-controls";
import {
  COURSES_PATH,
  COURSE_TONE,
  LINK_PRIMARY,
  LINK_SECONDARY,
  courseHref,
  courseTitle,
  departmentHref,
  first,
  readOrDeny,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Every course the viewer may see, with its sections and teachers this
 * session, filtered by department and semester.
 *
 * For a head of department this is where their courses are run from: their
 * department's current semester is named at the top, "+ Add course" opens the
 * form here — `?add=course`, so it survives a refresh — and each course is a
 * "Manage" away. An administrator adds courses from a department's semester,
 * as before.
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
  const isHead = scope === "hod";
  const own = isHead ? departments[0] : undefined;
  const current = own?.semesters.find((semester) => semester.id === own.currentSemesterId) ?? null;
  const adding = isHead && first(query.add) === "course";
  const listHref = withSession(COURSES_PATH, session, sessions);
  const addHref = `${listHref}${listHref.includes("?") ? "&" : "?"}add=course`;
  const filtered = Boolean(filters.q || filters.semesterId || filters.departmentId);
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
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Courses</h1>
          {own ? (
            <p className="text-sm text-neutral-500">
              {own.name} · Current semester:{" "}
              {current ? (
                <span className="font-medium text-neutral-900">{current.name}</span>
              ) : (
                <>
                  none set —{" "}
                  <Link href={departmentHref(own.id)} className="font-medium text-neutral-900 underline underline-offset-2">
                    choose one on My department
                  </Link>
                </>
              )}
              {session && sessions.length > 1 ? ` · Academic session ${session.name}` : ""}
            </p>
          ) : (
            <p className="text-sm text-neutral-500">
              {session ? `Sections and teachers for ${session.name}. ` : ""}Add a course from its semester&apos;s page.
            </p>
          )}
        </div>
        {isHead && !adding ? (
          <Link href={addHref} className={LINK_PRIMARY}>
            + Add course
          </Link>
        ) : null}
      </header>

      {adding && own ? (
        <Panel
          title="Add a course"
          description={`To one of ${own.name}'s semesters.`}
          action={
            <Link href={listHref} className={LINK_SECONDARY}>
              Close
            </Link>
          }
        >
          {own.semesters.length === 0 ? (
            <EmptyState>
              {own.name} has no semesters yet.{" "}
              <Link href={departmentHref(own.id)} className="font-medium text-neutral-900 underline">
                Add one on My department
              </Link>
              , then come back to add its courses.
            </EmptyState>
          ) : (
            <AddCourseForm
              semesters={own.semesters.map((semester) => ({
                id: semester.id,
                name: semester.name,
                isCurrent: semester.id === own.currentSemesterId,
              }))}
              defaultSemesterId={current?.id ?? (own.semesters.length === 1 ? own.semesters[0].id : null)}
              sessionId={session?.id ?? ""}
            />
          )}
        </Panel>
      ) : null}

      <form method="get" action={COURSES_PATH} className="flex flex-wrap items-end gap-2" role="search">
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
        {filtered ? (
          <Link href={listHref} className={LINK_SECONDARY}>
            Clear
          </Link>
        ) : null}
      </form>

      <Panel title={`Courses (${courses.length})`}>
        {courses.length === 0 ? (
          <EmptyState>
            {filtered ? (
              "No course matches these filters."
            ) : isHead ? (
              <span className="flex flex-col items-center gap-3">
                No courses yet.
                {!adding ? (
                  <Link href={addHref} className={LINK_PRIMARY}>
                    + Add course
                  </Link>
                ) : null}
              </span>
            ) : (
              "No courses yet. Open a department's semester to add its first course."
            )}
          </EmptyState>
        ) : isHead && own ? (
          <HeadCourseList
            courses={courses}
            semesterOrder={own.semesters.map((semester) => semester.id)}
            currentSemesterId={own.currentSemesterId}
            linkFor={(course) => withSession(courseHref(course.department.id, course.semester.id, course.id), session, sessions)}
          />
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

/**
 * A head of department's courses, a group per semester — the current one
 * first, then the rest in programme order — each course with its sections
 * at a glance and a way in.
 */
function HeadCourseList({
  courses,
  semesterOrder,
  currentSemesterId,
  linkFor,
}: {
  courses: readonly CourseRow[];
  semesterOrder: readonly string[];
  currentSemesterId: string | null;
  linkFor: (course: CourseRow) => string;
}) {
  const rank = (semesterId: string) =>
    semesterId === currentSemesterId ? -1 : semesterOrder.indexOf(semesterId);
  const groups = new Map<string, CourseRow[]>();
  for (const course of courses) {
    groups.set(course.semester.id, [...(groups.get(course.semester.id) ?? []), course]);
  }
  const ordered = [...groups.values()].sort((a, b) => rank(a[0].semester.id) - rank(b[0].semester.id));

  return (
    <div className="flex flex-col gap-5">
      {ordered.map((group) => {
        const semester = group[0].semester;
        return (
          <section key={semester.id} aria-labelledby={`semester-${semester.id}`} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={`semester-${semester.id}`} className="text-sm font-semibold text-neutral-900">
                {semester.name}
              </h3>
              {semester.id === currentSemesterId ? <Badge tone="info">Current semester</Badge> : null}
            </div>
            <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
              {group.map((course) => {
                const sections = course.sections.length;
                return (
                  <li key={course.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Link
                        href={linkFor(course)}
                        className="text-base font-medium text-neutral-900 underline-offset-2 hover:underline"
                      >
                        {course.name}
                      </Link>
                      {course.code ? <span className="font-mono text-xs text-neutral-500">{course.code}</span> : null}
                      <p className="text-xs text-neutral-500">
                        {sections} {sections === 1 ? "section" : "sections"} · {course.studentCount}{" "}
                        {course.studentCount === 1 ? "student" : "students"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={COURSE_TONE[course.status]}>{COURSE_STATUS_LABEL[course.status]}</Badge>
                      <Link href={linkFor(course)} className={LINK_SECONDARY}>
                        Manage<span className="sr-only"> {course.name}</span>
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
