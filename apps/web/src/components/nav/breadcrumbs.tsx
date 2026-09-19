"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildBreadcrumbs } from "./breadcrumb-items";

/**
 * Where you are, and the way back up.
 *
 * A client component only because `usePathname` is — it receives no props and
 * reads no session, so nothing about the viewer is serialised into the
 * browser payload to render it. The derivation itself lives in
 * `breadcrumb-items.ts`, which is pure and tested.
 *
 * Renders nothing at all on a section landing page. `print:hidden` matches the
 * topbar and sidebar: navigation is not part of a printed register.
 */
export function Breadcrumbs() {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs(pathname);
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="mb-4 print:hidden">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-500">
        {crumbs.map((crumb) => (
          <li key={crumb.href} className="flex items-center gap-1.5">
            {crumb.current ? (
              <span aria-current="page" className="font-medium text-neutral-900">
                {crumb.label}
              </span>
            ) : (
              <>
                <Link href={crumb.href} className="rounded hover:text-neutral-900 hover:underline">
                  {crumb.label}
                </Link>
                {/* Decorative: the list structure already conveys the nesting
                    to assistive technology, where a literal "/" is noise. */}
                <span aria-hidden className="text-neutral-300">
                  /
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
