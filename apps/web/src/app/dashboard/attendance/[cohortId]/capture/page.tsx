import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { institutionToday } from "@/modules/attendance-today/policy";
import { countActiveStudents } from "@/modules/attendance-today/repository";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requireSameInstitution } from "@/modules/authorization/service";
import { getCohortById } from "@/modules/cohorts/repository";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import { getCohortSubjectById, getSubjectById } from "@/modules/subjects/repository";
import { PageTrail } from "@/components/nav/page-trail";
import { CaptureWizard } from "./capture-client";

interface PageProps {
  params: Promise<{ cohortId: string }>;
  searchParams: Promise<{ subject?: string; add?: string; start?: string; from?: string }>;
}

/**
 * Server shell for the classroom capture wizard.
 *
 * The heavy interactive work — camera, previews, per-image analysis,
 * progress UI — is in `CaptureWizard` (client). This shell exists to run
 * the server-side authorization checks up front so the client only ever
 * renders for a caller who is genuinely allowed to capture attendance for
 * this cohort.
 *
 * `start=1` carries the teacher's tap from the Today card (or the class page):
 * the wizard opens today's register and the camera straight away instead of
 * asking for a second "Start". It grants nothing — Start runs the same checks
 * on the server whichever way it is pressed.
 */
export default async function AttendanceCapturePage({ params, searchParams }: PageProps) {
  const { cohortId } = await params;
  const { subject: cohortSubjectId, add, start, from } = await searchParams;

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

  // The subject's name for the header, before the register is opened. Shown
  // only for a subject of this class; anything else is left for Start to
  // refuse with its own message.
  let subjectName: string | null = null;
  if (cohortSubjectId) {
    const cohortSubject = await getCohortSubjectById(cohortSubjectId);
    if (cohortSubject && cohortSubject.cohortId === cohort.id) {
      subjectName = (await getSubjectById(cohortSubject.subjectId))?.name ?? null;
    }
  }

  // Today in the institution's own timezone — production runs in UTC.
  const today = institutionToday(new Date(), institution.timezone);

  // A class with nobody on roll has no register to take. Saying so here keeps
  // Start from opening an empty register first (it would be refused later,
  // when the photos are matched).
  const studentCount = (await countActiveStudents([cohort.id])).get(cohort.id) ?? 0;

  // Where "back" goes. A fixed choice, never a URL from the query string.
  const back =
    from === "today"
      ? { href: "/dashboard", label: "Today" }
      : { href: `/dashboard/attendance/${cohort.id}`, label: cohort.name };

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
        <h1 className="text-xl font-semibold text-neutral-900">
          {subjectName ? `${subjectName} · ${cohort.name}` : cohort.name}
        </h1>
        <p className="text-sm text-neutral-500">
          {today.long}
          {" · "}
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
        autoStart={start === "1"}
        context={{
          title: subjectName ?? cohort.name,
          subtitle: subjectName ? cohort.name : cohort.termLabel,
          dateLabel: today.short,
        }}
        back={back}
        canReview={hasPermission(user, "attendanceRecord.read")}
        noStudents={studentCount === 0}
      />
    </div>
  );
}
