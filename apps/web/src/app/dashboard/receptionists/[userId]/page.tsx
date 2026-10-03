import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { formatInTimeZone } from "@/modules/attendance-today/policy";
import { getInstitutionById } from "@/modules/institutions/repository";
import { ACCESS_GROUPS, ACCESS_ITEMS, defaultAccess } from "@/modules/receptionists/catalog";
import { getReceptionist } from "@/modules/receptionists/service";
import { ReceptionistError, type ReceptionistSummary } from "@/modules/receptionists/types";
import { PageTrail } from "@/components/nav/page-trail";
import { Panel } from "@/components/ui/panel";
import { AccessEditor, AccountActions, EditDetailsForm } from "../receptionist-controls";
import { AccessLine, StatusBadge } from "../shared";

interface PageProps {
  params: Promise<{ userId: string }>;
}

/**
 * One receptionist: who they are, whether they can get in, and what they may
 * do.
 *
 * The id in the address is a request, nothing more. The service looks it up
 * among the viewer's own school's receptionists, so another school's account
 * — or a teacher's, or the principal's own — is simply not found here.
 */

export default async function ReceptionistPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("role.assign");
  const { userId } = await params;

  let receptionist: ReceptionistSummary;
  try {
    receptionist = await getReceptionist(user, userId);
  } catch (error) {
    if (error instanceof ReceptionistError) notFound();
    throw error;
  }

  const institution = user.institutionId ? await getInstitutionById(user.institutionId) : null;
  const when = (at: Date) =>
    formatInTimeZone(
      at,
      institution?.timezone,
      { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
      "en-GB",
    );
  const active = receptionist.status === "ACTIVE";

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail
        items={[{ label: "Receptionists", href: "/dashboard/receptionists" }, { label: receptionist.name }]}
      />
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">{receptionist.name}</h1>
          <StatusBadge receptionist={receptionist} />
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-neutral-500">Email</dt>
          <dd className="break-all text-neutral-900">{receptionist.email}</dd>
          <dt className="text-neutral-500">Phone</dt>
          <dd className="text-neutral-900">{receptionist.phone ?? "—"}</dd>
          <dt className="text-neutral-500">Added</dt>
          <dd className="text-neutral-900">{when(receptionist.createdAt)}</dd>
          <dt className="text-neutral-500">Last signed in</dt>
          <dd className="text-neutral-900">
            {receptionist.lastLoginAt ? when(receptionist.lastLoginAt) : "Never"}
          </dd>
          <dt className="text-neutral-500">Access</dt>
          <dd>
            <AccessLine access={receptionist.access} />
          </dd>
        </dl>
        {!active ? (
          <p role="status" className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
            This account is switched off. They cannot sign in until you enable it again; nothing they did is
            removed.
          </p>
        ) : receptionist.mustChangePassword ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            They have not chosen their own password yet — the temporary one you gave them still works for that
            first sign-in. If it was lost, reset it below.
          </p>
        ) : null}
      </header>

      <Panel title="Account" description="Switching the account off, or a new password, signs them out everywhere.">
        <AccountActions receptionistId={receptionist.id} name={receptionist.name} active={active} />
      </Panel>

      <div id="details" className="scroll-mt-24">
        <Panel title="Details">
          <EditDetailsForm
            receptionistId={receptionist.id}
            name={receptionist.name}
            email={receptionist.email}
            phone={receptionist.phone}
          />
        </Panel>
      </div>

      <div id="access" className="scroll-mt-24">
        <Panel
          title="What they can do"
          description="Switch on the work this person does. Sensitive items ask before they turn on."
        >
          <AccessEditor
            receptionistId={receptionist.id}
            name={receptionist.name}
            groups={ACCESS_GROUPS}
            // What the switches say and need — not the permission keys behind them.
            items={ACCESS_ITEMS.map(({ id, group, label, description, requires, confirm }) => ({
              id,
              group,
              label,
              description,
              requires,
              confirm,
            }))}
            initial={receptionist.access}
            defaults={defaultAccess()}
          />
        </Panel>
      </div>
    </div>
  );
}
