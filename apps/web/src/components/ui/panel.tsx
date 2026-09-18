import type { ReactNode } from "react";

/**
 * The portal section container: a titled box with an optional action on the
 * right. Every dashboard on /portal and /dashboard is built from these, so a
 * layout fix lands in one place rather than five pages.
 *
 * The header wraps rather than truncates on narrow screens — a section title
 * that reads "Subject-wise atten…" on a phone is worse than one that takes
 * two lines.
 */
export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
          {description ? <p className="text-xs text-neutral-500">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * What a section says when it has nothing to show.
 *
 * Always a sentence, never a blank area: "no sessions today" and "we failed
 * to load your sessions" look identical if the empty state is nothing at all.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500">
      {children}
    </p>
  );
}
