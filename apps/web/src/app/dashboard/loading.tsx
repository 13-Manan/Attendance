import { PageSkeleton } from "@/components/ui/skeleton";

/**
 * The fallback for any staff page that is still fetching.
 *
 * It sits at the top of the segment, so it covers every route under
 * /dashboard that has not declared a more specific one. The shell around it —
 * topbar, sidebar, breadcrumbs — is already painted by the layout and does not
 * flicker; only the content area is replaced.
 */
export default function DashboardLoading() {
  return <PageSkeleton />;
}
