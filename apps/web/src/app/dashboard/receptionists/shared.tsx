import { ACCESS_ITEMS, accessSummary } from "@/modules/receptionists/catalog";
import type { ReceptionistSummary } from "@/modules/receptionists/types";
import { Badge } from "@/components/ui/badge";

/** Pieces both Receptionists pages draw the same way. */

const SENSITIVE = new Set(ACCESS_ITEMS.filter((item) => item.confirm).map((item) => item.id));

export function StatusBadge({ receptionist }: { receptionist: ReceptionistSummary }) {
  if (receptionist.status === "INACTIVE") return <Badge tone="neutral">Disabled</Badge>;
  if (receptionist.mustChangePassword) return <Badge tone="warning">Temporary password</Badge>;
  return <Badge tone="positive">Active</Badge>;
}

export function AccessLine({ access }: { access: readonly string[] }) {
  const groups = accessSummary(access).filter((entry) => entry.on > 0);
  const sensitive = access.filter((id) => SENSITIVE.has(id)).length;
  if (groups.length === 0) return <span className="text-sm text-neutral-500">No access switched on</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-700">
      <span>
        {groups.map((entry) => `${entry.group.label} ${entry.on}/${entry.of}`).join(" · ")}
      </span>
      {sensitive > 0 ? <Badge tone="warning">{sensitive} sensitive on</Badge> : null}
    </span>
  );
}
