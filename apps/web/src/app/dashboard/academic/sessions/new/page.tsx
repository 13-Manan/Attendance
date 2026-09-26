import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { BackToParent } from "@/components/nav/back-to-parent";
import { NewAcademicSessionForm } from "./new-academic-session-form";

export default async function NewAcademicSessionPage() {
  await requirePermissionOrRedirect("academicStructure.manage");
  return (
    <div className="flex flex-col gap-4">
      <BackToParent href="/dashboard/academic/sessions" label="Academic sessions" />
      <h2 className="text-lg font-semibold text-neutral-900">New academic year</h2>
      <NewAcademicSessionForm />
    </div>
  );
}
