import type { ReactNode } from "react";

/**
 * The canonical page wrapper.
 *
 * Every route under `/dashboard` and `/portal` renders inside a `<main>` that
 * already applies responsive edge padding. What this primitive adds is a
 * consistent inner column: a documented max-width at large viewports and a
 * vertical rhythm that matches the design system's spacing scale, so the same
 * page reads the same way whether the viewer is on a 390-wide phone or a
 * 1800-wide desktop.
 *
 * Future phases (Login, Platform, Institution Admin, Faculty, Student,
 * Attendance) should compose their page against this — the point is that no
 * page invents its own padding or column width, and a change to the master
 * rhythm lands in one place.
 *
 * `size`:
 *   - `narrow`  → up to 640px. Login, single-form pages.
 *   - `default` → up to 1024px. Portal, most dashboard detail pages.
 *   - `wide`    → up to 1440px. Admin tables, dashboards with side panels.
 *   - `full`    → no cap. Camera capture, print, edge-to-edge lists.
 *
 * `density`:
 *   - `standard` → default 24-32px vertical rhythm.
 *   - `dense`    → tighter for admin tables (~16-24px).
 *   - `spacious` → onboarding and empty hero surfaces (~40-64px).
 *
 * The component is a plain server component — no state, no client boundary,
 * no behavioural change on any existing page until that page opts in.
 */

type Size = "narrow" | "default" | "wide" | "full";
type Density = "standard" | "dense" | "spacious";

const MAX_WIDTH: Record<Size, string> = {
  narrow: "max-w-xl", // 576px approx — safe for a login card
  default: "max-w-5xl", // ~1024px
  wide: "max-w-screen-2xl", // ~1440px
  full: "max-w-none",
};

const VERTICAL_GAP: Record<Density, string> = {
  standard: "gap-6",
  dense: "gap-4",
  spacious: "gap-10",
};

export function PageContainer({
  size = "default",
  density = "standard",
  className = "",
  children,
}: {
  size?: Size;
  density?: Density;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`mx-auto flex w-full flex-col ${MAX_WIDTH[size]} ${VERTICAL_GAP[density]} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The title block sitting at the top of a page. Renders an `<h1>` at the size
 * documented as `--font-page-title`, with optional supporting copy and a
 * right-aligned action slot for the page's one primary action.
 *
 * Kept separate from `PageContainer` so pages that already ship their own
 * bespoke header (there are a few) are not forced to adopt this one.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900 sm:text-2xl">{title}</h1>
        {description ? (
          <p className="text-sm text-neutral-500">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

/**
 * A responsive multi-column section. Defaults to a single column on mobile
 * and two columns at `md`, extendable via `cols`.
 *
 * Purely a layout primitive — it holds no opinions about what the columns
 * contain, and every existing grid a page already uses continues to work.
 */
export function ResponsiveGrid({
  cols = { base: 1, md: 2 },
  gap = "gap-4",
  className = "",
  children,
}: {
  cols?: { base?: 1 | 2; md?: 2 | 3 | 4; lg?: 2 | 3 | 4; xl?: 3 | 4 | 6 };
  gap?: string;
  className?: string;
  children: ReactNode;
}) {
  const parts = [
    cols.base === 2 ? "grid-cols-2" : "grid-cols-1",
    cols.md ? `md:grid-cols-${cols.md}` : "",
    cols.lg ? `lg:grid-cols-${cols.lg}` : "",
    cols.xl ? `xl:grid-cols-${cols.xl}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={`grid ${parts} ${gap} ${className}`}>{children}</div>;
}
