import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { requireSameInstitution } from "@/modules/authorization/service";
import { getCohortById } from "@/modules/cohorts/repository";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import { CaptureWizard } from "./capture-client";

interface PageProps {
  params: Promise<{ cohortId: string }>;
  searchParams: Promise<{ subject?: string }>;
}

/**
 * Server shell for the Phase 4 capture wizard.
 *
 * The heavy interactive work — camera, previews, per-image analysis,
 * progress UI — is in `CaptureWizard` (client). This shell exists to run
 * the server-side authorization checks up front so the client only ever
 * renders for a caller who is genuinely allowed to capture attendance for
 * this cohort.
 */
export default async function AttendanceCapturePage({ params, searchParams }: PageProps) {
  const { cohortId } = await params;
  const { subject: cohortSubjectId } = await searchParams;

  const user = await requirePermissionOrRedirect("attendanceSession.capture");
  const cohort = await getCohortById(cohortId);
  if (!cohort) redirect("/dashboard/attendance");
  requireSameInstitution(user, cohort.institutionId);
  await requireCohortAccess(user, cohort.id);

  const institution = await getInstitutionById(cohort.institutionId);
  if (!institution) redirect("/dashboard/attendance");
  const mode = resolveAttendanceMode(institution);

  // Guard the SUBJECT_WISE branch: a college caller must have arrived
  // through the subject picker; without a subject we send them back so they
  // pick one, rather than letting them start a session with no subject.
  if (mode === "SUBJECT_WISE" && !cohortSubjectId) {
    redirect(`/dashboard/attendance/${cohort.id}`);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link
          href={`/dashboard/attendance/${cohort.id}`}
          className="text-xs text-neutral-500 hover:underline"
        >
          ← Back to class
        </Link>
        <h1 className="text-xl font-semibold text-neutral-900">{cohort.name}</h1>
      </div>
      <CaptureWizard
        cohortId={cohort.id}
        cohortSubjectId={cohortSubjectId ?? null}
        attendanceMode={mode}
      />
    </div>
  );
}
