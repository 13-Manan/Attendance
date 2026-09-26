"use client";

import { usePathname } from "next/navigation";
import { BackToParent } from "@/components/nav/back-to-parent";
import { nearestListPage } from "@/components/nav/route-map";

/**
 * 404 for a staff page whose record cannot be shown — a section that was
 * removed, a student id from another school, a link that is out of date.
 *
 * The same words as the site-wide 404, inside the dashboard rather than in
 * place of it, and instead of the homepage it offers the nearest list above
 * the address that is certain to exist: "← Back to Classes" for a section,
 * "← Back to Students" for a student. That list is worked out from the shape
 * of the address alone (`nearestListPage`), so this page says no more than
 * the site-wide 404 about whether the record exists or is someone else's.
 *
 * An address that matches no page at all is still the site-wide 404's.
 */
export default function DashboardNotFound() {
  const pathname = usePathname();
  const parent = nearestListPage(pathname) ?? { label: "Dashboard", href: "/dashboard" };

  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <p className="text-xs font-semibold tracking-widest text-neutral-400 uppercase">Error 404</p>
      <h1 className="text-2xl font-semibold text-neutral-900">Page not found</h1>
      <p className="max-w-sm text-sm text-neutral-500">
        The address you followed doesn&apos;t match anything here. It may have been moved, or the
        link may be out of date.
      </p>
      <div className="mt-2 flex justify-center">
        <BackToParent href={parent.href} label={parent.label} />
      </div>
    </div>
  );
}
