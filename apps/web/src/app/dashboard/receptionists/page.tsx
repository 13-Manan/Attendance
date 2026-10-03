import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { formatInTimeZone } from "@/modules/attendance-today/policy";
import { getInstitutionById } from "@/modules/institutions/repository";
import { listReceptionists } from "@/modules/receptionists/service";
import { ReceptionistError, type ReceptionistSummary } from "@/modules/receptionists/types";
import { EmptyState, Panel } from "@/components/ui/panel";
import { AccountActions, AddReceptionistForm } from "./receptionist-controls";
import { AccessLine, StatusBadge } from "./shared";

/**
 * Receptionists — the principal's list.
 *
 * Gated on `role.assign`, the same authority the service checks on every
 * read and write: giving somebody access is the principal's to do, and a
 * receptionist can never be granted it, so nobody they create can create
 * more. The page is presentation; the service decides the school (always the
 * viewer's own), the account and the access.
 *
 * No password appears here except the one just issued, in the action's reply
 * — staff passwords are never stored readably.
 */

const LINK =
  "inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-neutral-700 underline-offset-4 hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900";

export default async function ReceptionistsPage() {
  const user = await requirePermissionOrRedirect("role.assign");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single school, so there are no receptionists here.
      </p>
    );
  }

  let receptionists: ReceptionistSummary[];
  try {
    receptionists = await listReceptionists(user);
  } catch (error) {
    if (!(error instanceof ReceptionistError)) throw error;
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Receptionists</h1>
        <Panel title="Not available here">
          <EmptyState>{error.message}</EmptyState>
        </Panel>
      </div>
    );
  }

  const institution = await getInstitutionById(user.institutionId);
  const when = (at: Date) =>
    formatInTimeZone(
      at,
      institution?.timezone,
      { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
      "en-GB",
    );
  const active = receptionists.filter((receptionist) => receptionist.status === "ACTIVE").length;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">People</span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Receptionists</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Front-office accounts for this school. You choose what each one can do, and can change it, reset their
          password or switch the account off at any time.
        </p>
      </header>

      <Panel
        title="Add a receptionist"
        description="They get a temporary password to sign in with, and choose their own straight away."
      >
        <AddReceptionistForm />
      </Panel>

      <Panel
        title="Receptionist accounts"
        description={
          receptionists.length === 0
            ? undefined
            : `${receptionists.length} ${receptionists.length === 1 ? "account" : "accounts"} · ${active} active`
        }
      >
        {receptionists.length === 0 ? (
          <EmptyState>No receptionists yet. Add one above.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {receptionists.map((receptionist) => {
              const href = `/dashboard/receptionists/${receptionist.id}`;
              return (
                <li
                  key={receptionist.id}
                  className="grid gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_auto] lg:items-start lg:gap-6"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={href}
                        className="inline-flex min-h-11 items-center rounded-sm text-base font-semibold text-neutral-900 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900"
                      >
                        {receptionist.name}
                      </Link>
                      <StatusBadge receptionist={receptionist} />
                    </div>
                    <span className="break-all text-sm text-neutral-600">{receptionist.email}</span>
                    <span className="text-xs text-neutral-500">
                      {receptionist.lastLoginAt
                        ? `Last signed in ${when(receptionist.lastLoginAt)}`
                        : "Never signed in"}{" "}
                      · added {when(receptionist.createdAt)}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 lg:sr-only">
                      Access
                    </span>
                    <AccessLine access={receptionist.access} />
                    <div className="flex flex-wrap gap-x-5">
                      <Link href={href} className={LINK}>
                        View
                      </Link>
                      <Link href={`${href}#details`} className={LINK}>
                        Edit
                      </Link>
                      <Link href={`${href}#access`} className={LINK}>
                        Permissions
                      </Link>
                    </div>
                  </div>
                  <AccountActions
                    receptionistId={receptionist.id}
                    name={receptionist.name}
                    active={receptionist.status === "ACTIVE"}
                    compact
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
