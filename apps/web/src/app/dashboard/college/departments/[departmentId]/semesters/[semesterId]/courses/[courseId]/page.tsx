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
  AddSectionForm,
  EditCourseForm,
  RemoveCourseButton,
  TeacherEditor,
} from "@/app/dashboard/college/college-controls";
import {
  COURSES_PATH,
  LINK_PRIMARY,
  LINK_SECONDARY,
  Notice,
  SECTION_TONE,
  SessionSwitcher,
  courseHref,
  courseTrail,
  courseWithCode,
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

/** `href` with one more query parameter. */
function withParam(href: string, key: string, value: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

/**
 * One course in one academic session — the place its sections are run from:
 * each section's teacher and student count, "+ Add section" (`?add=section`)
 * and "Edit course" (`?edit=course`), both of which survive a refresh.
 * Sections are the course's own; a student can be in Physics A and Chemistry B.
 */
export default async function CoursePage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId, semesterId, courseId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() =>
    getCourseDetail(user, departmentId, semesterId, courseId, first(query.session)),
  );
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[isAdmin ? { label: "Departments", href: "/dashboard/college/departments" } : { label: "Courses", href: COURSES_PATH }, { label: "Course" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const course = result.value;
  if (!course) notFound();
  const { department, semester, session, sessions, sections, teachers } = course;
  const ids = { departmentId: department.id, semesterId: semester.id, courseId: course.id };
  const here = withSession(courseHref(department.id, semester.id, course.id), session, sessions);
  const editable = Boolean(session?.isActive);
  const students = sections.reduce((sum, section) => sum + section.studentCount, 0);
  const created = first(query.created) === "1";
  const removed = first(query.removed);
  const adding = editable && course.canHaveSections && first(query.add) === "section";
  const editing = first(query.edit) === "course";
  const trail = courseTrail({
    viewer: isAdmin ? "admin" : "hod",
    coursesHref: withSession(COURSES_PATH, session, sessions),
    department: { name: department.name, href: withSession(departmentHref(department.id), session, sessions) },
    semester: { name: semester.name, href: withSession(semesterHref(department.id, semester.id), session, sessions) },
    course: { name: course.name, code: course.code, href: here },
  });
  const noTeachersHint = isAdmin
    ? "No teacher can take attendance yet. Sections can be added now and given a teacher later — add teachers on the Faculty page."
    : `No teacher in ${department.name} can take attendance yet. Sections can be added now and given a teacher later; ask the college administrator to add teachers to your department.`;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-neutral-900">{course.name}</h1>
            {course.code ? <Badge tone="neutral">{course.code}</Badge> : null}
          </div>
          <p className="text-sm text-neutral-500">
            {semester.name} · {department.name}
            {session && sessions.length > 1 ? ` · Academic session ${session.name}` : ""}
          </p>
        </header>
        <div className="flex flex-wrap items-end gap-2">
          {!editing ? (
            <Link href={withParam(here, "edit", "course")} className={LINK_SECONDARY}>
              Edit course
            </Link>
          ) : null}
          {session ? <SessionSwitcher action={courseHref(department.id, semester.id, course.id)} sessions={sessions} selectedId={session.id} /> : null}
        </div>
      </div>

      {created ? (
        <Notice>
          {course.name} was added. Next: add its sections{session ? ` for ${session.name}` : ""}, and give each a teacher.
        </Notice>
      ) : null}
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
        <Notice tone="info">This course has no code yet. Give it one under Edit course before adding sections.</Notice>
      ) : null}

      {editing ? (
        <Panel
          title="Edit course"
          description="The name and code registers and the student portal show."
          action={
            <Link href={here} className={LINK_SECONDARY}>
              Close
            </Link>
          }
        >
          <div className="flex flex-col gap-5">
            <EditCourseForm ids={ids} code={course.code ?? ""} name={course.name} sessionId={session?.id ?? ""} />
            {sections.length === 0 ? <RemoveCourseButton ids={ids} /> : null}
          </div>
        </Panel>
      ) : null}

      {adding && session ? (
        <Panel
          title="Add a section"
          description={`For ${session.name}. Add as many as the course needs, one after another.`}
          action={
            <Link href={here} className={LINK_SECONDARY}>
              Close
            </Link>
          }
        >
          <AddSectionForm
            ids={ids}
            sessionId={session.id}
            courseLabel={courseWithCode(course)}
            existingNames={sections.map((section) => section.name)}
            teachers={teachers}
            noTeachersHint={noTeachersHint}
          />
        </Panel>
      ) : null}

      <Panel
        title="Sections"
        description={`${sections.length} ${sections.length === 1 ? "section" : "sections"} · ${students} ${students === 1 ? "student" : "students"}`}
        action={
          editable && course.canHaveSections && !adding ? (
            <Link href={withParam(here, "add", "section")} className={LINK_PRIMARY}>
              + Add section
            </Link>
          ) : null
        }
      >
        {sections.length === 0 ? (
          <EmptyState>
            {course.name} has no sections{session ? ` in ${session.name}` : ""} yet.
            {editable && course.canHaveSections && !adding ? " Add the first one with + Add section." : ""}
          </EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {sections.map((section) => {
              const open = sectionHref(department.id, semester.id, course.id, section.id);
              return (
                <li key={section.id} className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-medium text-neutral-900">
                      <Link href={open} className="underline-offset-2 hover:underline">
                        {section.label}
                      </Link>
                    </h3>
                    <Badge tone={SECTION_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
                  </div>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-neutral-500">Teacher</dt>
                    <dd className="min-w-0 break-words text-neutral-900">
                      {section.teacher ? (
                        <>
                          {section.teacher.name}
                          {!section.teacher.active ? <span className="ml-1 text-red-700">(can&apos;t sign in)</span> : null}
                        </>
                      ) : (
                        <span className="text-amber-700">Needs teacher</span>
                      )}
                    </dd>
                    <dt className="text-neutral-500">Students</dt>
                    <dd className="tabular-nums text-neutral-900">{section.studentCount}</dd>
                    {section.groupName !== section.label ? (
                      <>
                        <dt className="text-neutral-500">Registers</dt>
                        <dd className="font-mono text-xs leading-5 text-neutral-600">{section.groupName}</dd>
                      </>
                    ) : null}
                  </dl>
                  {editable ? (
                    <TeacherEditor ids={{ ...ids, sectionId: section.id }} teachers={teachers} current={section.teacher} compact />
                  ) : null}
                  <div>
                    <Link href={open} className={LINK_SECONDARY}>
                      Open section<span className="sr-only"> {section.label}</span>
                    </Link>
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
