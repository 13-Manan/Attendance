import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getIntegrationCenter } from "@/modules/integrations/center-service";
import { ImportWizard } from "./import-wizard";

/**
 * Import a roster from a file.
 *
 * This page exists because the brief's hardest constraint is the honest one:
 * not every institution has a system with an API. Plenty have a registrar who
 * exports an Excel sheet once a term. That path has to be first-class rather
 * than a fallback — same validation, same duplicate detection, same audit row
 * as a REST sync.
 */
export default async function ImportPage() {
  const user = await requirePermissionOrRedirect("institution.read");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts cannot import rosters.</p>;
  }

  // Previewing diffs the file against the roster, so it needs the roster read;
  // committing writes students. Both are checked again in the service — this
  // is what keeps the page from rendering a wizard that cannot finish.
  if (!hasPermission(user, "student.read") || !hasPermission(user, "student.create")) {
    return (
      <p className="text-sm text-neutral-500">
        Importing a roster needs permission to read and create students.
      </p>
    );
  }

  const view = await getIntegrationCenter(user);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Import students</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Upload a CSV or Excel export. You will see exactly what would change before anything is
          written — how many students would be created, how many updated, and which rows have
          problems.
        </p>
        <Link
          href="/dashboard/integrations"
          className="text-sm text-neutral-900 underline underline-offset-4"
        >
          ← Back to integrations
        </Link>
      </header>

      <ImportWizard targetFields={view.targetFields} />
    </div>
  );
}
