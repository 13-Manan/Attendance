import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getIntegrationCenter } from "@/modules/integrations/center-service";
import { Panel, EmptyState } from "@/components/ui/panel";
import { AddIntegrationForm } from "./add-integration-form";
import { ConnectionCard } from "./connection-card";

/**
 * The Integration Center.
 *
 * Server-rendered and permission-gated here, not in the nav: hiding a link is
 * a convenience, and `requirePermissionOrRedirect` is what actually stops
 * someone who types the URL.
 *
 * The page is read-gated on `institution.read` but every control on it is
 * write-gated on `institution.update` in the service. `canManage` decides
 * whether the controls are rendered at all — so a read-only viewer gets a
 * page that tells them the truth about what is connected, rather than a row
 * of buttons that all fail.
 */
export default async function IntegrationsPage() {
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no
        integrations to manage here.
      </p>
    );
  }

  const view = await getIntegrationCenter(user);
  const canManage = hasPermission(user, "institution.update");

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Connect
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Integrations
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Connect this platform to the systems the institution already runs — an ERP, a student
          information system, or a folder of spreadsheets. Records flow in; attendance flows out
          over webhooks and the versioned API.
        </p>
      </header>

      <Panel
        title="Connected systems"
        description={
          view.connections.length === 1
            ? "1 integration configured."
            : `${view.connections.length} integrations configured.`
        }
        action={
          <Link
            href="/dashboard/integrations/import"
            className="text-sm font-medium text-neutral-900 underline underline-offset-4"
          >
            Import a file instead
          </Link>
        }
      >
        {view.connections.length === 0 ? (
          <EmptyState>
            Nothing is connected yet. Add an integration below, or import a CSV or Excel export if
            the source system has no API.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {view.connections.map((connection) => (
              <li key={connection.id}>
                <ConnectionCard
                  connection={connection}
                  targetFields={view.targetFields}
                  canManage={canManage}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {canManage ? (
        <AddIntegrationForm
          providers={view.providers}
          syncableResources={[...view.syncableResources]}
        />
      ) : (
        <p className="text-xs text-neutral-500">
          You can see what is connected, but changing it needs the institution-settings
          permission.
        </p>
      )}
    </div>
  );
}
