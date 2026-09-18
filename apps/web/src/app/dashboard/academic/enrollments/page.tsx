import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listCohortsForInstitutionRequest } from "@/modules/cohorts/service";
import { listStudentsByInstitution } from "@/modules/students/repository";
import { studentDisplayName } from "@/modules/students/types";
import { EnrollForm } from "./enroll-form";

export default async function EnrollmentsPage() {
  const user = await requirePermissionOrRedirect("enrollment.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }

  const [cohorts, students] = await Promise.all([
    listCohortsForInstitutionRequest(user, user.institutionId),
    listStudentsByInstitution(user.institutionId),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-neutral-900">Enroll students into a cohort</h2>
      <p className="text-xs text-neutral-500">
        Enrollments determine which students the face-recognition pipeline scans for in each attendance session —
        a student is never searched globally, only within cohorts they are enrolled in.
      </p>
      <EnrollForm
        cohorts={cohorts.map((c) => ({ id: c.id, label: c.name }))}
        students={students.map((s) => ({ id: s.id, label: `${studentDisplayName(s)} (${s.studentCode})` }))}
      />
    </div>
  );
}
