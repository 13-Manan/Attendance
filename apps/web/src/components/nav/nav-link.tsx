"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A nav entry that knows whether it is the current page.
 *
 * The only reason this is a client component: `usePathname`. It takes a
 * label and an href and nothing else, so no session data crosses into the
 * browser payload to get it — the permission filtering stays on the server in
 * `Sidebar`.
 *
 * Active state matters more on a phone than on a desktop here: the sidebar
 * collapses into a horizontal strip where the current section can be scrolled
 * out of view, so highlighting is what tells you where you are.
 */
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  // Exact match, or a descendant route — but "/dashboard" must not light up
  // for every page beneath it, since it is the parent of all of them.
  const isActive =
    pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));

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
