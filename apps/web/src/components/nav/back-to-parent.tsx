import Link from "next/link";

/**
 * "← Back to Class 8": the way up one level, to a page the caller names.
 *
 * A link, not `history.back()`: the destination is decided by where this page
 * sits, so it is the same whether the reader arrived from a list, a bookmark,
 * a search or a refresh — and the browser's own Back button is left alone.
 *
 * The arrow is decoration; the accessible name is "Back to Class 8". A long
 * name is cut short on screen with an ellipsis and kept whole for assistive
 * technology.
 */
export function BackToParent({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group inline-flex max-w-full items-center gap-1.5 self-start rounded py-1 text-sm text-neutral-500 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 print:hidden"
    >
      <span aria-hidden="true">←</span>
      <span className="min-w-0 truncate group-hover:underline">Back to {label}</span>
    </Link>
  );
}
