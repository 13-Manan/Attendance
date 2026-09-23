import { hasPermission, isPlatformUser } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { buildNavSections, type InstitutionKind } from "./nav-items";
import { NavLink } from "./nav-link";

/**
 * Staff navigation.
 *
 * Two shapes, one markup: a fixed left rail from `md` up, and a horizontally
 * scrolling strip below it. No JavaScript decides which — it is a CSS
 * breakpoint, so the nav is correct on first paint, survives a cold start,
 * and cannot get stuck open. A hamburger drawer would be a state machine
 * standing between a teacher and the register.
 *
 * Permission filtering stays here, on the server: the browser is handed only
 * the links the user may see, not the session to filter them with. As ever,
 * a hidden link is a convenience — each page enforces its own permission.
 *
 * ## Grouping, and why the headings vanish on a phone
 *
 * On the rail, each group is a labelled block — an administrator scanning for
 * "API keys" looks under a heading rather than down fifteen equal-weight
 * links. On the narrow strip the headings would eat the horizontal room the
 * links themselves need, so they are hidden visually and kept for screen
 * readers, where the grouping costs nothing and still explains the order.
 */
export function Sidebar({
  user,
  institutionKind = null,
}: {
  user: SessionUser;
  /** `null` for a platform-level account, which is not one institution's. */
  institutionKind?: InstitutionKind;
}) {
  const sections = buildNavSections(
    (permission) => hasPermission(user, permission),
    institutionKind,
    // Keyed on the role. A platform super admin holds every permission, so
    // the predicate above cannot distinguish them from an institution admin —
    // which is how the rail came to offer them seventeen links into
    // institutions they do not belong to.
    isPlatformUser(user),
  );

  // The full set of hrefs the shell will render. `NavLink` uses this to
  // decide "am I the most specific match for the current pathname?" — the
  // fix for the double-active-navigation bug where a parent link
  // (/dashboard/platform) stayed lit while the viewer was on a child that
  // is *also* a nav destination (/dashboard/platform/institutions).
  const siblingHrefs = sections.flatMap((section) => section.items.map((item) => item.href));

  // `print:hidden` for the same reason as the topbar: navigation links are not
  // part of a printed report, and on paper they cost a column.
  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-neutral-200 p-2 md:w-56 md:flex-col md:gap-4 md:overflow-x-visible md:border-r md:border-b-0 md:p-4 print:hidden"
    >
      {sections.map((section) => (
        <div key={section.group} className="flex shrink-0 gap-1 md:flex-col">
          <h2
            // Present for assistive technology at every width; drawn only where
            // there is room for it.
            className="sr-only px-2 pb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase md:not-sr-only"
          >
            {section.group}
          </h2>
          {section.items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              siblingHrefs={siblingHrefs}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
