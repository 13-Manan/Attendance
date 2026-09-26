import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { NewInstitutionForm } from "./new-institution-form";
import { BackToParent } from "@/components/nav/back-to-parent";
import { Panel } from "@/components/ui/panel";

/**
 * Creating a tenant.
 *
 * Creates the institution row and nothing else — no admin user, no roles, no
 * academic scaffolding. Those belong to the bootstrap path, which already does
 * them idempotently and under a lock; a second half-implementation here would
 * be a second way to leave an institution partly created.
 *
 * The next step is therefore stated on the page rather than implied, because
 * an empty tenant with no way in is a confusing thing to be handed.
 */
export default async function NewInstitutionPage() {
  await requirePermissionOrRedirect("platform.institution.create");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <BackToParent href="/dashboard/platform/institutions" label="Institutions" />
        <h1 className="text-xl font-semibold text-neutral-900">Add institution</h1>
        <p className="text-sm text-neutral-500">
          Creates the tenant. Its first administrator is provisioned separately
          through the bootstrap flow.
        </p>
      </header>

      <Panel title="Details">
        <NewInstitutionForm />
      </Panel>

      <p className="text-xs text-neutral-500">
        The type decides how attendance works for this institution: a school
        takes a daily register, a college takes one per subject. It is part of
        the academic model rather than a display preference, so choose it with
        the institution rather than for them.
      </p>
    </div>
  );
}
