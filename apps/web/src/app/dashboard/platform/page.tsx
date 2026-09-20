import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getPlatformOverview, getReadiness } from "@/modules/platform/service";
import { getFaceServiceStatus } from "@/modules/institutions/overview";
import { StatCard, StatGrid } from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";
import { ReadinessList } from "@/components/platform/readiness-list";

/**
 * The platform tier's landing page.
 *
 * Gated on `platform.institution.create`, which only PLATFORM_SUPER_ADMIN
 * holds. An institution admin is redirected rather than shown a narrowed
 * version: a platform view of one institution is that institution's own
 * dashboard, which already exists at `/dashboard`.
 *
 * ## Why readiness is on the landing page
 *
 * Because the alternative is a page of green numbers. Every figure here comes
 * from a real `COUNT`, and a platform administrator reading "12 institutions,
 * 4,100 students, 38 sessions today" would reasonably conclude the product is
 * running well — which it is, and which says nothing about whether it may be
 * *released*. The blockers are the other half of that sentence, so they sit in
 * the same view rather than behind a tab somebody has to think to open.
 */
export default async function PlatformOverviewPage() {
  const user = await requirePermissionOrRedirect("platform.institution.create");

  const [overview, faceService] = await Promise.all([
    getPlatformOverview(user),
    // Best effort: a face service that is down must not take this page with
    // it. The counts above come from our own database and are still true.
    getFaceServiceStatus().catch(() => null),
  ]);
  const readiness = getReadiness(user);
  const blocking = readiness.filter((item) => item.blocking);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-neutral-900">Platform</h1>
          <p className="text-sm text-neutral-500">
            Every institution on this deployment. Institution-level
            administration stays inside each tenant.
          </p>
        </div>
        <Link
          href="/dashboard/platform/institutions"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          All institutions
        </Link>
      </header>

      {blocking.length > 0 ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span className="font-medium">
            {blocking.length} release blocker{blocking.length === 1 ? "" : "s"} outstanding.
          </span>{" "}
          This deployment is not cleared for production use. See below.
        </p>
      ) : null}

      <StatGrid>
        <StatCard
          label="Institutions"
          value={String(overview.institutions.total)}
          hint={`${overview.institutions.schools} school${overview.institutions.schools === 1 ? "" : "s"} · ${overview.institutions.colleges} college${overview.institutions.colleges === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Suspended"
          value={String(overview.institutions.suspended)}
          tone={overview.institutions.suspended > 0 ? "warning" : "neutral"}
          hint={overview.institutions.suspended === 0 ? "All tenants active" : "Not being served"}
        />
        <StatCard
          label="Students"
          value={String(overview.people.students)}
          hint={`${overview.people.activeStudents} active`}
        />
        <StatCard
          label="Users"
          value={String(overview.people.users)}
          hint={`${overview.people.activeUsers} active`}
        />
      </StatGrid>

      <Panel title="Today" description="Across every institution, on the UTC calendar day.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label="Sessions today" value={String(overview.attendance.sessionsToday)} />
          <StatCard
            label="Confirmed today"
            value={String(overview.attendance.finalizedToday)}
            hint="Registers a teacher has closed"
          />
          <StatCard
            label="Awaiting review"
            value={String(overview.attendance.awaitingReview)}
            tone={overview.attendance.awaitingReview > 0 ? "warning" : "neutral"}
            hint="All dates — registers owing a decision"
          />
        </div>
      </Panel>

      <Panel title="Platform totals">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Classes" value={String(overview.academic.cohorts)} />
          <StatCard label="Subjects" value={String(overview.academic.subjects)} />
          <StatCard
            label="API keys"
            value={String(overview.integrations.activeApiKeys)}
            hint={`${overview.integrations.apiKeys} issued`}
          />
          <StatCard
            label="Webhooks"
            value={String(overview.integrations.webhookEndpoints)}
            hint="Active endpoints"
          />
        </div>
        <p className="text-xs text-neutral-500">
          {overview.security.auditEventsLast24h} audit event
          {overview.security.auditEventsLast24h === 1 ? "" : "s"} in the last 24 hours.
        </p>
      </Panel>

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
        <ReadinessList items={readiness} />
      </Panel>
    </div>
  );
}
