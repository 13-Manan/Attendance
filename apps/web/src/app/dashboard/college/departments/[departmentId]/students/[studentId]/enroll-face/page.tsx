import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentStudentFace } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState, Panel } from "@/components/ui/panel";
import { EnrollmentNotices, SampleHistory } from "@/app/dashboard/students/[studentId]/enroll-face/enrollment-parts";
import {
  departmentHref,
  departmentPeopleHref,
  departmentTrail,
  readOrDeny,
} from "@/app/dashboard/college/shared";
import { DepartmentEnrollmentClient } from "./department-enrollment-client";

interface PageProps {
  params: Promise<{ departmentId: string; studentId: string }>;
}

/**
 * Face enrollment for one of a college department's students, from the
 * department — the administrator's enrollment screen, reached for this
 * department's students only.
 *
 * The same capture component, the same notices about the running model, the
 * same sample history, and underneath them the same enrollment service: its
 * quality gate, its duplicate and lookalike checks, its sample limit and its
 * audit rows all run exactly as they do from the Students screen. What is
 * different is only who may open it: the student must be in one of this
 * department's sections, which the server checks on this page and again on
 * every capture sent from it. Erasing a student's biometric data outright stays
 * on the administrator's screen.
 *
 * Nothing on this page is biometric: every column is metadata.
 */
export default async function DepartmentEnrollFacePage({ params }: PageProps) {
  const user = await requireUser();
  const { departmentId, studentId } = await params;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() => getDepartmentStudentFace(user, departmentId, studentId));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Students" }, { label: "Face enrollment" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();
  const { department, student, status, samples, runningModel } = view;
  const name = `${student.firstName} ${student.lastName}`.trim();
  const trail = departmentTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    list: { label: "Students", href: departmentPeopleHref(department.id, "students") },
    leaf: { label: name, href: departmentPeopleHref(department.id, "students", student.studentId) },
    subleaf: "Face enrollment",
  });

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />

      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Face enrollment · {name}</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Student code {student.studentCode}. A capture is turned into a protected biometric template; the photograph
          itself is not stored. Recognition is an assistant — a teacher always has the final say over a register.
        </p>
      </header>

      <EnrollmentNotices runningModel={runningModel} />

      <Panel
        title="Capture"
        description="Camera or an uploaded photograph. Both are checked for quality, and both are compared against this institution's existing templates before anything is stored."
      >
        <DepartmentEnrollmentClient departmentId={department.id} studentId={student.studentId} initialStatus={status} />
      </Panel>

      <SampleHistory
        status={status}
        samples={samples}
        erasure="Erasing the biometric data outright is the college administrator's decision, on the student's record."
      />
    </div>
  );
}
