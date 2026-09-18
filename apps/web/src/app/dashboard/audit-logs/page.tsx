import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { AuditSearchError, searchAuditLogs } from "@/modules/audit/search";
import {
  AUDIT_MODULES,
  AUDIT_PAGE_SIZES,
  hasActiveAuditFilters,
  type AuditFilters,
} from "@/modules/audit/query";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/audit-logs";

/**
 * Builds a URL that keeps every filter and changes only what is named.
 *
 * Paging must not quietly drop a filter — a "next page" that widens the search
 * is how somebody concludes an event does not exist.
 */
function auditHref(filters: AuditFilters, overrides: Partial<Record<string, string | number>>) {
  const params = new URLSearchParams();
  const merged: Record<string, string | number> = {
    actorUserId: filters.actorUserId,
    action: filters.action,
    module: filters.module,
    from: filters.from,
    to: filters.to,
    entityType: filters.entityType,
    entityId: filters.entityId,
    page: filters.page,
    pageSize: filters.pageSize,
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    const text = String(value ?? "");
    if (text !== "") params.set(key, text);
  }
  const query = params.toString();
  return query ? `${BASE}?${query}` : BASE;
}

function formatTimestamp(value: Date): string {
  // Fixed, unambiguous, sortable. An audit timestamp rendered in a locale
  // format is a timestamp two people in the same room read differently.
  return value.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/**
 * Renders a before/after payload without pretending it is small.
 *
 * Inside a `<details>` so a hundred rows stay readable, and as formatted JSON
 * rather than a prose summary: this is the evidence, and a summary of evidence
 * is an interpretation. The values have already been through the redactor in
 * `search.ts`, so nothing here needs to decide what is safe to show.
 */
function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-neutral-500 hover:text-neutral-800">{label}</summary>
      <pre className="mt-1 max-w-full overflow-x-auto rounded bg-neutral-50 p-2 text-[11px] leading-relaxed text-neutral-700">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

/**
 * The institution audit trail.
 *
 * ## Five filters, because there are five questions
 *
 * Who, what, when, which part of the system, which record. Each one is a query
 * parameter and the whole screen is a GET form, so any search is a URL that
 * can be pasted into a ticket — which is what an audit search is usually for.
 * No client JavaScript: the filters submit, the pager is a link, and the
 * payloads open with `<details>`.
 *
 * ## What this page will not do
 *
 * Nothing on it writes. There is no edit control, no delete, no export of raw
 * rows through a second code path that might apply different redaction. The
 * log is read through one service with one permission, and the payloads are
 * redacted on the way out, so a secret that was mistakenly written into an
 * audit row three phases ago is not published to a browser today.
 *
 * ## Why the page size has a ceiling and no "all"
 *
 * `AuditLog` is indexed on `institutionId` and on `(entityType, entityId)`.
 * Nothing indexes action, actor or time, so an unbounded query over a busy
 * institution is a table scan that returns megabytes. Paging is the honest
 * constraint; see the doc comment in `modules/audit/query.ts`.
 */
export default async function AuditLogsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("auditLog.read");
  const params = await searchParams;

  // Array values (?action=a&action=b) collapse to the first: a repeated filter
  // is a bookmark artefact, and picking one is better than searching for a
  // value that is literally "a,b".
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") flat[key] = value;
    else if (Array.isArray(value) && value.length > 0) flat[key] = value[0];
  }

  let result;
  try {
    result = await searchAuditLogs(user, flat);
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/unauthorized");
    if (error instanceof AuditSearchError) {
      return <p className="text-sm text-neutral-500">{error.message}</p>;
    }
    throw error;
  }

  const { filters } = result;
  const filtered = hasActiveAuditFilters(filters);
  const firstRow = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const lastRow = Math.min(result.page * result.pageSize, result.total);

  const selectClass =
    "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500";
  const inputClass =
    "w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500";
  const labelClass = "flex flex-col gap-1 text-xs font-medium text-neutral-600";
  const linkClass =
    "rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50";
  const disabledClass =
    "rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-300";

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link href="/dashboard" className="text-xs text-neutral-500 hover:underline">
          ← Overview
        </Link>
        <h1 className="text-xl font-semibold text-neutral-900">Audit log</h1>
        <p className="text-xs text-neutral-500">
          Every security-sensitive action taken in this institution, by whom, and what changed.
          Records are written once and are never edited or deleted.
        </p>
      </header>

      <Panel
        title="Search"
        description="Filter by who acted, what they did, when, which part of the system, and which record."
      >
        <form method="get" action={BASE} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className={labelClass}>
              User
              <select name="actorUserId" defaultValue={filters.actorUserId} className={selectClass}>
                <option value="">Anyone, including API keys</option>
                {result.actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.name} ({actor.email})
                  </option>
                ))}
              </select>
            </label>

            <label className={labelClass}>
              Module
              <select name="module" defaultValue={filters.module} className={selectClass}>
                <option value="">Every module</option>
                {AUDIT_MODULES.map((module) => (
                  <option key={module.key} value={module.key}>
                    {module.label}
                  </option>
                ))}
              </select>
            </label>

            <label className={labelClass}>
              Action
              <select name="action" defaultValue={filters.action} className={selectClass}>
                <option value="">Every action</option>
                {AUDIT_MODULES.map((module) => (
                  <optgroup key={module.key} label={module.label}>
                    {module.actions.map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>

            <label className={labelClass}>
              From
              <input type="date" name="from" defaultValue={filters.from} className={inputClass} />
            </label>

            <label className={labelClass}>
              To
              <input type="date" name="to" defaultValue={filters.to} className={inputClass} />
            </label>

            <label className={labelClass}>
              Resource type
              <select name="entityType" defaultValue={filters.entityType} className={selectClass}>
                <option value="">Every resource</option>
                {result.entityTypes.map((entry) => (
                  <option key={entry.entityType} value={entry.entityType}>
                    {entry.entityType} ({entry.count.toLocaleString()})
                  </option>
                ))}
              </select>
            </label>

            <label className={labelClass}>
              Resource id
              <input
                type="text"
                name="entityId"
                defaultValue={filters.entityId}
                placeholder="e.g. the student or session id"
                className={inputClass}
              />
            </label>

            <label className={labelClass}>
              Rows per page
              <select name="pageSize" defaultValue={String(filters.pageSize)} className={selectClass}>
                {AUDIT_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              Search
            </button>
            {filtered ? (
              <Link href={BASE} className={linkClass}>
                Clear filters
              </Link>
            ) : null}
            <p className="text-xs tabular-nums text-neutral-500">
              {result.total === 0
                ? filtered
                  ? "No events match these filters."
                  : "No events recorded yet."
                : `Showing ${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${result.total.toLocaleString()}`}
            </p>
          </div>
        </form>
      </Panel>

      <Panel title="Events" description="Newest first. Times are UTC.">
        {result.entries.length === 0 ? (
          <EmptyState>
            {filtered
              ? "Nothing matched. Widen the date range or clear a filter — an empty result here means no matching record was written, not that the log is unavailable."
              : "No audit events have been recorded for this institution yet."}
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[54rem]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Resource</th>
                  <th className="py-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {result.entries.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-xs tabular-nums text-neutral-600">
                      {formatTimestamp(entry.createdAt)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-neutral-800">
                      {entry.actor.label}
                      {entry.ipAddress ? (
                        <span className="block text-[11px] text-neutral-400">
                          {entry.ipAddress}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <span className="font-mono text-neutral-900">{entry.action}</span>
                      <span className="block text-[11px] text-neutral-400">
                        {entry.moduleLabel}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-neutral-700">
                      <Link
                        href={auditHref(filters, {
                          entityType: entry.entityType,
                          entityId: entry.entityId,
                          page: 1,
                        })}
                        className="hover:underline"
                        title="Show every event for this record"
                      >
                        {entry.entityType}
                      </Link>
                      <span className="block font-mono text-[11px] text-neutral-400">
                        {entry.entityId}
                      </span>
                    </td>
                    <td className="py-2 text-xs">
                      <div className="flex flex-col gap-1">
                        <Payload label="Before" value={entry.before} />
                        <Payload label="After" value={entry.after} />
                        {entry.before == null && entry.after == null ? (
                          <span className="text-neutral-400">No payload recorded</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {result.totalPages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xs tabular-nums text-neutral-500">
              Page {result.page.toLocaleString()} of {result.totalPages.toLocaleString()}
            </p>
            <div className="flex gap-1">
              {result.page > 1 ? (
                <Link className={linkClass} href={auditHref(filters, { page: result.page - 1 })}>
                  Previous
                </Link>
              ) : (
                <span className={disabledClass}>Previous</span>
              )}
              {result.page < result.totalPages ? (
                <Link className={linkClass} href={auditHref(filters, { page: result.page + 1 })}>
                  Next
                </Link>
              ) : (
                <span className={disabledClass}>Next</span>
              )}
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
