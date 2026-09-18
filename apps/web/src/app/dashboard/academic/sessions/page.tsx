import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listAcademicSessionsForRequest } from "@/modules/academic-sessions/service";
import { TableScroll } from "@/components/ui/table-scroll";

export default async function AcademicSessionsPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }

  const sessions = await listAcademicSessionsForRequest(user, user.institutionId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900">Academic sessions</h2>
        <Link
          href="/dashboard/academic/sessions/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New session
        </Link>
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-neutral-500">No academic sessions yet.</p>
      ) : (
        <TableScroll>
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Start</th>
                <th className="py-2 pr-4 font-medium">End</th>
                <th className="py-2 pr-4 font-medium">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 pr-4 text-neutral-900">{s.name}</td>
                  <td className="py-2 pr-4 text-neutral-500">{s.startDate.toISOString().slice(0, 10)}</td>
                  <td className="py-2 pr-4 text-neutral-500">{s.endDate.toISOString().slice(0, 10)}</td>
                  <td className="py-2 pr-4 text-neutral-500">{s.isActive ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}
