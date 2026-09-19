import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getUnitFormOptionsForRequest } from "@/modules/academic-structure/directory-service";
import { STRUCTURE_WORDS } from "@/modules/academic-structure/directory-types";
import { Panel } from "@/components/ui/panel";
import { UnitForm } from "../unit-form";

/**
 * Add a part of the academic structure.
 *
 * Gated on `academicStructure.manage` at the door as well as in the service:
 * the service check is the one that protects the data, this one is what stops
 * somebody who cannot use the form from being shown it.
 */
export default async function NewAcademicUnitPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no structure
        to add to.
      </p>
    );
  }

  const options = await getUnitFormOptionsForRequest(user);
  const words = STRUCTURE_WORDS[options.institutionType];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link
          href="/dashboard/academic/units"
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          ← Back to {words.title.toLowerCase()}
        </Link>
        <h2 className="text-lg font-semibold text-neutral-900">Add to the structure</h2>
        <p className="max-w-2xl text-sm text-neutral-500">
          {options.institutionType === "COLLEGE"
            ? "Departments hold semesters, and semesters hold the sections classes are created under."
            : "Grades hold the sections classes are created under."}
        </p>
      </header>

      <Panel title="Details">
        <UnitForm mode="create" options={options} />
      </Panel>
    </div>
  );
}
