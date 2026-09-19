"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * What a route segment shows when its render threw.
 *
 * Shared by every `error.tsx` in the app so that a failure looks the same
 * wherever it happens, and so the rules below are decided once:
 *
 *  - **The message is never the exception.** In production Next replaces the
 *    error with a digest before it reaches the browser, and relying on
 *    `error.message` would mean a screen that reads usefully in development
 *    and says "An error occurred in the Server Components render" in front of
 *    a teacher. A written sentence and the digest is the honest pair: the
 *    digest is what correlates this screen with the server log.
 *  - **Retry first.** Most of what fails here is a database round trip during
 *    a deploy or a dropped connection, and `reset()` re-renders the segment
 *    without a full page load — which on the capture flow means not losing
 *    the tab's state.
 *  - **No claim about the cause.** It does not say the data is safe, or lost,
 *    or that anybody has been notified, because this component cannot know
 *    any of those things.
 */
export function ErrorState({
  error,
  reset,
  title = "Something went wrong",
  description = "This page could not be loaded. The problem has been logged. You can try again, or go back to the dashboard.",
  homeHref = "/dashboard",
  homeLabel = "Back to dashboard",
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  title?: string;
  description?: string;
  homeHref?: string;
  homeLabel?: string;
}) {
  useEffect(() => {
    // Client-side failures never reach the server log on their own. In
    // production the object is already stripped to a digest, so this records
    // the correlation handle rather than anything about a user's data.
    console.error("render failed", error);
  }, [error]);

  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-neutral-200 bg-white p-6 text-center sm:p-8"
    >
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-red-50 text-lg text-red-600"
      >
        !
      </span>
      <h1 className="text-base font-semibold text-neutral-900">{title}</h1>
      <p className="text-sm text-neutral-500">{description}</p>

      {error.digest ? (
        <p className="text-xs text-neutral-400">
          Reference: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {reset ? (
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        ) : null}
        <Link
          href={homeHref}
          className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50"
        >
          {homeLabel}
        </Link>
      </div>
    </div>
  );
}
