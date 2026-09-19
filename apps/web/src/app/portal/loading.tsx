import { PageSkeleton } from "@/components/ui/skeleton";

/** The student portal's fallback. Fewer panels than the staff dashboard,
 *  because the portal has fewer — a placeholder promising sections that never
 *  arrive is its own small lie. */
export default function PortalLoading() {
  return <PageSkeleton stats={2} panels={2} />;
}
