import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentStudents } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
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
 * Everyone in one of the department's sections this session, with every
 * section of the department they are in. A student taking a course of another
 * department appears there too — they are that department's student for that
 * course.
 */
export default async function DepartmentStudentsPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;
  const q = first(query.q)?.trim() ?? "";
  const courseId = first(query.course) ?? "";
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() => getDepartmentStudents(user, departmentId, { sessionId: first(query.session), q, courseId }));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Students" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();
  const { department, session, sessions, students, truncated, courses } = view;
  const here = `${departmentHref(department.id)}/students`;
  const canOpenRecord = hasPermission(user, "student.read");

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail
        items={[
          ...trailBase,
          { label: department.name, href: withSession(departmentHref(department.id), session, sessions) },
          { label: "Students" },
        ]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">{department.name} students</h1>
        <p className="text-sm text-neutral-500">
          {session ? `Everyone in one of the department's sections in ${session.name}.` : "No academic session yet."}
        </p>
      </header>

      <form method="get" action={here} className="flex flex-wrap items-end gap-2" role="search">
        {session && !session.isCurrent ? <input type="hidden" name="session" value={session.id} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="student-search" className="text-xs font-medium text-neutral-500">
            Search by name or student ID
          </label>
          <Input id="student-search" name="q" defaultValue={q} autoComplete="off" />
        </div>
        {courses.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-course" className="text-xs font-medium text-neutral-500">
              Course
            </label>
            <Select id="student-course" name="course" defaultValue={courseId}>
              <option value="">All courses</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code ? `${course.code} · ${course.name}` : course.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {q || courseId ? (
          <Link href={here} className="text-sm text-neutral-600 underline underline-offset-2">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel title={`Students (${students.length}${truncated ? "+" : ""})`}>
        {students.length === 0 ? (
          <EmptyState>
            {q || courseId ? "Nobody matches these filters." : "No students in the department's sections yet. Add them from a section."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {students.map((student) => (
              <li key={student.studentId} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {canOpenRecord ? (
                    <Link
                      href={`/dashboard/students/${student.studentId}`}
                      className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                    >
                      {student.firstName} {student.lastName}
                    </Link>
                  ) : (
                    <span className="font-medium text-neutral-900">
                      {student.firstName} {student.lastName}
                    </span>
                  )}
                  <span className="font-mono text-xs text-neutral-500">{student.studentCode}</span>
                  {student.faceEnrolled ? <Badge tone="positive">Face on file</Badge> : <Badge tone="warning">No face yet</Badge>}
                  {student.hasLogin ? <Badge tone="info">Has login</Badge> : null}
                </div>
                <ul className="flex flex-wrap gap-2">
                  {student.sections.map((section) => (
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
              </li>
            ))}
          </ul>
        )}
        {truncated ? (
          <p className="text-xs text-neutral-500">More students match than are listed. Narrow the search to find one.</p>
        ) : null}
      </Panel>
    </div>
  );
}
