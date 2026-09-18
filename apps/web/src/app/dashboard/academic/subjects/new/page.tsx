import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionById } from "@/modules/institutions/repository";
import { NewSubjectForm } from "./new-subject-form";

export default async function NewSubjectPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }
  const institution = await getInstitutionById(user.institutionId);
  if (!institution || institution.type !== "COLLEGE") {
    return <p className="text-sm text-neutral-500">Subjects are only available for college institutions.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-neutral-900">New subject</h2>
      <NewSubjectForm />
    </div>
  );
}
