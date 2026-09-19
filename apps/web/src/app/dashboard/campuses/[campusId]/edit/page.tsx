import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getCampusForRequest } from "@/modules/campuses/service";
import { CampusError } from "@/modules/campuses/types";
import { EmptyState } from "@/components/ui/panel";
import { CampusForm } from "../../campus-form";

interface PageProps {
  params: Promise<{ campusId: string }>;
}

/**
 * Edit one campus.
 *
 * The id comes from the URL, which is why the read goes through
 * `getCampusForRequest` rather than a repository call: that function puts the
 * session's institution in the `where`, so a campus id copied from another
 * institution's URL reads as "does not exist" here and the edit form is never
 * rendered for it. The same check happens again on save, in the service.
 *
 * Status is not edited here. Closing a campus is a decision about what is
 * attached to it, so it is made on the list where those numbers are visible.
 */
export default async function EditCampusPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("campus.manage");
  const { campusId } = await params;

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no campus
        to edit here.
      </p>
    );
  }

  let campus;
  try {
    campus = await getCampusForRequest(user, campusId);
  } catch (error) {
    if (error instanceof CampusError) {
      return (
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <Link href="/dashboard/campuses" className="text-xs text-neutral-500 hover:underline">
            ← Campuses
          </Link>
          <EmptyState>{error.message}</EmptyState>
        </div>
      );
    }
    throw error;
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link href="/dashboard/campuses" className="text-xs text-neutral-500 hover:underline">
          ← Campuses
        </Link>
        <h1 className="text-xl font-semibold text-neutral-900">{campus.name}</h1>
        <p className="max-w-2xl text-sm text-neutral-500">
          Renaming a campus or changing its code does not move anybody. Everything already assigned
          to it stays assigned.
        </p>
      </header>

      <CampusForm
        campus={{
          id: campus.id,
          name: campus.name,
          code: campus.code,
          address: campus.address,
        }}
      />
    </div>
  );
}
