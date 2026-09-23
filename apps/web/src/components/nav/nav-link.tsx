"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A nav entry that knows whether it is the current page.
 *
 * The only reason this is a client component: `usePathname`. It takes a
 * label, an href, and optionally the list of *other* nav hrefs its parent
 * is rendering — no session data crosses into the browser payload for
 * active-state calculation. The permission filtering stays on the server
 * in `Sidebar`.
 *
 * ## Why active state has to be most-specific-match, not simple prefix
 *
 * A parent nav item and a child nav item can both be legitimate destinations
 * living in the same sidebar. For example the platform tier renders both
 * `/dashboard/platform` ("Platform overview") and
 * `/dashboard/platform/institutions` ("Institutions"). A naïve
 * `pathname.startsWith(href)` lights both up when the viewer is on the
 * institutions page — which reads as "you are on two pages at once".
 *
 * The rule below is a two-step:
 *
 *   1. Exact match — the pathname is this item's href. Always active, always
 *      wins, no ambiguity.
 *   2. Descendant match — the pathname is a strict descendant of this item's
 *      href, AND no *other* nav item's href is a more specific prefix of the
 *      pathname. So `/dashboard/platform` only stays active for
 *      `/dashboard/platform/sub/routes-that-are-not-their-own-nav-item`, and
 *      steps aside for `/dashboard/platform/institutions` — because Institutions
 *      is itself a nav item with a longer, more specific href.
 *
 * `siblingHrefs` is optional: if the caller does not pass it, we fall back to
 * pure exact match, which is safe (fewer false positives) even if slightly
 * less permissive for nested routes.
 */
export function NavLink({
  href,
  label,
  siblingHrefs,
}: {
  href: string;
  label: string;
  /**
   * Every other nav href in the same shell. Used to reject a descendant
   * match when a more-specific sibling exists. Ordering does not matter.
   */
  siblingHrefs?: readonly string[];
}) {
  const pathname = usePathname();

  const isActive = (() => {
    if (pathname === href) return true;

    // Descendant match: only when a more specific sibling has NOT claimed
    // the current pathname. Without the sibling list we cannot know that,
    // so we do not activate on prefix alone.
    if (!siblingHrefs) return false;

    // Not a descendant of *this* href — no need to think further.
    const withSlash = `${href}/`;
    if (!pathname.startsWith(withSlash)) return false;

    // Does any other sibling match the pathname more specifically? If yes,
    // that sibling is the correct active item and this one is not.
    const hasMoreSpecific = siblingHrefs.some((other) => {
      if (other === href) return false;
      if (other.length <= href.length) return false;
      return pathname === other || pathname.startsWith(`${other}/`);
    });
    return !hasMoreSpecific;
  })();

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        isActive
          ? "bg-neutral-900 text-white"
          : "text-neutral-700 hover:bg-neutral-100"
      }`}
    >
      {label}
    </Link>
  );
}
