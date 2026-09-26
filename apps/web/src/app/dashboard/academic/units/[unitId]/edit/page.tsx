import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  getUnitFormOptionsForRequest,
  getUnitForRequest,
} from "@/modules/academic-structure/directory-service";
import {
  AcademicStructureError,
  STRUCTURE_WORDS,
  type UnitRow,
} from "@/modules/academic-structure/directory-types";
import { PageTrail } from "@/components/nav/page-trail";
import { Panel } from "@/components/ui/panel";
import { UnitForm } from "../../unit-form";

interface PageProps {
  params: Promise<{ unitId: string }>;
}

/**
 * Rename one part of the structure, or change its code or its order.
 *
 * An id copied from another institution's URL is a 404 rather than a form
 * pre-filled with their department: the read is institution-scoped, and "does
 * not exist" is the only answer it gives.
 *
 * The kind, the parent and the campus are shown as facts, for the reason
 * recorded in `unit-form.tsx`.
 */
export default async function EditAcademicUnitPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  const { unitId } = await params;

  let unit: UnitRow;
  try {
    unit = await getUnitForRequest(user, unitId);
  } catch (error) {
    if (error instanceof AcademicStructureError) notFound();
    throw error;
  }

  const options = await getUnitFormOptionsForRequest(user);
  const words = STRUCTURE_WORDS[options.institutionType];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Academic", href: "/dashboard/academic" },
          { label: words.title, href: "/dashboard/academic/units" },
          { label: unit.name },
        ]}
      />

      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-900">{unit.name}</h2>
        <p className="text-sm text-neutral-500">
          {options.labels[unit.kind] ?? unit.kind}
          {unit.parentName ? ` · inside ${unit.parentName}` : ""}
        </p>
      </header>

      <Panel title="Details">
        <UnitForm mode="edit" unit={unit} options={options} />
      </Panel>
    </div>
  );
}
