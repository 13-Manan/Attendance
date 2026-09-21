import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getPlatformOverview, getReadiness } from "@/modules/platform/service";
import { getFaceServiceStatus } from "@/modules/institutions/overview";
import { StatCard, StatGrid } from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";


/**
 * The platform tier's landing page.
 *
 * Gated on `platform.institution.create`, which only PLATFORM_SUPER_ADMIN
 * holds. An institution admin is redirected rather than shown a narrowed
 * version: a platform view of one institution is that institution's own
 * dashboard, which already exists at `/dashboard`.
 *
 * ## Where readiness went, and why it is still visible
 *
 * The release blockers used to lead this page: "2 release blockers
 * outstanding. This deployment is not cleared for production use." True, and
 * the wrong thing to open with. Its audience is whoever decides to ship, its
 * answer changes roughly never, and above the institution counts it made a
 * working deployment read as a broken one.
 *
 * It moved to `/dashboard/platform/system`, not out of sight: the status strip
 * below still carries the blocker count, still calls it a blocker, and links
 * straight there. The honesty was never in the size of the banner — it is in
 * the count being real and the evidence being named, and both survive.
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

      {/*
        Operational status, in the product's own terms. Not an alert: nothing
        here is a thing to act on this morning, and styling it as one is what
        made the old banner read as an outage. The recognition line says
        exactly what the deployment is running, and the blocker count keeps the
        release position one click away rather than absent.
      */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-sm">
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
          <span className="text-neutral-600">Application</span>
          <span className="font-medium text-neutral-900">Operational</span>
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
          <span className="text-neutral-600">Database</span>
          <span className="font-medium text-neutral-900">Operational</span>
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${faceService ? "bg-amber-500" : "bg-neutral-400"}`}
          />
          <span className="text-neutral-600">Recognition</span>
          <span className="font-medium text-neutral-900">
            {!faceService
              ? "Unreachable"
              : faceService.productionEligible
                ? "Enabled"
                : "Not enabled for production"}
          </span>
        </span>
        <Link
          href="/dashboard/platform/system"
          className="ml-auto text-xs text-neutral-600 underline-offset-2 hover:underline"
        >
          {blocking.length > 0
            ? `${blocking.length} release blocker${blocking.length === 1 ? "" : "s"} · System health`
            : "System health"}
        </Link>
      </div>

      {overview.institutions.total === 0 ? (
        <Panel title="No institutions yet">
          <EmptyState>
            Create your first school or college to begin. Once it exists you can
            add its administrator, and they will set up their own staff,
            students and classes from inside it.
          </EmptyState>
          <div>
            <Link
              href="/dashboard/platform/institutions/new"
              className="inline-flex items-center rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800"
            >
              Create institution
            </Link>
          </div>
        </Panel>
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

    </div>
  );
}
