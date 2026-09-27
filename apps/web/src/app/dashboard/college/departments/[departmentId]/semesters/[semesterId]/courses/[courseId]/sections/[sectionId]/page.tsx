import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getCourseSectionDetail } from "@/modules/college-setup/service";
import { SECTION_STATUS_LABEL } from "@/modules/college-setup/types";
import { withReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  AddStudentsByIdForm,
  InviteSectionTeacherForm,
  RemoveSectionButton,
  RemoveSectionTeacherButton,
  RemoveStudentButton,
  RenameSectionForm,
  SectionTeacherForm,
} from "@/app/dashboard/college/college-controls";
import {
  LINK_PRIMARY,
  LINK_SECONDARY,
  Notice,
  SECTION_TONE,
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
  params: Promise<{ departmentId: string; semesterId: string; courseId: string; sectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * One course section in its session: its teacher and its students.
 *
 * Students are added here — a new one with the college's usual Add student
 * form, or existing ones by student ID — and taken out again; their
 * attendance in the section is kept either way. Face enrolment and a
 * student's login are on the student's own record, reached from here by
 * whoever may open it.
 */
export default async function CourseSectionPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId, semesterId, courseId, sectionId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const trailBase = isAdmin ? [{ label: "Departments", href: "/dashboard/college/departments" }] : [];

  const result = await readOrDeny(() =>
    getCourseSectionDetail(user, { departmentId, semesterId, courseId, sectionId }),
  );
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[...trailBase, { label: "Section" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const detail = result.value;
  if (!detail) notFound();

  const { department, semester, course, session, section, students, teachers, removal } = detail;
  const ids = { departmentId: department.id, semesterId: semester.id, courseId: course.id, sectionId: section.id };
  const here = sectionHref(department.id, semester.id, course.id, section.id);
  const courseLink = courseHref(department.id, semester.id, course.id);
  const sessionList = [session];
  const editable = session.isActive;
  const canOpenRecord = hasPermission(user, "student.read");
  const canEnrollFace = hasPermission(user, "faceEmbedding.manage");
  const canTakeAttendance =
    hasPermission(user, "attendanceSession.create") &&
    (hasPermission(user, "cohort.manage") || section.teacher?.userId === user.userId);
  const added = first(query.added);
  const removedStudent = first(query.removedStudent);
  const teacherRemoved = first(query.teacherRemoved);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail
        items={[
          ...trailBase,
          { label: department.name, href: withSession(departmentHref(department.id), session, sessionList) },
          { label: semester.name, href: withSession(semesterHref(department.id, semester.id), session, sessionList) },
          { label: courseTitle(course), href: `${courseLink}?session=${encodeURIComponent(session.id)}` },
          { label: section.label },
        ]}
      />
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-neutral-900">
            {courseTitle(course)} — {section.label}
          </h1>
          <Badge tone={SECTION_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
        </div>
        <p className="text-sm text-neutral-500">
          {department.name} · {semester.name} · Academic session {session.name} · Registers show it as{" "}
          <span className="font-mono">{section.groupName}</span>
        </p>
      </header>

      {added ? <Notice>{added} was added to this section.</Notice> : null}
      {teacherRemoved ? <Notice>{teacherRemoved} no longer teaches this section.</Notice> : null}
      {removedStudent ? (
        <Notice>{removedStudent} was taken out of this section. Their attendance in it is kept.</Notice>
      ) : null}
      {!editable ? (
        <Notice tone="info">{session.name} is archived, so this section is shown as it was and can&apos;t be changed.</Notice>
      ) : null}

      <Panel title="Teacher" description="Takes this section's attendance and sees its students.">
        <div className="flex flex-col gap-4">
          {section.teacher ? (
            <p className="text-sm text-neutral-900">
              <span className="font-medium">{section.teacher.name}</span>
              {!section.teacher.active ? (
                <span className="ml-2">
                  <Badge tone="danger">Can&apos;t sign in</Badge>
                </span>
              ) : null}
            </p>
          ) : (
            <EmptyState>No teacher yet. Attendance can&apos;t be taken until one is assigned.</EmptyState>
          )}
          {canTakeAttendance ? (
            <div>
              <Link href={`/dashboard/attendance/${encodeURIComponent(section.id)}`} className={LINK_SECONDARY}>
                Open attendance for {section.groupName}
              </Link>
            </div>
          ) : null}
          {editable ? (
            <>
              <SectionTeacherForm ids={ids} teachers={teachers} currentId={section.teacher?.userId ?? null} />
              {section.teacher ? <RemoveSectionTeacherButton ids={ids} /> : null}
              {isAdmin ? (
                <details className="rounded-md border border-neutral-200 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-neutral-900">
                    Or create a new teacher&apos;s account for this section
                  </summary>
                  <div className="mt-3">
                    <InviteSectionTeacherForm ids={ids} />
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      </Panel>

      <Panel
        title={`Students (${students.length})`}
        description="Everyone currently in this section. A student can also be in sections of other courses."
      >
        {students.length === 0 ? (
          <EmptyState>No students in this section yet.{editable ? " Add them below." : ""}</EmptyState>
        ) : (
          <>
            <ul className="flex flex-col gap-3 md:hidden">
              {students.map((student) => (
                <li key={student.studentId} className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-neutral-900">
                      {student.firstName} {student.lastName}
                    </span>
                    <span className="font-mono text-xs text-neutral-500">{student.studentCode}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {student.faceEnrolled ? <Badge tone="positive">Face on file</Badge> : <Badge tone="warning">No face yet</Badge>}
                    {student.hasLogin ? <Badge tone="info">Has login</Badge> : <Badge tone="neutral">No login</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canOpenRecord ? (
                      <Link href={withReturnPath(`/dashboard/students/${student.studentId}`, here)} className={LINK_SECONDARY}>
                        View
                      </Link>
                    ) : null}
                    {canEnrollFace ? (
                      <Link
                        href={withReturnPath(`/dashboard/students/${student.studentId}/enroll-face`, here)}
                        className={LINK_SECONDARY}
                      >
                        Enroll face
                      </Link>
                    ) : null}
                  </div>
                  {editable ? (
                    <RemoveStudentButton ids={ids} studentId={student.studentId} name={`${student.firstName} ${student.lastName}`} />
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Student ID</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Face</th>
                    <th className="py-2 pr-4 font-medium">Login</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.studentId} className="border-b border-neutral-100 align-top text-sm">
                      <td className="py-3 pr-4 font-mono text-neutral-700">{student.studentCode}</td>
                      <td className="py-3 pr-4 font-medium text-neutral-900">
                        {student.firstName} {student.lastName}
                      </td>
                      <td className="py-3 pr-4">
                        {student.faceEnrolled ? <Badge tone="positive">On file</Badge> : <Badge tone="warning">Not yet</Badge>}
                      </td>
                      <td className="py-3 pr-4">
                        {student.hasLogin ? <Badge tone="info">Yes</Badge> : <Badge tone="neutral">No</Badge>}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap items-start justify-end gap-2">
                          {canOpenRecord ? (
                            <Link
                              href={withReturnPath(`/dashboard/students/${student.studentId}`, here)}
                              className={LINK_SECONDARY}
                              aria-label={`View ${student.firstName} ${student.lastName}`}
                            >
                              View
                            </Link>
                          ) : null}
                          {canEnrollFace ? (
                            <Link
                              href={withReturnPath(`/dashboard/students/${student.studentId}/enroll-face`, here)}
                              className={LINK_SECONDARY}
                              aria-label={`Enroll face for ${student.firstName} ${student.lastName}`}
                            >
                              Enroll face
                            </Link>
                          ) : null}
                          {editable ? (
                            <RemoveStudentButton
                              ids={ids}
                              studentId={student.studentId}
                              name={`${student.firstName} ${student.lastName}`}
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!canOpenRecord ? (
          <p className="text-xs text-neutral-500">
            Face enrolment and student logins are managed by the college administrator from each student&apos;s record.
          </p>
        ) : null}
      </Panel>

      {editable ? (
        <Panel title="Add students" description="Admit a new student into this section, or add students who are already on the system.">
          <div className="flex flex-col gap-5">
            <div>
              <Link href={`${here}/students/new`} className={LINK_PRIMARY}>
                Add a new student
              </Link>
            </div>
            <div className="border-t border-neutral-200 pt-4">
              <h3 className="mb-3 text-sm font-semibold text-neutral-900">Add existing students by student ID</h3>
              <AddStudentsByIdForm ids={ids} suggestions={detail.departmentStudents} />
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel title="Section settings">
        <div className="flex flex-col gap-5">
          {editable ? <RenameSectionForm ids={ids} name={section.name} /> : null}
          {removal.allowed ? (
            <RemoveSectionButton ids={ids} />
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-neutral-900">This section can&apos;t be removed</p>
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-neutral-600">
                {removal.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
