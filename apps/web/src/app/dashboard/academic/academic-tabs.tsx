"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The two tabs a school sees: Academic year and Classes.
 *
 * A client component for one reason — knowing which tab is current — so the
 * tab list itself is decided on the server and only hrefs and labels cross
 * into the browser. A tab stays current on every page beneath it: a class's
 * detail page is still "Classes".
 */
export function AcademicTabs({ tabs }: { tabs: readonly { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Academic setup" className="flex gap-1 overflow-x-auto border-b border-neutral-200 pb-2">
      {tabs.map((tab) => {
        const current = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 ${
              current ? "bg-neutral-900 text-white" : "text-neutral-700 hover:bg-neutral-100"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
