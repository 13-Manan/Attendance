"use client";

import { ErrorState } from "@/components/ui/error-state";

/** A student's failure screen points back at the portal, not the staff
 *  dashboard — which they cannot open. */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorState
      error={error}
      reset={reset}
      description="Your attendance could not be loaded. You can try again, or go back to the overview."
      homeHref="/portal"
      homeLabel="Back to my attendance"
    />
  );
}
