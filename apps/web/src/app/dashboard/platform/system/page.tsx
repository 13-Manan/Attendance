import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getReadiness } from "@/modules/platform/service";
import { getFaceServiceStatus } from "@/modules/institutions/overview";
import { StatCard, StatGrid } from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";
import { ReadinessList } from "@/components/platform/readiness-list";

/**
 * The technical state of the deployment, for the people who operate it.
 *
 * ## Why this page exists
 *
 * All of this used to sit on `/dashboard/platform`, where the first line an
 * administrator read was "2 release blockers outstanding. This deployment is
 * not cleared for production use." Every word of that is true and none of it
 * belongs at the top of an operations screen: it is a release-audit finding,
 * its audience is whoever decides to ship, and its practical answer on any
 * given morning is "yes, still". Sitting above the institution counts it made
 * a working system look broken.
 *
 * Moving it did not soften it. The blockers are unchanged, still name their
 * evidence, and the overview still links here with the count visible — so the
 * fact is one click away rather than in the way. What it is no longer doing is
 * telling an administrator their deployment is broken when what it means is
 * that the face model has not been cleared for commercial use.
 *
 * Nothing here is new: `getReadiness` and `getFaceServiceStatus` are the same
 * functions the overview called, rendered by the same components.
 */
export default async function PlatformSystemHealthPage() {
  const user = await requirePermissionOrRedirect("platform.institution.create");

  // Best effort, deliberately: a face service that is down is one of the
  // things this page reports, so it must not be a thing that takes it down.
  const faceService = await getFaceServiceStatus().catch(() => null);
  const readiness = getReadiness(user);
  const blocking = readiness.filter((item) => item.blocking);
  const advisory = readiness.filter((item) => !item.blocking);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">System health</h1>
          <p className="text-sm text-neutral-500">
            The technical state of this deployment. Operational status, the
            recognition service, and what stands between this build and a
            production release.
          </p>
        </div>
        <Link
          href="/dashboard/platform"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Platform overview
        </Link>
      </header>

      <StatGrid>
        <StatCard label="Application" value="Operational" hint="Serving this request" />
        <StatCard
          label="Database"
          value="Operational"
          // This page reached the session and the readiness data through it,
          // so the database has already answered. Probing again to draw a
          // green dot would be a round trip to learn something known.
          hint="Answered this page"
        />
        <StatCard
          label="Recognition"
          value={!faceService ? "Unreachable" : faceService.health === "operational" ? "Operational" : faceService.health}
          tone={!faceService ? "warning" : "neutral"}
          hint={faceService ? `${faceService.modelName ?? "unknown"} backend` : "Attendance can still be taken by hand"}
        />
        <StatCard
          label="Release blockers"
          value={String(blocking.length)}
          tone={blocking.length > 0 ? "warning" : "neutral"}
          hint={blocking.length === 0 ? "None outstanding" : "Not cleared for release"}
        />
      </StatGrid>

      <Panel
        title="Recognition service"
        description="The face service this deployment is configured to call."
      >
        {!faceService ? (
          <EmptyState>
            The face service could not be reached. Enrollment and recognition
            are unavailable; attendance can still be taken by hand.
          </EmptyState>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-neutral-500">Health</dt>
            <dd className="text-neutral-900">{faceService.health}</dd>
            <dt className="text-neutral-500">Model</dt>
            <dd className="text-neutral-900">
              {faceService.modelName ?? "unknown"} {faceService.modelVersion ?? ""}
            </dd>
            <dt className="text-neutral-500">Production eligible</dt>
            <dd className="font-medium text-amber-800">
              {faceService.productionEligible === null
                ? "Unknown — the service did not answer"
                : faceService.productionEligible
                  ? "Yes"
                  : "No — training-data provenance unresolved"}
            </dd>
          </dl>
        )}
      </Panel>

      <Panel
        title="Release readiness"
        description="What stands between this build and a production release. Each item names the evidence."
      >
        {readiness.length === 0 ? (
          <EmptyState>Nothing outstanding. This build has no recorded blockers.</EmptyState>
        ) : (
          <ReadinessList items={readiness} />
        )}
        <p className="text-xs text-neutral-500">
          {blocking.length} blocking · {advisory.length} advisory. These are
          engineering findings about the build, not the running state of any
          institution&apos;s data.
        </p>
      </Panel>
    </div>
  );
}
