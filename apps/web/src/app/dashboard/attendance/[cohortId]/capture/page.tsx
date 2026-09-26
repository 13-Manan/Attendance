import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { getCohortById } from "@/modules/cohorts/repository";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import { PageTrail } from "@/components/nav/page-trail";
import { CaptureWizard } from "./capture-client";

interface PageProps {
  params: Promise<{ cohortId: string }>;
  searchParams: Promise<{ subject?: string; add?: string }>;
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
  const { subject: cohortSubjectId, add } = await searchParams;

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

  /**
   * Whether to hand the wizard a fixture camera instead of the real one.
   *
   * Read here, on the server, from a build-time `NEXT_PUBLIC_` flag that no
   * deployment sets — see `.github/workflows/deploy.yml`, which passes no such
   * variable, and `apps/web/Dockerfile`, whose build args do not include it.
   * A production bundle therefore has the literal `false` compiled in and the
   * fixture source is unreachable from it.
   *
   * It exists so the capture flow can be driven end to end in a browser on a
   * machine with no webcam. It proves the wizard, the contracts and the
   * server; it proves nothing whatsoever about a camera.
   */
  const fixtureCamera = process.env.NEXT_PUBLIC_ENABLE_FIXTURE_CAMERA === "true";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <PageTrail
        items={[
          { label: "Attendance", href: "/dashboard/attendance" },
          { label: cohort.name, href: `/dashboard/attendance/${cohort.id}` },
          { label: "Take attendance" },
        ]}
      />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">{cohort.name}</h1>
        <p className="text-sm text-neutral-500">
          {mode === "DAILY" ? "Daily attendance" : "Subject-wise attendance"}
          {cohort.termLabel ? ` · ${cohort.termLabel}` : ""}
        </p>
      </div>
      {fixtureCamera && (
        <p
          role="alert"
          className="rounded-md border border-purple-300 bg-purple-50 px-3 py-2 text-xs text-purple-900"
        >
          <strong>Fixture camera active.</strong> This build replaces the camera with
          a fixed test image. Nothing here reflects a real lens, a real room, or a
          real student. Development only.
        </p>
      )}
      <CaptureWizard
        cohortId={cohort.id}
        cohortSubjectId={cohortSubjectId ?? null}
        attendanceMode={mode}
        useFixtureCamera={fixtureCamera}
        showDiagnostics={hasPermission(user, "faceEmbedding.manage")}
        addingToRegister={add === "1"}
      />
    </div>
  );
}
