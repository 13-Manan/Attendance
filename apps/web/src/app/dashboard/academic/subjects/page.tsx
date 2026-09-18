import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionById } from "@/modules/institutions/repository";
import { listSubjectsForRequest } from "@/modules/subjects/service";
import { TableScroll } from "@/components/ui/table-scroll";

export default async function SubjectsPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }

  const institution = await getInstitutionById(user.institutionId);
  if (!institution) return <p className="text-sm text-neutral-500">Institution not found.</p>;

  // The service enforces this too — the check here is UX-only, so a school
  // admin sees why the "New subject" button is missing rather than a raw
  // "subjects_are_college_only" error after they click it.
  if (institution.type === "SCHOOL") {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">Subjects</h2>
        <p className="text-sm text-neutral-500">
          Subjects are a college-only concept. Schools take one daily/class attendance session.
        </p>
      </div>
    );
  }

  const subjects = await listSubjectsForRequest(user, user.institutionId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900">Subjects</h2>
        <Link
          href="/dashboard/academic/subjects/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New subject
        </Link>
      </div>
      {subjects.length === 0 ? (
        <p className="text-sm text-neutral-500">No subjects yet.</p>
      ) : (
        <TableScroll>
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Code</th>
                <th className="py-2 pr-4 font-medium">Name</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {subjects.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 pr-4 text-neutral-900">{s.code}</td>
                  <td className="py-2 pr-4 text-neutral-500">{s.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}
