/**
 * Horizontal scroll container for a data table.
 *
 * A roster has more columns than a phone has width. The options are squashing
 * the columns until the values are unreadable, scrolling the whole page
 * sideways, or scrolling the table itself — only the last leaves the rest of
 * the page where the reader put it, so that is what this does.
 *
 * The negative margin lets the scroll area reach the screen edge on phones
 * instead of being clipped inside the page padding, which is what makes it
 * obvious there is more table to the right.
 */
export function TableScroll({
  children,
  minWidth = "min-w-[34rem]",
}: {
  children: React.ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className={minWidth}>{children}</div>
    </div>
  );
}
