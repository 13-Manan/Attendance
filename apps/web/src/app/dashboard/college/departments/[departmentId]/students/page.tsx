import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentStudents } from "@/modules/college-setup/service";
import { STUDENT_LOGIN_LABEL, type DepartmentStudentFilters, type StudentLoginState } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  LINK_PRIMARY,
  LINK_SECONDARY,
  Notice,
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

const LOGIN_TONE: Record<StudentLoginState, BadgeTone> = { none: "neutral", enabled: "info", disabled: "danger" };

/** A filter value from the URL, or "" for anything the page does not offer. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | "" {
  return allowed.includes(value as T) ? (value as T) : "";
}

/**
 * The department's students: everyone in one of its course sections this
 * session, with each section they are in, their face and their sign-in —
 * searchable by name, student ID or admission number and filterable by
 * course, section, face and sign-in. "+ Add student" adds an existing student
 * of the college or admits a new one; each student has their own page.
 *
 * A student in a course of another department appears there too: they are
 * that department's student for that course.
 */
export default async function DepartmentStudentsPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const filters: DepartmentStudentFilters = {
    sessionId: first(query.session),
    q: first(query.q)?.trim() ?? "",
    courseId: first(query.course) ?? "",
    sectionId: first(query.section) ?? "",
    face: oneOf(first(query.face), ["enrolled", "not_enrolled"] as const),
    login: oneOf(first(query.login), ["none", "enabled", "disabled"] as const),
  };

  const result = await readOrDeny(() => getDepartmentStudents(user, departmentId, filters));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Students" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();
  const { department, session, sessions, students, truncated, courses, sections } = view;
  const here = departmentPeopleHref(department.id, "students");
  const listHref = withSession(here, session, sessions);
  const addHref = departmentPeopleHref(department.id, "students", "add");
  const filtered = Boolean(filters.q || filters.courseId || filters.sectionId || filters.face || filters.login);
  const removedStudent = first(query.removedStudent);
  const removedFrom = first(query.from);
  const trail = departmentTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: withSession(departmentHref(department.id), session, sessions) },
    list: { label: "Students", href: listHref },
  });

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Students</h1>
          <p className="text-sm text-neutral-500">
            {isAdmin
              ? `Everyone in one of ${department.name}'s course sections${session ? ` in ${session.name}` : ""}.`
              : "Manage students enrolled in your department's courses and sections."}
          </p>
        </header>
        <div className="flex flex-wrap items-end gap-2">
          {session ? <SessionSwitcher action={here} sessions={sessions} selectedId={session.id} /> : null}
          {session?.isActive ? (
            <Link href={addHref} className={LINK_PRIMARY}>
              + Add student
            </Link>
          ) : null}
        </div>
      </div>

      {removedStudent ? (
        <Notice>
          {removedStudent} was taken out of {removedFrom || "the section"}, their last section in {department.name}. Their
          student record, face enrolment, login and attendance history are kept.
        </Notice>
      ) : null}

      <form method="get" action={here} role="search" className="flex flex-wrap items-end gap-2">
        {session && !session.isCurrent ? <input type="hidden" name="session" value={session.id} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor="student-search" className="text-xs font-medium text-neutral-500">
            Name, student ID or admission number
          </label>
          <Input id="student-search" name="q" defaultValue={filters.q} autoComplete="off" />
        </div>
        {courses.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-course" className="text-xs font-medium text-neutral-500">
              Course
            </label>
            <Select id="student-course" name="course" defaultValue={filters.courseId}>
              <option value="">All courses</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code ? `${course.name} (${course.code})` : course.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {sections.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="student-section" className="text-xs font-medium text-neutral-500">
              Section
            </label>
            <Select id="student-section" name="section" defaultValue={filters.sectionId}>
              <option value="">All sections</option>
              {sections.map((section) => (
                <option key={section.sectionId} value={section.sectionId}>
                  {section.course.name} — {section.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="student-face" className="text-xs font-medium text-neutral-500">
            Face
          </label>
          <Select id="student-face" name="face" defaultValue={filters.face}>
            <option value="">Any</option>
            <option value="enrolled">Enrolled</option>
            <option value="not_enrolled">Not enrolled</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="student-login" className="text-xs font-medium text-neutral-500">
            Sign-in
          </label>
          <Select id="student-login" name="login" defaultValue={filters.login}>
            <option value="">Any</option>
            <option value="enabled">{STUDENT_LOGIN_LABEL.enabled}</option>
            <option value="disabled">{STUDENT_LOGIN_LABEL.disabled}</option>
            <option value="none">{STUDENT_LOGIN_LABEL.none}</option>
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

      <Panel title={`Students (${students.length}${truncated ? "+" : ""})`}>
        {students.length === 0 ? (
          <EmptyState>
            {filtered ? (
              "Nobody matches these filters."
            ) : (
              <span className="flex flex-col items-center gap-3">
                No students yet{session ? ` in ${session.name}` : ""}.
                {session?.isActive ? (
                  <Link href={addHref} className={LINK_PRIMARY}>
                    + Add student
                  </Link>
                ) : null}
              </span>
            )}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {students.map((student) => {
              const name = `${student.firstName} ${student.lastName}`.trim();
              const page = departmentPeopleHref(department.id, "students", student.studentId);
              return (
                <li key={student.studentId} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={page} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
                        {name}
                      </Link>
                      <span className="font-mono text-xs text-neutral-500">{student.studentCode}</span>
                      {student.admissionNumber ? (
                        <span className="text-xs text-neutral-500">Admission no. {student.admissionNumber}</span>
                      ) : null}
                    </div>
                    <ul className="flex flex-wrap gap-2" aria-label={`Sections ${name} is in`}>
                      {student.sections.map((section) => (
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
                    <div className="flex flex-wrap gap-2">
                      {student.faceEnrolled ? (
                        <Badge tone="positive">Face enrolled</Badge>
                      ) : (
                        <Badge tone="warning">No face enrolled</Badge>
                      )}
                      <Badge tone={LOGIN_TONE[student.login]}>{STUDENT_LOGIN_LABEL[student.login]}</Badge>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={page} className={LINK_SECONDARY}>
                      View<span className="sr-only"> {name}</span>
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {truncated ? (
          <p className="text-xs text-neutral-500">More students match than are listed. Narrow the search to find one.</p>
        ) : null}
      </Panel>
    </div>
  );
}
