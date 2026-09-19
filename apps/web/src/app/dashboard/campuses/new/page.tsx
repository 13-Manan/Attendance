import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { CampusForm } from "../campus-form";

export default async function NewCampusPage() {
  const user = await requirePermissionOrRedirect("campus.manage");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no
        institution to add a campus to.
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link href="/dashboard/campuses" className="text-xs text-neutral-500 hover:underline">
          ← Campuses
        </Link>
        <h1 className="text-xl font-semibold text-neutral-900">Add a campus</h1>
        <p className="max-w-2xl text-sm text-neutral-500">
          A campus is a site this institution operates from. Adding one does not move anybody: it
          becomes available to assign students, staff and classes to.
        </p>
      </header>

      <CampusForm />
    </div>
  );
}
