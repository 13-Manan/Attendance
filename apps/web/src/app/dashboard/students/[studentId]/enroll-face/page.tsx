import { notFound } from "next/navigation";
import { requireAnyPermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getStudentById } from "@/modules/students/repository";
import { studentOriginPath } from "@/modules/students/record-origin";
import { studentDisplayName } from "@/modules/students/types";
import { getStudentFaceEnrollment } from "@/modules/face-enrollment/service";
import { canReviewTwinConfirmations } from "@/modules/twin-confirmation/service";
import { RETURN_PARAM, withReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Panel } from "@/components/ui/panel";
import { StaffEnrollmentClient } from "./staff-enrollment-client";
import { DeleteFaceData } from "./delete-face-data";
import { EnrollmentNotices, SampleHistory } from "./enrollment-parts";

/**
 * One student's face enrollment, from a member of staff's desk.
 *
 * Gated on `faceEmbedding.manage` *and* on the student belonging to this
 * actor's institution. Both, not either: an administrator who legitimately
 * manages biometrics at one institution must still be refused a student at
 * another, and a permission check alone would let them through.
 *
 * ## Why the history shows retired samples
 *
 * Their absence is the thing worth seeing. "Enrolled in September, withdrawn in
 * November by A. Deshpande" and "never enrolled" produce the same empty list of
 * active templates and mean completely different things — the first is a
 * decision somebody made and may need to explain.
 *
 * Nothing on this page is biometric. Every column is metadata: when, which
 * model, how it was captured, who acted. The vector cannot appear here even by
 * mistake, because the repository that feeds it selects field by field and
 * Prisma cannot type the column it would have to name.
 */

export default async function StaffEnrollFacePage({
  params,
  searchParams,
}: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Enrolment itself is open to faceEmbedding.enroll (a receptionist); erasure below is not.
  const user = await requireAnyPermissionOrRedirect("faceEmbedding.manage", "faceEmbedding.enroll");
  const { studentId } = await params;
  // Opened from a section, the way back to the record keeps the way back there.
  const origin = studentOriginPath((await searchParams)[RETURN_PARAM]);
  const student = await getStudentById(studentId);
  if (!student) notFound();
  try {
    requireSameInstitution(user, student.institutionId);
  } catch (error) {
    // Another institution's student is "not found", as on the student's own
    // page — an id from elsewhere learns nothing, not even that it exists.
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }

  const { status, samples, runningModel } = await getStudentFaceEnrollment(user, student.id);
  // Enrolling faces does not carry twin decisions: without them, a refused
  // lookalike says who to ask instead of linking to a review that would refuse.
  const canReviewTwins = await canReviewTwinConfirmations(user);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Students", href: "/dashboard/students" },
          {
            label: studentDisplayName(student),
            href: withReturnPath(`/dashboard/students/${student.id}`, origin),
          },
          { label: "Face enrollment" },
        ]}
      />

      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          Face enrollment · {studentDisplayName(student)}
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Student code {student.studentCode}. A capture is turned into a protected biometric
          template; the photograph itself is not stored. Recognition is an assistant — a teacher
          always has the final say over a register.
        </p>
      </header>

      <EnrollmentNotices runningModel={runningModel} />

      <Panel
        title="Capture"
        description="Camera or an uploaded photograph. Both are checked for quality, and both are compared against this institution's existing templates before anything is stored."
      >
        <StaffEnrollmentClient studentId={student.id} initialStatus={status} canReviewTwins={canReviewTwins} />
      </Panel>

      <SampleHistory status={status} samples={samples} />

      {/* Shown with `faceEmbedding.manage` only — the same permission the
          erasure service requires — so the administrator who receives an
          erasure request can act on it here rather than asking somebody with
          database access. A receptionist who may enrol may not erase. */}
      {hasPermission(user, "faceEmbedding.manage") ? (
        <DeleteFaceData studentId={student.id} studentCode={student.studentCode} />
      ) : null}
    </div>
  );
}
