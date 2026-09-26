// What a named trail is made of, and which crumb is the way back.
//
// Kept apart from the components that render it so the decision — which page
// "← Back to …" leads to — can be tested without rendering anything.

export interface TrailCrumb {
  label: string;
  /** Where the crumb leads. Omitted for the current page, and for a path that is not a page. */
  href?: string | null;
}

export interface BackTarget {
  /** The page's name as the reader knows it: "Class 8", "Students". */
  label: string;
  href: string;
}

/**
 * The crumb one level above the current page, as a back link — or null when
 * there is none to go to (a trail of one, or a parent that is not a page).
 */
export function parentCrumb(items: readonly TrailCrumb[]): BackTarget | null {
  const parent = items.at(-2);
  if (!parent?.href || !parent.label) return null;
  return { label: parent.label, href: parent.href };
}
