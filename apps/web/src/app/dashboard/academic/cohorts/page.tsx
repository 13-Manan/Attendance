import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listCohortsForInstitutionRequest } from "@/modules/cohorts/service";
import { TableScroll } from "@/components/ui/table-scroll";

export default async function CohortsPage() {
  const user = await requirePermissionOrRedirect("cohort.read");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }

  const cohorts = await listCohortsForInstitutionRequest(user, user.institutionId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900">Cohorts</h2>
        <Link
          href="/dashboard/academic/cohorts/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New cohort
        </Link>
      </div>
      {cohorts.length === 0 ? (
        <p className="text-sm text-neutral-500">No cohorts yet.</p>
      ) : (
        <TableScroll>
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Term</th>
                <th className="py-2 pr-4 font-medium">Academic unit</th>
                <th className="py-2 pr-4 font-medium">Session</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {cohorts.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-4 text-neutral-900">{c.name}</td>
                  <td className="py-2 pr-4 text-neutral-500">{c.termLabel ?? "—"}</td>
                  <td className="py-2 pr-4 text-neutral-500">{c.academicUnitId}</td>
                  <td className="py-2 pr-4 text-neutral-500">{c.academicSessionId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}
