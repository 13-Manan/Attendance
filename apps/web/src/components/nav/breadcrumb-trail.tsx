import Link from "next/link";
import type { TrailCrumb } from "./trail";

const LINK =
  "rounded hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-1";

/**
 * A breadcrumb trail, root first; the last crumb is the page being viewed.
 *
 * Markup only, and no client hooks, so the layout's URL-derived trail
 * (`Breadcrumbs`) and a page's own named one (`PageTrail`) render the same
 * list the same way. A long name wraps rather than pushing a phone's page
 * sideways.
 */
export function BreadcrumbTrail({
  crumbs,
  className = "",
}: {
  crumbs: readonly TrailCrumb[];
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={`print:hidden ${className}`}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-500">
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li key={`${index}-${crumb.label}`} className="flex min-w-0 items-center gap-1.5">
              {current ? (
                <span aria-current="page" className="font-medium text-neutral-900 wrap-anywhere">
                  {crumb.label}
                </span>
              ) : crumb.href ? (
                <Link href={crumb.href} className={`${LINK} wrap-anywhere`}>
                  {crumb.label}
                </Link>
              ) : (
                <span className="wrap-anywhere">{crumb.label}</span>
              )}
              {/* Decorative: the list structure already conveys the nesting
                  to assistive technology, where a literal "/" is noise. */}
              {current ? null : (
                <span aria-hidden className="text-neutral-300">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
