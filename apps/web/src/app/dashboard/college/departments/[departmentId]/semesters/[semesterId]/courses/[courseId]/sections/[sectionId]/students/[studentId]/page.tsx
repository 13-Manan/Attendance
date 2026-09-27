import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { sectionFullName } from "@/modules/college-setup/policy";
import { getSectionStudent } from "@/modules/college-setup/service";
import { STUDENT_STATUS_LABEL } from "@/modules/students/directory-types";
import { withReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  COURSES_PATH,
  LINK_PRIMARY,
  LINK_SECONDARY,
  courseHref,
  courseTrail,
  departmentHref,
  readOrDeny,
  sectionHref,
  semesterHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{
    departmentId: string;
    semesterId: string;
    courseId: string;
    sectionId: string;
    studentId: string;
  }>;
}

/**
 * One student of a course section, as the section sees them: who they are,
 * which of this department's sections they are in this session, and whether
 * a face and a sign-in are on file.
 *
 * The student's full record — face enrolment, their sign-in, their details —
 * belongs to whoever may open it, and is linked from here for them. A head of
 * department, who may not, is told who does it rather than being given a way
 * round it: this page grants nothing the record's own checks would refuse.
 * It shows a student only while they are in this section.
 */
export default async function SectionStudentPage({ params }: PageProps) {
  const user = await requireUser();
  const { studentId, ...ids } = await params;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() => getSectionStudent(user, ids, studentId));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <PageTrail items={[isAdmin ? { label: "Departments", href: "/dashboard/college/departments" } : { label: "Courses", href: COURSES_PATH }, { label: "Student" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();

  const { placement, student, sections, selfEnrollment } = view;
  const { department, semester, course, section } = placement;
  const sectionPage = sectionHref(department.id, semester.id, course.id, section.id);
  const name = `${student.firstName} ${student.lastName}`.trim();
  const canOpenRecord = hasPermission(user, "student.read");
  const canEnrollFace = hasPermission(user, "faceEmbedding.manage");
  const canManageLogin = hasPermission(user, "user.invite");
  const record = `/dashboard/students/${encodeURIComponent(student.studentId)}`;
  const trail = courseTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    semester: { name: semester.name, href: semesterHref(department.id, semester.id) },
    course: { name: course.name, code: course.code, href: courseHref(department.id, semester.id, course.id) },
    section: { label: section.label, href: sectionPage },
    leaf: name,
  });

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-neutral-900">{name}</h1>
          <Badge tone={student.status === "ACTIVE" ? "positive" : "neutral"}>{STUDENT_STATUS_LABEL[student.status]}</Badge>
        </div>
        <p className="text-sm text-neutral-500">
          Student ID <span className="font-mono text-neutral-900">{student.studentCode}</span>
          {student.admissionNumber ? (
            <>
              {" · "}Admission no. <span className="text-neutral-900">{student.admissionNumber}</span>
            </>
          ) : null}
        </p>
      </header>

      <dl className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-2 sm:p-5">
        <div className="flex flex-col gap-1">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Face enrolment</dt>
          <dd>
            {student.faceEnrolled ? <Badge tone="positive">Enrolled</Badge> : <Badge tone="warning">Not enrolled</Badge>}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Student sign-in</dt>
          <dd>{student.hasLogin ? <Badge tone="info">Has a login</Badge> : <Badge tone="neutral">No login yet</Badge>}</dd>
        </div>
      </dl>

      <Panel
        title={`Courses in ${department.name} (${sections.length})`}
        description="Their sections this session. A student can be in several courses' sections at once."
      >
        <ul className="flex flex-col divide-y divide-neutral-100">
          {sections.map((row) => (
            <li key={row.sectionId} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  href={sectionHref(department.id, row.semesterId, row.course.id, row.sectionId)}
                  className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                >
                  {sectionFullName(row.course.name, row.label)}
                </Link>
                <span className="text-xs text-neutral-500">
                  <span className="font-mono">{row.groupName}</span> · {row.teacherName ? `Teacher ${row.teacherName}` : "Needs teacher"}
                </span>
              </div>
              {row.sectionId === section.id ? <Badge tone="info">This section</Badge> : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Face enrolment and sign-in" description="Recognition in this section's registers needs a face on file.">
        <div className="flex flex-col gap-3 text-sm text-neutral-700">
          {canOpenRecord || canEnrollFace ? (
            <div className="flex flex-wrap gap-2">
              {canEnrollFace ? (
                <Link href={withReturnPath(`${record}/enroll-face`, sectionPage)} className={LINK_PRIMARY}>
                  {student.faceEnrolled ? "Add face samples" : "Enroll face"}
                </Link>
              ) : null}
              {canOpenRecord ? (
                <Link href={withReturnPath(record, sectionPage)} className={LINK_SECONDARY}>
                  Open full record
                </Link>
              ) : null}
            </div>
          ) : null}
          {!canEnrollFace ? (
            <p>
              {student.faceEnrolled
                ? "A face is on file, so the section's registers can recognise them."
                : "No face is on file yet, so registers can't recognise them."}{" "}
              Faces are enrolled by the college administrator from the student&apos;s record
              {selfEnrollment ? ", or by the student from their own portal once they can sign in" : ""}.
            </p>
          ) : null}
          {!canManageLogin ? (
            <p>
              {student.hasLogin ? "They can sign in to see their attendance." : "They can't sign in yet."} Student sign-ins
              are created and reset by the college administrator.
            </p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
