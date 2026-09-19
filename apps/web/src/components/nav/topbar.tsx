import type { SessionUser } from "@/modules/auth-tenancy/types";
import { SyncStatusBadge } from "@/components/offline/sync-status-badge";
import { UserMenu } from "./user-menu";

/**
 * The top bar: product, institution context, sync state, account.
 *
 * The institution name sits next to the product name because "which tenant am
 * I in?" is a question a user of a multi-institution platform should never
 * have to guess at — and because seeing the wrong one is how somebody notices
 * a mistake before acting on it. It is read from the server session
 * (`user.institutionId` -> the institution row), never from anything the
 * client could set.
 *
 * Only the four fields the menu displays are handed to the client component;
 * the session's permission lists stay on the server, where the pages that use
 * them run.
 */
export function Topbar({
  user,
  institutionName = null,
}: {
  user: SessionUser;
  /** `null` for a platform-level account, which is not one institution's. */
  institutionName?: string | null;
}) {
  // `print:hidden` — app chrome is not part of a printed report. Affects the
  // print stylesheet only; the screen is unchanged.
  return (
    <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 sm:px-6 print:hidden">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-neutral-900">
          {/* Abbreviated on phones so the account control keeps its space. */}
          <span className="sm:hidden">Attendance</span>
          <span className="hidden sm:inline">Attendance Platform</span>
        </span>
        {institutionName ? (
          <span className="truncate text-xs text-neutral-500">{institutionName}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        {/* Renders nothing while online with an empty queue, so the topbar is
            unchanged for everyone who never goes offline. */}
        <SyncStatusBadge />
        <UserMenu
          name={user.name}
          email={user.email}
          roleNames={user.roles.map((role) => role.name)}
          institutionName={institutionName}
        />
      </div>
    </header>
  );
}
