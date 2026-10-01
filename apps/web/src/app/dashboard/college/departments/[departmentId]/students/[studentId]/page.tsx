import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { sectionFullName } from "@/modules/college-setup/policy";
import { getDepartmentStudent } from "@/modules/college-setup/service";
import { STUDENT_STATUS_LABEL } from "@/modules/students/directory-types";
import { runningFaceModel, verificationOf } from "@/modules/students/verification-service";
import { VerificationChecklist } from "@/components/students/verification";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveSelfEnrollmentEnabled } from "@/modules/face-enrollment/policy";
import { parseReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { RemovePlacementButton, StudentSectionForm } from "@/app/dashboard/college/college-controls";
import { StudentAccountPanel } from "@/app/dashboard/college/student-account";
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

/** A section page a student was opened from, which the way back can lead to. */
const SECTION_ORIGIN =
  "/dashboard/college/departments/[departmentId]/semesters/[semesterId]/courses/[courseId]/sections/[sectionId]";

/**
 * One of the department's students: who they are, the department's course
 * sections they are in this session and who teaches each, their face and
 * their Student Portal account — with adding them to another section, taking
 * them out of one, enrolling their face, and a new temporary password or a
 * login, each through the service every other screen uses. Only a student in
 * one of this department's sections can be opened. No password is ever read
 * here: there is none to read.
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
  // Is this student fully set up? Computed from their records; nothing is
  // stored. The student was resolved through the department's scope above.
  const [verification, institution] = await Promise.all([
    verificationOf(user.institutionId ?? "", student.studentId, await runningFaceModel()),
    getInstitutionById(user.institutionId ?? ""),
  ]);
  const selfEnrollment = institution ? resolveSelfEnrollmentEnabled(institution) : false;
  const faceBlocked =
    verification?.face === "blocked_pending_review" || verification?.face === "blocked_not_confirmed";
  const twinHref = departmentPeopleHref(department.id, "students", "twin-confirmations");

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
          {name} was added to the college{placements[0] ? ` and to ${sectionFullName(placements[0].course.name, placements[0].label)}` : ""}
          {login.state !== "none" ? ", with a Student Portal account" : ""}. Next: enroll their face, and add them to their
          other courses below.
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

      {verification ? (
        <Panel title="Verification" description="Whether this student is fully set up: an account, their details and their face.">
          <VerificationChecklist
            verification={verification}
            actions={
              verification.overall === "incomplete" && verification.face !== "enrolled" ? (
                faceBlocked ? (
                  <Link href={twinHref} className={LINK_PRIMARY}>
                    Review twin/lookalike confirmation
                  </Link>
                ) : face.canEnroll ? (
                  <>
                    <Link href={`${here}/enroll-face`} className={LINK_PRIMARY}>
                      Enroll face
                    </Link>
                    {login.state === "enabled" && selfEnrollment ? (
                      <span className="text-xs text-neutral-500">
                        The student can also enroll their own face from the Student Portal.
                      </span>
                    ) : null}
                  </>
                ) : null
              ) : null
            }
          />
        </Panel>
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

        <Panel
          title="Student Portal account"
          description="How they sign in to see their own attendance: with the email below, or their student ID on the college's student link."
        >
          <StudentAccountPanel
            departmentId={department.id}
            studentId={student.studentId}
            studentName={name}
            recordEmail={student.email}
            onRoll={student.status === "ACTIVE"}
            account={{
              state: login.state,
              loginId: login.loginId,
              email: login.email,
              mustChangePassword: login.mustChangePassword,
              lastPasswordChange: login.lastPasswordChange
                ? { at: MOMENT_FORMAT.format(login.lastPasswordChange.at), by: login.lastPasswordChange.by }
                : null,
              lastLoginAt: login.lastLoginAt ? MOMENT_FORMAT.format(login.lastLoginAt) : null,
              passwordRecoverable: login.passwordRecoverable,
              canManage: login.canManage,
            }}
            recordHref={
              canOpenRecord && hasPermission(user, "user.invite")
                ? `/dashboard/students/${encodeURIComponent(student.studentId)}`
                : null
            }
          />
        </Panel>
      </div>
    </div>
  );
}
