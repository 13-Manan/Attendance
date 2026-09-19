"use client";

import { ErrorState } from "@/components/ui/error-state";

/**
 * The outermost route-level boundary — everything not caught by a closer one,
 * which in practice means the public pages (`/`, `/login`, `/unauthorized`).
 *
 * It sends the reader home rather than to the dashboard: whoever is looking at
 * this may well not be signed in, and offering a signed-in destination to
 * somebody without a session just produces a second redirect.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <ErrorState
        error={error}
        reset={reset}
        description="This page could not be loaded. The problem has been logged. You can try again, or go back to the start."
        homeHref="/"
        homeLabel="Go to the homepage"
      />
    </main>
  );
}
