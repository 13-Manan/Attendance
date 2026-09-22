import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getPlatformOverview, getReadiness } from "@/modules/platform/service";
import { getFaceServiceStatus } from "@/modules/institutions/overview";
import { StatCard, StatGrid } from "@/components/ui/attendance-stat";
import { Button } from "@/components/ui/button";
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
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Platform tier
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            Platform
          </h1>
          <p className="text-sm text-neutral-500">
            Every institution on this deployment. Institution-level
            administration stays inside each tenant.
          </p>
        </div>
        <Link href="/dashboard/platform/institutions" className="shrink-0">
          <Button type="button" variant="secondary" className="w-full sm:w-auto">
            All institutions →
          </Button>
        </Link>
      </header>

      {/*
        Operational status, in the product's own terms. Not an alert: nothing
        here is a thing to act on this morning, and styling it as one is what
        made the old banner read as an outage. The recognition line says
        exactly what the deployment is running, and the blocker count keeps the
        release position one click away rather than absent.
      */}
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2 sm:px-4">
        <StatusPill tone="ok" label="Application" value="Operational" />
        <StatusPill tone="ok" label="Database" value="Operational" />
        <StatusPill
          tone={!faceService ? "muted" : "warn"}
          label="Recognition"
          value={
            !faceService
              ? "Unreachable"
              : faceService.productionEligible
                ? "Enabled"
                : "Not enabled for production"
          }
        />
        <Link
          href="/dashboard/platform/system"
          className="w-full text-xs font-medium text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline sm:ml-auto sm:w-auto"
        >
          {blocking.length > 0
            ? `${blocking.length} release blocker${blocking.length === 1 ? "" : "s"} · System health →`
            : "System health →"}
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
            <Link href="/dashboard/platform/institutions/new">
              <Button type="button">+ Create institution</Button>
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

/**
 * A compact status row: coloured dot + label + value. Purely presentational —
 * the underlying data comes from `getFaceServiceStatus` and the readiness
 * service exactly as before. Colour is paired with text ("Operational",
 * "Unreachable", "Not enabled for production") so it never carries meaning on
 * its own.
 */
function StatusPill({
  tone,
  label,
  value,
}: {
  tone: "ok" | "warn" | "muted";
  label: string;
  value: string;
}) {
  const dotClass =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-neutral-300";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={`size-2 rounded-full ${dotClass}`} />
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium text-neutral-900">{value}</span>
    </span>
  );
}
