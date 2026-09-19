"use client";

import { ErrorState } from "@/components/ui/error-state";

/**
 * Catches a failed render anywhere under /dashboard that has not declared its
 * own boundary. The layout survives — topbar, sidebar and breadcrumbs stay —
 * so a failure on one screen does not strand the user with no navigation.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
