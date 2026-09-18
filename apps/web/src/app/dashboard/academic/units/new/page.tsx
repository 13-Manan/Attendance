import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionById } from "@/modules/institutions/repository";
import { listAcademicUnitsForRequest } from "@/modules/academic-structure/service";
import { KINDS_BY_INSTITUTION_TYPE } from "@/modules/academic-structure/types";
import { NewAcademicUnitForm } from "./new-academic-unit-form";

export default async function NewAcademicUnitPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }
  const institution = await getInstitutionById(user.institutionId);
  if (!institution) return <p className="text-sm text-neutral-500">Institution not found.</p>;

  const units = await listAcademicUnitsForRequest(user, user.institutionId);
  const allowedKinds = KINDS_BY_INSTITUTION_TYPE[institution.type];

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-neutral-900">New academic unit</h2>
      <NewAcademicUnitForm
        allowedKinds={[...allowedKinds]}
        parents={units.map((u) => ({ id: u.id, label: `${u.kind} · ${u.name}` }))}
      />
    </div>
  );
}
