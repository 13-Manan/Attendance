import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { sectionFullName } from "@/modules/college-setup/policy";
import { getDepartmentStudent } from "@/modules/college-setup/service";
import { STUDENT_LOGIN_LABEL, type StudentLoginState } from "@/modules/college-setup/types";
import { STUDENT_STATUS_LABEL } from "@/modules/students/directory-types";
import { parseReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { RemovePlacementButton, StudentSectionForm } from "@/app/dashboard/college/college-controls";
import {
  LINK_PRIMARY,
  LINK_SECONDARY,
  MOMENT_FORMAT,
  Notice,
  departmentHref,
  departmentPeopleHref,
  departmentTrail,
  first,
  readOrDeny,
  sectionHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const LOGIN_TONE: Record<StudentLoginState, BadgeTone> = { none: "neutral", enabled: "info", disabled: "danger" };

/** A section page a student was opened from, which the way back can lead to. */
const SECTION_ORIGIN =
  "/dashboard/college/departments/[departmentId]/semesters/[semesterId]/courses/[courseId]/sections/[sectionId]";

/**
 * One of the department's students: who they are, the department's course
 * sections they are in this session and who teaches each, their face and
 * their sign-in — with adding them to another section, taking them out of
 * one, and enrolling their face, each through the service every other screen
 * uses. Only a student in one of this department's sections can be opened.
 */
export default async function DepartmentStudentPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId, studentId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() => getDepartmentStudent(user, departmentId, studentId, first(query.session)));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-5">
        <PageTrail items={[{ label: "Students" }, { label: "Student" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const detail = result.value;
  if (!detail) notFound();

  const { department, session, student, placements, face, login, sectionChoices } = detail;
  const name = `${student.firstName} ${student.lastName}`.trim();
  const here = departmentPeopleHref(department.id, "students", student.studentId);
  const editable = Boolean(session?.isActive);
  const canOpenRecord = hasPermission(user, "student.read");

  // Opened from one of the department's section pages: the way back leads there, named in full.
  const origin = parseReturnPath(first(query.returnTo), [SECTION_ORIGIN]);
  const originSection =
    origin && origin.params.departmentId === department.id
      ? sectionChoices.find((choice) => choice.sectionId === origin.params.sectionId)
      : undefined;
  const trail = departmentTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    list: { label: "Students", href: departmentPeopleHref(department.id, "students") },
    leaf: { label: name },
  });
  const back = originSection
    ? {
        label: sectionFullName(originSection.course.name, originSection.label),
        href: sectionHref(department.id, originSection.semester.id, originSection.course.id, originSection.sectionId),
      }
    : trail.back;

  const named = (sectionId: string | undefined) => {
    const choice = sectionChoices.find((candidate) => candidate.sectionId === sectionId);
    return choice ? sectionFullName(choice.course.name, choice.label) : null;
  };
  const created = first(query.created) === "1";
  const added = named(first(query.added));
  const moved = named(first(query.moved));
  const removed = first(query.removed);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail items={trail.items} back={back} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <header className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-neutral-900">{name}</h1>
            <Badge tone={student.status === "ACTIVE" ? "positive" : "neutral"}>{STUDENT_STATUS_LABEL[student.status]}</Badge>
          </div>
          <p className="text-sm text-neutral-500">
            Student ID <span className="font-mono text-neutral-900">{student.studentCode}</span>
            {student.admissionNumber ? ` · Admission no. ${student.admissionNumber}` : ""}
          </p>
        </header>
        <div className="flex flex-wrap gap-2">
          {face.canEnroll ? (
            <Link href={`${here}/enroll-face`} className={face.enrolled ? LINK_SECONDARY : LINK_PRIMARY}>
              {face.enrolled ? "Add face samples" : "Enroll face"}
            </Link>
          ) : null}
          {canOpenRecord ? (
            <Link href={`/dashboard/students/${encodeURIComponent(student.studentId)}`} className={LINK_SECONDARY}>
              Open full record
            </Link>
          ) : null}
        </div>
      </div>

      {created ? (
        <Notice>
          {name} was added to the college{placements[0] ? ` and to ${sectionFullName(placements[0].course.name, placements[0].label)}` : ""}.
          Next: enroll their face, and add them to their other courses below.
        </Notice>
      ) : null}
      {added ? <Notice>Added to {added}.</Notice> : null}
      {moved ? <Notice>Moved to {moved}. Their attendance in the section they left is kept.</Notice> : null}
      {removed ? (
        <Notice>
          Taken out of {removed}. Their student record, face enrolment, login, attendance history and other courses are
          kept.
        </Notice>
      ) : null}

      <Panel title="Student information">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          {[
            ["Name", name],
            ["Student ID", student.studentCode],
            ["Admission number", student.admissionNumber],
            ["Email", student.email],
            ["Phone", student.phone],
            ["Status", STUDENT_STATUS_LABEL[student.status]],
          ].map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
              <dd className="break-words text-neutral-900">{value || <span className="text-neutral-400">Not recorded</span>}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel
        title={`Courses in ${department.name}${session ? ` · ${session.name}` : ""} (${placements.length})`}
        description="Their sections of this department. A student can be in sections of several courses."
      >
        {placements.length === 0 ? (
          <EmptyState>
            <span className="flex flex-col items-center gap-3">
              No section assigned{session ? ` in ${session.name}` : ""}.
              {editable && student.status === "ACTIVE" ? (
                <Link href="#add-section" className={LINK_PRIMARY}>
                  Add to section
                </Link>
              ) : null}
            </span>
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {placements.map((placement) => {
              const sectionName = sectionFullName(placement.course.name, placement.label);
              return (
                <li key={placement.sectionId} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Link
                      href={sectionHref(department.id, placement.semester.id, placement.course.id, placement.sectionId)}
                      className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                    >
                      {sectionName}
                    </Link>
                    <span className="text-xs text-neutral-500">
                      {placement.semester.name} · <span className="font-mono">{placement.groupName}</span> ·{" "}
                      {placement.teacher ? `Teacher ${placement.teacher.name}` : "Needs a teacher"}
                    </span>
                  </div>
                  {editable ? (
                    <RemovePlacementButton
                      departmentId={department.id}
                      studentId={student.studentId}
                      sectionId={placement.sectionId}
                      studentName={name}
                      sectionName={sectionName}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {editable ? (
        <section id="add-section" className="scroll-mt-4">
          <Panel
            title="Add to a course section"
            description={`One of ${department.name}'s sections this session. Their other sections stay as they are.`}
          >
            {student.status === "ACTIVE" ? (
              <StudentSectionForm
                departmentId={department.id}
                studentId={student.studentId}
                studentName={name}
                choices={sectionChoices}
              />
            ) : (
              <p className="text-sm text-neutral-600">
                {STUDENT_STATUS_LABEL[student.status]} — not on roll, so they can&apos;t be added to a section.
              </p>
            )}
          </Panel>
        </section>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <Panel title="Face" description="Recognition in their registers needs a face on file.">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {face.enrolled ? <Badge tone="positive">Enrolled</Badge> : <Badge tone="warning">Not enrolled</Badge>}
              {face.activeSamples > 0 ? (
                <span className="text-neutral-600">
                  {face.activeSamples} {face.activeSamples === 1 ? "sample" : "samples"} in use
                  {face.lastEnrolledAt ? ` · last added ${MOMENT_FORMAT.format(face.lastEnrolledAt)}` : ""}
                </span>
              ) : null}
            </div>
            <p className="text-neutral-600">
              {!face.canEnroll
                ? "Their face can be enrolled from here while they are in one of the department's sections in a current session."
                : face.enrolled
                  ? "Their registers can recognise them. Add samples from another angle if recognition misses them."
                  : "No face enrolled yet — enroll one so their registers can recognise them."}
            </p>
            {face.enrolled || !face.canEnroll ? null : (
              <div>
                <Link href={`${here}/enroll-face`} className={LINK_PRIMARY}>
                  Enroll face
                </Link>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Sign-in" description="Students sign in with their student ID on the college's student link.">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={LOGIN_TONE[login.state]}>{STUDENT_LOGIN_LABEL[login.state]}</Badge>
              {login.state !== "none" ? (
                <span className="text-neutral-600">
                  Signs in as <span className="font-mono text-neutral-900">{login.loginId}</span>
                </span>
              ) : null}
            </div>
            {canOpenRecord && hasPermission(user, "user.invite") ? (
              <div>
                <Link href={`/dashboard/students/${encodeURIComponent(student.studentId)}`} className={LINK_SECONDARY}>
                  Manage sign-in on their record
                </Link>
              </div>
            ) : (
              <p className="text-neutral-600">Student sign-ins are created and reset by the college administrator.</p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
