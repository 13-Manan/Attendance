"use client";

import { usePathname } from "next/navigation";
import { buildBreadcrumbs } from "./breadcrumb-items";
import { BreadcrumbTrail } from "./breadcrumb-trail";
import { isDashboardPage, pageDrawsTrail } from "./route-map";

/**
 * Where you are, and the way back up.
 *
 * A client component only because `usePathname` is — it receives no props and
 * reads no session, so nothing about the viewer is serialised into the
 * browser payload to render it. The derivation itself lives in
 * `breadcrumb-items.ts`, which is pure and tested.
 *
 * Renders nothing on a section landing page, and nothing on a page that draws
 * its own trail with the names this one cannot know (`PageTrail`, listed in
 * `route-map.ts`). A crumb for a path that is not a page — `/dashboard/institutions`
 * above Settings — is text rather than a link to a 404. `print:hidden`
 * matches the topbar and sidebar: navigation is not part of a printed register.
 */
export function Breadcrumbs() {
  const pathname = usePathname();
  if (pageDrawsTrail(pathname)) return null;

  const crumbs = buildBreadcrumbs(pathname);
  if (crumbs.length === 0) return null;

  return (
    <BreadcrumbTrail
      className="mb-4"
      crumbs={crumbs.map((crumb) => ({
        label: crumb.label,
        href: crumb.current || !isDashboardPage(crumb.href) ? null : crumb.href,
      }))}
    />
  );
}
