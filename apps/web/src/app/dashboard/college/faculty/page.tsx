import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getOwnDepartmentId } from "@/modules/college-setup/service";
import { readOrDeny } from "@/app/dashboard/college/shared";

/**
 * "Faculty" in a head of department's navigation: their own department's
 * staff. An administrator is sent to the Faculty page, which is theirs.
 */
export default async function CollegeFacultyEntry() {
  const user = await requireUser();
  const result = await readOrDeny(() => getOwnDepartmentId(user));
  if (!result.ok || !result.value) redirect("/dashboard/faculty");
  redirect(`/dashboard/college/departments/${encodeURIComponent(result.value)}/faculty`);
}
