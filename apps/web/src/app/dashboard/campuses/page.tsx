import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { listCampusesForRequest } from "@/modules/campuses/service";
import {
  applyCampusFilters,
  hasActiveCampusFilters,
  parseCampusFilters,
} from "@/modules/campuses/list-view";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";
import { CampusStatusControl } from "./campus-controls";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/campuses";

/**
 * The branches this institution operates from.
 *
 * Read-gated on `institution.read`; every control is write-gated on
 * `campus.manage` in the service, and this page renders the controls only when
 * the viewer holds it — a read-only viewer gets an honest list rather than a
 * row of buttons that all fail.
 *
 * ## Why the counts are on the list
 *
 * The only removal this screen offers is closure, and the decision to close a
 * branch depends entirely on what is attached to it. Putting the numbers in
 * the row means the confirmation sentence is not the first time anybody sees
 * them.
 *
 * ## Why the filters are a GET form
 *
 * The same reason the audit log's are: a filtered list is then a URL, and no
 * client JavaScript is needed to produce one. The narrowing itself happens in
 * `modules/campuses/list-view.ts`, which explains why it is in memory.
 */
export default async function CampusesPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no
        campuses to manage here.
      </p>
    );
  }

  const params = await searchParams;
  const filters = parseCampusFilters(params);
  const all = await listCampusesForRequest(user);
  const campuses = applyCampusFilters(all, filters);
  const filtered = hasActiveCampusFilters(filters);
  const canManage = hasPermission(user, "campus.manage");

  const open = all.filter((campus) => campus.isActive).length;
  const created = params.created === "1";
  const saved = params.saved === "1";

  const labelClass = "flex flex-col gap-1 text-xs font-medium text-neutral-600";
  const inputClass =
    "w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500";

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Campuses</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          The branches this institution operates from. Students, staff and classes can each belong
          to one, which is what lets a single institution run more than one site without its
          registers mixing.
        </p>
      </header>

      {created || saved ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {created ? "Campus added." : "Changes saved."}
        </p>
      ) : null}

      <Panel
        title="Find a campus"
        description="Search by name, code or address, and narrow by whether it is still open."
        action={
          canManage ? (
            <Link
              href={`${BASE}/new`}
              className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              Add campus
            </Link>
          ) : null
        }
      >
        <form method="get" action={BASE} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Search
              <input
                type="search"
                name="q"
                defaultValue={filters.q}
                placeholder="Name, code or address"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Status
              <Select name="status" defaultValue={filters.status} className="px-2.5 py-1.5">
                <option value="">Open and closed</option>
                <option value="open">Open only</option>
                <option value="closed">Closed only</option>
              </Select>
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
              <Link
                href={BASE}
                className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Clear filters
              </Link>
            ) : null}
            <p className="text-xs tabular-nums text-neutral-500">
              {all.length === 0
                ? "No campuses yet."
                : filtered
                  ? `${campuses.length} of ${all.length} shown`
                  : `${all.length} ${all.length === 1 ? "campus" : "campuses"}, ${open} open`}
            </p>
          </div>
        </form>
      </Panel>

      <Panel
        title="Campuses"
        description="Open campuses first. A closed one keeps all of its records and stops being offered when somebody is assigned a campus."
      >
        {campuses.length === 0 ? (
          <EmptyState>
            {all.length === 0 ? (
              canManage ? (
                <>
                  No campuses yet. If this institution operates from one site you do not need any —
                  add one only when there is a second place to tell apart.
                </>
              ) : (
                <>
                  No campuses have been added. Everyone here belongs to the institution as a whole.
                </>
              )
            ) : (
              <>Nothing matched. Clear the filters to see all {all.length} campuses.</>
            )}
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[46rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Campus</th>
                  <th className="py-2 pr-4 font-medium">Address</th>
                  <th className="py-2 pr-4 font-medium">Assigned</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  {canManage ? <th className="py-2 font-medium">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {campuses.map((campus) => (
                  <tr key={campus.id} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4">
                      <p className="text-sm font-medium text-neutral-900">{campus.name}</p>
                      <p className="font-mono text-xs text-neutral-500">{campus.code}</p>
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      {campus.address ?? <span className="text-neutral-400">Not recorded</span>}
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      <ul className="flex flex-col gap-0.5 text-xs tabular-nums">
                        <li>
                          {campus.studentCount.toLocaleString()}{" "}
                          {campus.studentCount === 1 ? "student" : "students"}
                        </li>
                        <li>
                          {campus.staffCount.toLocaleString()}{" "}
                          {campus.staffCount === 1 ? "staff member" : "staff"}
                        </li>
                        <li>
                          {campus.academicUnitCount.toLocaleString()}{" "}
                          {campus.academicUnitCount === 1 ? "class or unit" : "classes and units"}
                        </li>
                      </ul>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge tone={campus.isActive ? "positive" : "neutral"}>
                        {campus.isActive ? "Open" : "Closed"}
                      </Badge>
                    </td>
                    {canManage ? (
                      <td className="py-3">
                        <div className="flex flex-col items-start gap-2">
                          <Link
                            href={`${BASE}/${campus.id}/edit`}
                            className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
                          >
                            Edit
                          </Link>
                          <CampusStatusControl campus={campus} />
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
