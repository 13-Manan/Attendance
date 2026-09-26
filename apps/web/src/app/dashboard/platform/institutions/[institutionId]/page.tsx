import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionDetail } from "@/modules/platform/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { StatCard, StatGrid, formatSessionDate } from "@/components/ui/attendance-stat";
import { EmptyState, Panel } from "@/components/ui/panel";
import { SuspensionControl } from "./suspension-control";
import { Administrators } from "./administrators";
import {
  defaultAdminRoleFor,
  listInstitutionAdministrators,
} from "@/modules/platform/administrators";

interface PageProps {
  params: Promise<{ institutionId: string }>;
}

/**
 * One tenant, from the platform tier.
 *
 * Read-mostly on purpose. Everything an institution's own administrator does —
 * students, classes, subjects, integrations, settings — already has a screen
 * inside that tenant, and duplicating it here would be a second implementation
 * of every one of those flows, each with its own chance of getting the
 * authorization wrong.
 *
 * What only the platform can do is the tenant's lifecycle, so that is what
 * this page adds. The counts are operational context for that decision:
 * suspending an institution with 400 students and an unreviewed register is a
 * different act from suspending an empty one, and the number should be on the
 * screen where the decision is taken.
 *
 * No biometric data appears here. `facesEnrolled` is a `COUNT` of template
 * rows — never a vector, never an image.
 */
export const dynamic = "force-dynamic";

export default async function PlatformInstitutionDetailPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("platform.institution.create");
  const { institutionId } = await params;

  const institution = await getInstitutionDetail(user, institutionId);
  if (!institution) notFound();

  const administrators = await listInstitutionAdministrators(user, institution.id);

  const suspended = institution.suspendedAt !== null;

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Platform", href: "/dashboard/platform" },
          { label: "Institutions", href: "/dashboard/platform/institutions" },
          { label: institution.name },
        ]}
      />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-neutral-900">{institution.name}</h1>
          {suspended ? <Badge tone="neutral">Suspended</Badge> : <Badge tone="positive">Active</Badge>}
        </div>
        <p className="text-xs text-neutral-500">
          {institution.type === "COLLEGE" ? "College" : "School"} ·{" "}
          {institution.attendanceMode === "SUBJECT_WISE" ? "Subject-wise attendance" : "Daily attendance"}{" "}
          · {institution.timezone} · created {formatSessionDate(institution.createdAt)}
        </p>
      </header>

      {suspended ? (
        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Suspended on {formatSessionDate(institution.suspendedAt!)}. Records,
          audit history and enrolments are untouched — suspension is
          reversible and deletes nothing.
        </p>
      ) : null}

      <StatGrid>
        <StatCard
          label="Students"
          value={String(institution.counts.students)}
          hint={`${institution.counts.activeStudents} active`}
        />
        <StatCard label="Users" value={String(institution.counts.users)} />
        <StatCard label="Classes" value={String(institution.counts.cohorts)} />
        <StatCard
          label="Awaiting review"
          value={String(institution.counts.sessionsAwaitingReview)}
          tone={institution.counts.sessionsAwaitingReview > 0 ? "warning" : "neutral"}
          hint="Registers owing a decision"
        />
      </StatGrid>

      <Panel title="Profile">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="Contact email">{institution.contactEmail ?? "—"}</Row>
          <Row label="Contact phone">{institution.contactPhone ?? "—"}</Row>
          <Row label="Address">{institution.addressLine ?? "—"}</Row>
          <Row label="Campuses">{institution.counts.campuses}</Row>
        </dl>
        <p className="text-xs text-neutral-500">
          Profile and settings are edited by this institution&apos;s own
          administrator, inside the tenant.
        </p>
      </Panel>

      <Panel title="Academic and integrations">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Subjects" value={String(institution.counts.subjects)} />
          <StatCard
            label="Faces enrolled"
            value={String(institution.counts.facesEnrolled)}
            hint="Active templates"
          />
          <StatCard
            label="API keys"
            value={String(institution.counts.activeApiKeys)}
            hint={`${institution.counts.apiKeys} issued`}
          />
          <StatCard label="Webhooks" value={String(institution.counts.webhookEndpoints)} />
        </div>
        <p className="text-xs text-neutral-500">
          Face enrollment is reported as a count of active templates. No
          biometric value is readable from this page or from the query behind
          it.
        </p>
      </Panel>

      <Administrators
        institutionId={institution.id}
        institutionName={institution.name}
        institutionType={institution.type === "COLLEGE" ? "COLLEGE" : "SCHOOL"}
        defaultRoleKey={defaultAdminRoleFor(institution.type === "COLLEGE" ? "COLLEGE" : "SCHOOL")}
        administrators={administrators}
      />

      {/*
        Where the rest of the hierarchy lives. Everything below an
        administrator is created by that administrator inside their own
        institution, so this points at those screens rather than duplicating
        them — a second implementation of staff or student creation is a second
        place for the authorization to be wrong.
      */}
      <Panel
        title="Inside this institution"
        description="Created and managed by this institution's own administrator, not from the platform tier."
      >
        <ul className="flex flex-col gap-1 text-sm text-neutral-700">
          <li>Teachers and faculty — staff directory</li>
          <li>Students, and their portal logins — student directory</li>
          <li>
            {institution.type === "COLLEGE"
              ? "Programmes, semesters, subjects and faculty assignments"
              : "Classes and sections"}{" "}
            — academic structure
          </li>
          <li>Face enrollment, attendance sessions, review and reports</li>
        </ul>
        <p className="text-xs text-neutral-500">
          A platform account is not scoped to one institution, so those screens
          are not available from here. An administrator added above signs in and
          reaches all of them.
        </p>
      </Panel>

      <Panel title="Recent activity" description="The last ten audit events for this institution.">
        {institution.recentAudit.length === 0 ? (
          <EmptyState>Nothing has been recorded for this institution yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {institution.recentAudit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="text-sm text-neutral-900">
                  <code className="font-mono text-xs">{entry.action}</code>
                  <span className="ml-2 text-xs text-neutral-500">{entry.entityType}</span>
                </span>
                <span className="text-xs text-neutral-500">
                  {entry.actorName ?? "system"} · {formatSessionDate(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <SuspensionControl
        institutionId={institution.id}
        institutionName={institution.name}
        suspended={suspended}
        students={institution.counts.activeStudents}
        awaitingReview={institution.counts.sessionsAwaitingReview}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-neutral-500">{label}</dt>
      <dd className="text-sm text-neutral-900">{children}</dd>
    </div>
  );
}
