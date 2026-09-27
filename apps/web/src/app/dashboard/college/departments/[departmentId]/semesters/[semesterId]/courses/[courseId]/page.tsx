import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getCourseDetail } from "@/modules/college-setup/service";
import { SECTION_STATUS_LABEL } from "@/modules/college-setup/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  AddSectionsForm,
  EditCourseForm,
  RemoveCourseButton,
  SectionTeacherForm,
} from "@/app/dashboard/college/college-controls";
import {
  LINK_SECONDARY,
  Notice,
  SECTION_TONE,
  SessionSwitcher,
  courseHref,
  courseTitle,
  departmentHref,
  first,
  readOrDeny,
  sectionHref,
  semesterHref,
  withSession,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string; courseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * One course in one academic session: how many sections it has, who teaches
 * each, and how many students each holds. Sections are the course's own — a
 * student can be in Physics A and Chemistry B.
 */
export default async function CoursePage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId, semesterId, courseId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() =>
    getCourseDetail(user, departmentId, semesterId, courseId, first(query.session)),
  );
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Course" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const course = result.value;
  if (!course) notFound();
  const { department, semester, session, sessions, sections, teachers } = course;
  const ids = { departmentId: department.id, semesterId: semester.id, courseId: course.id };
  const here = courseHref(department.id, semester.id, course.id);
  const editable = Boolean(session?.isActive);
  const students = sections.reduce((sum, section) => sum + section.studentCount, 0);
  const created = first(query.created) === "1";
  const removed = first(query.removed);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail
        items={[
          ...trailBase,
          { label: department.name, href: withSession(departmentHref(department.id), session, sessions) },
          { label: semester.name, href: withSession(semesterHref(department.id, semester.id), session, sessions) },
          { label: courseTitle(course) },
        ]}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">{courseTitle(course)}</h1>
          <p className="text-sm text-neutral-500">
            {department.name} · {semester.name}
            {session ? ` · Academic session ${session.name}` : ""} · {sections.length}{" "}
            {sections.length === 1 ? "section" : "sections"} · {students} {students === 1 ? "student" : "students"}
          </p>
        </header>
        {session ? <SessionSwitcher action={here} sessions={sessions} selectedId={session.id} /> : null}
      </div>

      {created ? <Notice>{course.name} was added. Next: add its sections for {session?.name ?? "the session"}.</Notice> : null}
      {removed ? <Notice>Section {removed} was removed.</Notice> : null}
      {!session ? (
        <Notice tone="info">
          Sections belong to an academic session, and none is set up yet.
          {isAdmin ? (
            <>
              {" "}
              <Link href="/dashboard/academic/sessions" className="font-medium underline underline-offset-2">
                Set up an academic session
              </Link>
              .
            </>
          ) : " Ask the college administrator to set one up."}
        </Notice>
      ) : !session.isActive ? (
        <Notice tone="info">{session.name} is archived, so its sections are shown as they were and can&apos;t be changed.</Notice>
      ) : null}
      {!course.canHaveSections ? (
        <Notice tone="info">This course has no code yet. Give it one below before adding sections.</Notice>
      ) : null}

      <Panel title="Sections" description="Each section's teacher, students and status.">
        {sections.length === 0 ? (
          <EmptyState>
            {course.name} has no sections{session ? ` in ${session.name}` : ""} yet.{editable ? " Add them below." : ""}
          </EmptyState>
        ) : (
          <>
            <ul className="flex flex-col gap-3 md:hidden">
              {sections.map((section) => (
                <li key={section.id} className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-medium text-neutral-900">{section.label}</h3>
                    <Badge tone={SECTION_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-neutral-500">Teacher</dt>
                      <dd className="text-neutral-800">{section.teacher ? section.teacher.name : "Not assigned"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-neutral-500">Students</dt>
                      <dd className="tabular-nums text-neutral-800">{section.studentCount}</dd>
                    </div>
                  </dl>
                  {editable && !section.teacher ? (
                    <SectionTeacherForm ids={{ ...ids, sectionId: section.id }} teachers={teachers} currentId={null} />
                  ) : null}
                  <Link href={sectionHref(department.id, semester.id, course.id, section.id)} className={LINK_SECONDARY}>
                    Manage {section.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Section</th>
                    <th className="py-2 pr-4 font-medium">Teacher</th>
                    <th className="py-2 pr-4 text-right font-medium">Students</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((section) => (
                    <tr key={section.id} className="border-b border-neutral-100 align-top text-sm">
                      <td className="py-3 pr-4">
                        <span className="font-medium text-neutral-900">{section.label}</span>
                        {section.groupName !== section.label ? (
                          <span className="ml-2 font-mono text-xs text-neutral-500">{section.groupName}</span>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-neutral-700">
                        {section.teacher ? (
                          section.teacher.name
                        ) : editable ? (
                          <SectionTeacherForm ids={{ ...ids, sectionId: section.id }} teachers={teachers} currentId={null} compact />
                        ) : (
                          <span className="text-neutral-500">Not assigned</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">{section.studentCount}</td>
                      <td className="py-3 pr-4">
                        <Badge tone={SECTION_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
                      </td>
                      <td className="py-3 text-right">
                        <Link
                          href={sectionHref(department.id, semester.id, course.id, section.id)}
                          className={LINK_SECONDARY}
                          aria-label={`Manage ${section.label}`}
                        >
                          Manage
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {editable && course.canHaveSections && session ? (
          <div className="border-t border-neutral-200 pt-4">
            <h3 className="mb-3 text-sm font-semibold text-neutral-900">Add sections for {session.name}</h3>
            <AddSectionsForm
              ids={ids}
              sessionId={session.id}
              existingNames={sections.map((section) => section.name)}
              teachers={teachers}
            />
            {teachers.length === 0 ? (
              <p className="mt-2 text-xs text-neutral-500">
                No teacher can be chosen yet{isAdmin ? "" : " in your department"}. Sections can be added now and given a
                teacher later.
              </p>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Course details" description="The code and name registers and the student portal show.">
        <div className="flex flex-col gap-5">
          <EditCourseForm ids={ids} code={course.code ?? ""} name={course.name} sessionId={session?.id ?? ""} />
          {sections.length === 0 ? <RemoveCourseButton ids={ids} /> : null}
        </div>
      </Panel>
    </div>
  );
}
