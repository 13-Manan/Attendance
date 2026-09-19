import Link from "next/link";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasPermission } from "@/modules/authorization/service";
import { EmptyState, Panel } from "@/components/ui/panel";
import { buildQuickActions } from "./quick-actions";

/**
 * Permission filtering happens here, on the server, so no session crosses into
 * the browser to do it — the same arrangement as `Sidebar`.
 */
export function QuickActionsPanel({
  user,
  institutionKind,
}: {
  user: SessionUser;
  institutionKind: "SCHOOL" | "COLLEGE" | null;
}) {
  const actions = buildQuickActions(
    (permission) => hasPermission(user, permission),
    institutionKind,
  );

  return (
    <Panel title="Quick actions">
      {actions.length === 0 ? (
        // Reachable: a role can legitimately hold none of these — a read-only
        // auditor, for instance. Saying so is better than an empty box that
        // reads as a section which failed to load.
        <EmptyState>
          Your role doesn&apos;t include any of these actions. Everything you can
          reach is in the navigation.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {actions.map((action) => (
            <li key={action.href}>
              <Link
                href={action.href}
                className="flex h-full flex-col gap-1 rounded-md border border-neutral-200 p-3 transition-colors hover:bg-neutral-50"
              >
                <span className="text-sm font-medium text-neutral-900">{action.label}</span>
                <span className="text-xs text-neutral-500">{action.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
