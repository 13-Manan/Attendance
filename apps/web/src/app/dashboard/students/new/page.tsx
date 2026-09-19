import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getStudentFormOptionsForRequest } from "@/modules/students/directory-service";
import { StudentForm } from "../student-form";

/**
 * Admit a student.
 *
 * The same form as the edit page, in create mode. The institution is not a
 * field on it — it comes from the session inside the service — so there is
 * nothing on this page that a crafted submission could point at another
 * school, which is what the earlier hidden `institutionId` input made possible
 * in principle.
 */
export default async function NewStudentPage() {
  const user = await requirePermissionOrRedirect("student.create");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is nowhere to
        admit a student from here. Sign in as an institution administrator.
      </p>
    );
  }

  // The dropdowns need `student.read`, which every role that may admit a
  // student also holds. A role configured with one and not the other still
  // gets a working form: without the options there is no campus or class to
  // pick, and both are optional at admission.
  const canRead = hasPermission(user, "student.read");
  const options = canRead
    ? await getStudentFormOptionsForRequest(user)
    : { campuses: [], cohorts: [] };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <div>
        <Link
          href="/dashboard/students"
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          ← All students
        </Link>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Add student</h1>
        <p className="max-w-xl text-sm text-neutral-500">
          Only a name and a student code are required. Everything else — admission details, campus,
          class — can be filled in now or later from the student&apos;s record.
        </p>
      </header>

      <StudentForm
        mode="create"
        options={options}
        canPlace={hasPermission(user, "enrollment.manage")}
      />
    </div>
  );
}
