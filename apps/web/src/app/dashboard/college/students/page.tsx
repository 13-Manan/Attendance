import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getOwnDepartmentId } from "@/modules/college-setup/service";
import { readOrDeny } from "@/app/dashboard/college/shared";

/**
 * "Students" in a head of department's navigation: their own department's
 * students. An administrator is sent to the Students page, which is theirs.
 */
export default async function CollegeStudentsEntry() {
  const user = await requireUser();
  const result = await readOrDeny(() => getOwnDepartmentId(user));
  if (!result.ok || !result.value) redirect("/dashboard/students");
  redirect(`/dashboard/college/departments/${encodeURIComponent(result.value)}/students`);
}
