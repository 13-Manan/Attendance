import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { sectionFullName, studentMatchesSearch } from "@/modules/college-setup/policy";
import { getCourseSectionDetail } from "@/modules/college-setup/service";
import { SECTION_STATUS_LABEL, type SectionStudent } from "@/modules/college-setup/types";
import { STUDENT_STATUS_LABEL } from "@/modules/students/directory-types";
import { withReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  RemoveSectionButton,
  RemoveStudentButton,
  RenameSectionForm,
  TeacherEditor,
} from "@/app/dashboard/college/college-controls";
import {
  COURSES_PATH,
  LINK_PRIMARY,
  LINK_SECONDARY,
  Notice,
  SECTION_TONE,
  courseHref,
  courseTrail,
  departmentHref,
  departmentPeopleHref,
  first,
  readOrDeny,
  sectionHref,
  sectionStudentsHref,
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
 * "+ Add student" finds an existing student of the college or admits a new
 * one; each student's View opens their record — the college's own for whoever
 * may open it, otherwise this section's page for them — where face enrolment
 * and sign-in are reached by whoever may manage them. Taking a student out
 * ends only their place here: the student, their face, their other courses
 * and every register they are on are kept.
 */
export default async function CourseSectionPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId, semesterId, courseId, sectionId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() =>
    getCourseSectionDetail(user, { departmentId, semesterId, courseId, sectionId }),
  );
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[isAdmin ? { label: "Departments", href: "/dashboard/college/departments" } : { label: "Courses", href: COURSES_PATH }, { label: "Section" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const detail = result.value;
  if (!detail) notFound();

  const { department, semester, course, session, section, students, teachers, removal } = detail;
  const ids = { departmentId: department.id, semesterId: semester.id, courseId: course.id, sectionId: section.id };
  const here = sectionHref(department.id, semester.id, course.id, section.id);
  const sessionList = [session];
  const editable = session.isActive;
  const fullName = sectionFullName(course.name, section.label);
  const canOpenRecord = hasPermission(user, "student.read");
  // An administrator enrols from the Students screen; a head of department from
  // their department's own student page, which checks the student is theirs —
  // and is in one of its sections in a session that is still open.
  const adminEnrollsFace = hasPermission(user, "faceEmbedding.manage");
  const canEnrollFace = adminEnrollsFace || (!isAdmin && editable);
  const canTakeAttendance =
    hasPermission(user, "attendanceSession.create") &&
    (hasPermission(user, "cohort.manage") || section.teacher?.userId === user.userId);
  const trail = courseTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: withSession(departmentHref(department.id), session, sessionList) },
    semester: { name: semester.name, href: withSession(semesterHref(department.id, semester.id), session, sessionList) },
    course: {
      name: course.name,
      code: course.code,
      href: `${courseHref(department.id, semester.id, course.id)}?session=${encodeURIComponent(session.id)}`,
    },
    section: { label: section.label, href: here },
  });

  // `?added=` names a student by id; it is only ever shown for somebody who is in this list.
  const added = students.find((student) => student.studentId === first(query.added)) ?? null;
  const removedStudent = first(query.removedStudent);
  const teacherRemoved = first(query.teacherRemoved);
  const search = first(query.q)?.trim() ?? "";
  const shown = search ? students.filter((student) => studentMatchesSearch(student, search)) : students;
  const recordHref = (student: SectionStudent) =>
    canOpenRecord
      ? withReturnPath(`/dashboard/students/${encodeURIComponent(student.studentId)}`, here)
      : withReturnPath(departmentPeopleHref(department.id, "students", student.studentId), here);
  const faceHref = (student: SectionStudent) =>
    adminEnrollsFace
      ? withReturnPath(`/dashboard/students/${encodeURIComponent(student.studentId)}/enroll-face`, here)
      : departmentPeopleHref(department.id, "students", student.studentId, "enroll-face");

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-neutral-900">{fullName}</h1>
            <Badge tone={SECTION_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
          </div>
          <p className="text-sm text-neutral-500">
            {semester.name} · {department.name} · Academic session {session.name} · Registers show it as{" "}
            <span className="font-mono">{section.groupName}</span>
          </p>
        </header>
        {editable ? (
          <Link href={sectionStudentsHref(ids, "add")} className={LINK_PRIMARY}>
            + Add student
          </Link>
        ) : null}
      </div>

      {added ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {added.firstName} {added.lastName} was added to {fullName}.{" "}
          <Link href={recordHref(added)} className="font-medium underline">
            View {added.firstName}
          </Link>
          {canEnrollFace && !added.faceEnrolled ? (
            <>
              {" · "}
              <Link href={faceHref(added)} className="font-medium underline">
                Enroll their face
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {teacherRemoved ? <Notice>{teacherRemoved} no longer teaches this section.</Notice> : null}
      {removedStudent ? (
        <Notice>
          {removedStudent} was taken out of this section. Their record, face enrolment, other courses and attendance here
          are all kept.
        </Notice>
      ) : null}
      {!editable ? (
        <Notice tone="info">{session.name} is archived, so this section is shown as it was and can&apos;t be changed.</Notice>
      ) : null}

      <dl className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-2 sm:p-5">
        <div className="flex min-w-0 flex-col gap-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Teacher</dt>
          <dd className="flex flex-col items-start gap-3">
            {section.teacher ? (
              <span className="text-base font-medium text-neutral-900">
                {section.teacher.name}
                {!section.teacher.active ? (
                  <span className="ml-2 align-middle">
                    <Badge tone="danger">Can&apos;t sign in</Badge>
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="flex flex-col gap-1">
                <Badge tone="warning">Needs teacher</Badge>
                <span className="text-neutral-600">Attendance can&apos;t be taken until a teacher is assigned.</span>
              </span>
            )}
            {editable ? (
              <TeacherEditor
                ids={ids}
                teachers={teachers}
                current={section.teacher}
                canInvite={isAdmin && hasPermission(user, "user.invite")}
              />
            ) : null}
          </dd>
        </div>
        <div className="flex flex-col gap-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Students</dt>
          <dd className="flex flex-col items-start gap-3">
            <span className="text-base font-medium tabular-nums text-neutral-900">
              {students.length} {students.length === 1 ? "student" : "students"}
            </span>
            {canTakeAttendance ? (
              <Link href={`/dashboard/attendance/${encodeURIComponent(section.id)}`} className={LINK_SECONDARY}>
                Open attendance for {section.groupName}
              </Link>
            ) : null}
          </dd>
        </div>
      </dl>

      <Panel
        title={`Students (${students.length})`}
        description="Everyone currently in this section. A student can also be in sections of other courses."
      >
        {students.length > 0 ? (
          <form method="get" action={here} role="search" className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-sm">
              <label htmlFor="section-students-q" className="text-xs font-medium text-neutral-500">
                Search students
              </label>
              <Input
                id="section-students-q"
                name="q"
                defaultValue={search}
                placeholder="Name or student ID"
                autoComplete="off"
              />
            </div>
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {search ? (
              <Link href={here} className={LINK_SECONDARY}>
                Clear
              </Link>
            ) : null}
          </form>
        ) : null}

        {students.length === 0 ? (
          <EmptyState>
            <span className="flex flex-col items-center gap-3">
              No students in this section yet.
              {editable ? (
                <Link href={sectionStudentsHref(ids, "add")} className={LINK_PRIMARY}>
                  + Add student
                </Link>
              ) : null}
            </span>
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>Nobody in this section matches “{search}”.</EmptyState>
        ) : (
          <>
            <ul className="flex flex-col gap-3 md:hidden">
              {shown.map((student) => {
                const name = `${student.firstName} ${student.lastName}`.trim();
                return (
                  <li key={student.studentId} className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3">
                    <div className="flex flex-col gap-0.5">
                      <Link href={recordHref(student)} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
                        {name}
                      </Link>
                      <span className="font-mono text-xs text-neutral-500">{student.studentCode}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge tone={student.status === "ACTIVE" ? "positive" : "neutral"}>{STUDENT_STATUS_LABEL[student.status]}</Badge>
                      {student.faceEnrolled ? <Badge tone="positive">Face enrolled</Badge> : <Badge tone="warning">Face not enrolled</Badge>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link href={recordHref(student)} className={LINK_SECONDARY}>
                        View<span className="sr-only"> {name}</span>
                      </Link>
                      {canEnrollFace ? (
                        <Link href={faceHref(student)} className={LINK_SECONDARY}>
                          {student.faceEnrolled ? "Add face samples" : "Enroll face"}
                          <span className="sr-only"> for {name}</span>
                        </Link>
                      ) : null}
                    </div>
                    {editable ? (
                      <RemoveStudentButton ids={ids} studentId={student.studentId} name={name} sectionName={fullName} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="hidden md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Student ID</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Face</th>
                    <th className="py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((student) => {
                    const name = `${student.firstName} ${student.lastName}`.trim();
                    return (
                      <tr key={student.studentId} className="border-b border-neutral-100 align-top text-sm">
                        <td className="py-3 pr-4">
                          <Link href={recordHref(student)} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
                            {name}
                          </Link>
                        </td>
                        <td className="py-3 pr-4 font-mono text-neutral-700">{student.studentCode}</td>
                        <td className="py-3 pr-4">
                          <Badge tone={student.status === "ACTIVE" ? "positive" : "neutral"}>
                            {STUDENT_STATUS_LABEL[student.status]}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4">
                          {student.faceEnrolled ? <Badge tone="positive">Enrolled</Badge> : <Badge tone="warning">Not enrolled</Badge>}
                        </td>
                        <td className="py-3">
                          <div className="flex flex-wrap items-start justify-end gap-2">
                            <Link href={recordHref(student)} className={LINK_SECONDARY}>
                              View<span className="sr-only"> {name}</span>
                            </Link>
                            {canEnrollFace ? (
                              <Link href={faceHref(student)} className={LINK_SECONDARY}>
                                {student.faceEnrolled ? "Add face samples" : "Enroll face"}
                                <span className="sr-only"> for {name}</span>
                              </Link>
                            ) : null}
                            {editable ? (
                              <RemoveStudentButton ids={ids} studentId={student.studentId} name={name} sectionName={fullName} />
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!canOpenRecord ? (
          <p className="text-xs text-neutral-500">
            Student sign-ins are created and reset by the college administrator. View shows where a student stands.
          </p>
        ) : null}
      </Panel>

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

