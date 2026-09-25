import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasPermission } from "@/modules/authorization/service";
import { classNavigationAvailable } from "@/modules/students/class-navigation-service";
import { STUDENTS_BASE } from "@/modules/students/class-navigation-paths";

/**
 * Who may open the class-first Students pages: `student.read` like the
 * directory, and `cohort.read` because these pages show a school's classes and
 * teachers. A college has no Class → Section structure, so its Students page
 * is the directory — these paths send it there. The services check the same
 * permissions again; this only decides where the person lands.
 */
export async function requireClassNavigation(): Promise<SessionUser> {
  const user = await requirePermissionOrRedirect("student.read");
  if (!hasPermission(user, "cohort.read")) redirect("/unauthorized");
  if (!(await classNavigationAvailable(user))) redirect(STUDENTS_BASE);
  return user;
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
