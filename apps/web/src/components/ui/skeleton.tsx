/**
 * Loading placeholders.
 *
 * Every skeleton in here is `aria-hidden` and sits inside a container that
 * announces "Loading" once. A screen reader should hear that the page is
 * loading, not a description of fourteen grey rectangles.
 *
 * The shapes deliberately echo the real layout — a stat row above stacked
 * panels — so the page does not visibly rearrange itself the moment the data
 * lands. A spinner would be less code and a worse answer: it says "something
 * is happening" where this says "the thing you asked for is nearly here".
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-neutral-200 ${className}`} />;
}

function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:p-5">
      <Skeleton className="h-4 w-40" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}

/** The generic "a page under this section is loading" placeholder. */
export function PageSkeleton({ stats = 4, panels = 2 }: { stats?: number; panels?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex w-full max-w-5xl flex-col gap-5">
      <span className="sr-only">Loading…</span>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-3 w-40" />
      </div>

      {stats > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: stats }, (_, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-4"
            >
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-12" />
            </div>
          ))}
        </div>
      ) : null}

      {Array.from({ length: panels }, (_, index) => (
        <PanelSkeleton key={index} />
      ))}
    </div>
  );
}
