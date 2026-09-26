import { BackToParent } from "./back-to-parent";
import { BreadcrumbTrail } from "./breadcrumb-trail";
import { parentCrumb, type BackTarget, type TrailCrumb } from "./trail";

/**
 * A page's own breadcrumb, with names, and the way back up.
 *
 * For pages whose address holds a record id. The layout's trail is built from
 * the URL alone, so all it can call "cm5x…" is "Details"; this page has just
 * loaded that record, through the service that checks the viewer may see it,
 * and can say "Aarav Sharma". Which pages draw their own trail is recorded in
 * `route-map.ts`, and the layout's trail steps aside on exactly those.
 *
 * `items` start below "Dashboard" and end with the page itself. The back link
 * goes to the crumb one level up unless `back` names another destination — a
 * list the reader came from — or is `null` for none.
 */
export function PageTrail({
  items,
  back,
}: {
  items: readonly TrailCrumb[];
  back?: BackTarget | null;
}) {
  const target = back === undefined ? parentCrumb(items) : back;
  return (
    <div className="flex min-w-0 flex-col gap-2 print:hidden">
      <BreadcrumbTrail crumbs={[{ label: "Dashboard", href: "/dashboard" }, ...items]} />
      {target ? <BackToParent href={target.href} label={target.label} /> : null}
    </div>
  );
}
