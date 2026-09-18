import { logout } from "@/modules/auth-tenancy/actions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { SyncStatusBadge } from "@/components/offline/sync-status-badge";

export function Topbar({ user }: { user: SessionUser }) {
  const primaryRole = user.roles[0]?.name ?? "No role assigned";

  // `print:hidden` — app chrome is not part of a printed report. Affects the
  // print stylesheet only; the screen is unchanged.
  return (
    <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 sm:px-6 print:hidden">
      <span className="truncate text-sm font-semibold text-neutral-900">
        {/* Abbreviated on phones so the user's own name and the log-out
            control keep their space. */}
        <span className="sm:hidden">Attendance</span>
        <span className="hidden sm:inline">Attendance Platform</span>
      </span>
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        {/* Renders nothing while online with an empty queue, so the topbar is
            unchanged for everyone who never goes offline. */}
        <SyncStatusBadge />
        <div className="min-w-0 text-right">
          <p className="truncate text-sm font-medium text-neutral-900">{user.name}</p>
          <p className="truncate text-xs text-neutral-500">{primaryRole}</p>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
