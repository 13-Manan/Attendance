import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { NewStudentForm } from "./new-student-form";

export default async function NewStudentPage() {
  const user = await requirePermissionOrRedirect("student.create");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts can&apos;t create students directly — switch to an institution admin account.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-900">Add student</h1>
      <NewStudentForm institutionId={user.institutionId} />
    </div>
  );
}
