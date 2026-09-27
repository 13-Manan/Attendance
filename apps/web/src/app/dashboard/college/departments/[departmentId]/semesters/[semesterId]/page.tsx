import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getSemesterDetail } from "@/modules/college-setup/service";
import { COURSE_STATUS_LABEL } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  CurrentSemesterButton,
  EditSemesterForm,
  NewCourseForm,
  RemoveSemesterButton,
} from "@/app/dashboard/college/college-controls";
import {
  COURSE_TONE,
  Notice,
  SessionSwitcher,
  courseHref,
  courseTitle,
  departmentHref,
  first,
  readOrDeny,
  semesterHref,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** One semester of a department: its courses, each with its sections this session. */
export default async function SemesterPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId, semesterId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() => getSemesterDetail(user, departmentId, semesterId, first(query.session)));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Semester" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const semester = result.value;
  if (!semester) notFound();
  const { department, session, sessions, courses } = semester;
  const here = semesterHref(department.id, semester.id);
  const removed = first(query.removed);
  const students = courses.reduce((sum, course) => sum + course.studentCount, 0);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail
        items={[
          ...trailBase,
          { label: department.name, href: withSession(departmentHref(department.id), session, sessions) },
          { label: semester.name },
        ]}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-neutral-900">{semester.name}</h1>
            {semester.isCurrent ? <Badge tone="info">Current semester</Badge> : null}
          </div>
          <p className="text-sm text-neutral-500">
            {department.name}
            {session ? ` · Academic session ${session.name}` : ""} · {courses.length}{" "}
            {courses.length === 1 ? "course" : "courses"}
            {students > 0 ? ` · ${students} course enrolments` : ""}
          </p>
        </header>
        {session ? <SessionSwitcher action={here} sessions={sessions} selectedId={session.id} /> : null}
      </div>

      {removed ? <Notice>{removed} was removed.</Notice> : null}

      <Panel title="Courses" description="Open a course to add its sections, give each a teacher and add students.">
        {courses.length === 0 ? (
          <EmptyState>No courses in {semester.name} yet. Add the first one below.</EmptyState>
        ) : (
          <>
            <ul className="flex flex-col gap-3 md:hidden">
              {courses.map((course) => (
                <li key={course.id} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={withSession(courseHref(department.id, semester.id, course.id), session, sessions)}
                      className="text-base font-medium text-neutral-900 underline-offset-2 hover:underline"
                    >
                      {courseTitle(course)}
                    </Link>
                    <Badge tone={COURSE_TONE[course.status]}>{COURSE_STATUS_LABEL[course.status]}</Badge>
                  </div>
                  <p className="text-sm text-neutral-700">
                    {course.sections.length === 0
                      ? "No sections this session"
                      : course.sections.map((section) => `${section.label}: ${section.teacher?.name ?? "no teacher"}`).join(" · ")}
                  </p>
                  <p className="text-xs text-neutral-500">{course.studentCount} students</p>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Course</th>
                    <th className="py-2 pr-4 font-medium">Sections and teachers</th>
                    <th className="py-2 pr-4 text-right font-medium">Students</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {courses.map((course) => (
                    <tr key={course.id} className="border-b border-neutral-100 align-top text-sm">
                      <td className="py-3 pr-4">
                        <Link
                          href={withSession(courseHref(department.id, semester.id, course.id), session, sessions)}
                          className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                        >
                          {courseTitle(course)}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 text-neutral-700">
                        {course.sections.length === 0 ? (
                          <span className="text-neutral-400">None this session</span>
                        ) : (
                          <ul className="flex flex-col gap-0.5">
                            {course.sections.map((section) => (
                              <li key={section.id}>
                                <span className="font-medium">{section.label}</span>
                                {" — "}
                                {section.teacher ? section.teacher.name : <span className="text-amber-700">no teacher</span>}
                                <span className="text-neutral-500"> · {section.studentCount} students</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">{course.studentCount}</td>
                      <td className="py-3">
                        <Badge tone={COURSE_TONE[course.status]}>{COURSE_STATUS_LABEL[course.status]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="border-t border-neutral-200 pt-4">
          <h3 className="mb-3 text-sm font-semibold text-neutral-900">Add a course</h3>
          <NewCourseForm departmentId={department.id} semesterId={semester.id} sessionId={session?.id ?? ""} />
        </div>
      </Panel>

      <Panel title="Semester settings">
        <div className="flex flex-col gap-5">
          <EditSemesterForm
            departmentId={department.id}
            semesterId={semester.id}
            number={semester.number}
            name={semester.name}
          />
          <div className="flex flex-col gap-2">
            <p className="text-sm text-neutral-700">
              {semester.isCurrent
                ? `${semester.name} is the department's current semester.`
                : "The current semester is the one the department's overview leads with."}
            </p>
            <CurrentSemesterButton departmentId={department.id} semesterId={semester.id} isCurrent={semester.isCurrent} />
          </div>
          {courses.length === 0 ? <RemoveSemesterButton departmentId={department.id} semesterId={semester.id} /> : null}
        </div>
      </Panel>
    </div>
  );
}
