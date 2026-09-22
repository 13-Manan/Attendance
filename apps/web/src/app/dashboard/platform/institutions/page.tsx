import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { listInstitutions } from "@/modules/platform/service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Every institution on the deployment.
 *
 * Server-side search, filtering and paging — the list grows with the business,
 * and a client-side filter over "all institutions" is a query that works on
 * the demo and falls over on the customer. `listInstitutions` caps the page at
 * 100 rows whatever the URL asks for.
 *
 * The filters are a GET form, following `/dashboard/reports`: the URL is the
 * state, so a filtered list is a real link somebody can send to a colleague.
 */
export const dynamic = "force-dynamic";

function one(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function PlatformInstitutionsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("platform.institution.create");
  const params = await searchParams;

  const search = one(params, "q");
  const typeParam = one(params, "type");
  const statusParam = one(params, "status");
  const offset = Math.max(0, Number(one(params, "offset")) || 0);

  const page = await listInstitutions(
    user,
    {
      search: search || undefined,
      type: typeParam === "SCHOOL" || typeParam === "COLLEGE" ? typeParam : undefined,
      status: statusParam === "active" || statusParam === "suspended" ? statusParam : undefined,
    },
    { limit: 25, offset },
  );

  const pageHref = (nextOffset: number) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (typeParam) query.set("type", typeParam);
    if (statusParam) query.set("status", statusParam);
    if (nextOffset > 0) query.set("offset", String(nextOffset));
    const suffix = query.toString();
    return `/dashboard/platform/institutions${suffix ? `?${suffix}` : ""}`;
  };

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard/platform"
            className="w-fit text-xs text-neutral-500 hover:text-neutral-900 hover:underline"
          >
            ← Platform
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            Institutions
          </h1>
          <p className="text-sm text-neutral-500">
            {page.total} institution{page.total === 1 ? "" : "s"} on this deployment.
          </p>
        </div>
        <Link href="/dashboard/platform/institutions/new" className="shrink-0">
          <Button type="button" className="w-full sm:w-auto">
            + Add institution
          </Button>
        </Link>
      </header>

      <Panel
        title="Filter"
        description="Search, type and status compose into the URL — a filtered view is a shareable link."
      >
        <form method="get" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-neutral-600">Name contains</span>
              <Input
                type="search"
                name="q"
                defaultValue={search}
                placeholder="Greenwood"
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-neutral-600">Type</span>
              <Select name="type" defaultValue={typeParam}>
                <option value="">All types</option>
                <option value="SCHOOL">School</option>
                <option value="COLLEGE">College</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-neutral-600">Status</span>
              <Select name="status" defaultValue={statusParam}>
                <option value="">Any status</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">Apply filters</Button>
            {search || typeParam || statusParam ? (
              <Link href="/dashboard/platform/institutions">
                <Button type="button" variant="secondary">
                  Clear
                </Button>
              </Link>
            ) : null}
          </div>
        </form>
      </Panel>

      <Panel
        title="All institutions"
        description={
          page.total === 0
            ? "Nothing matched."
            : `Showing ${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}.`
        }
      >
        {page.rows.length === 0 ? (
          <EmptyState>
            {search || typeParam || statusParam
              ? "No institution matches these filters."
              : "No institution has been created yet."}
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[44rem]">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Institutions on this deployment</caption>
              <thead className="bg-neutral-50">
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th scope="col" className="py-2.5 pr-4 pl-3 font-medium">Institution</th>
                  <th scope="col" className="py-2.5 pr-4 font-medium">Type</th>
                  <th scope="col" className="py-2.5 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2.5 pr-4 text-right font-medium">Users</th>
                  <th scope="col" className="py-2.5 pr-4 text-right font-medium">Students</th>
                  <th scope="col" className="py-2.5 pr-3 text-right font-medium">Classes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {page.rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-neutral-50">
                    <td className="py-3 pr-4 pl-3 text-sm">
                      <Link
                        href={`/dashboard/platform/institutions/${row.id}`}
                        className="font-medium text-neutral-900 hover:underline"
                      >
                        {row.name}
                      </Link>
                      {row.contactEmail ? (
                        <span className="block text-xs text-neutral-500">{row.contactEmail}</span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      {row.type === "COLLEGE" ? "College" : "School"}
                    </td>
                    <td className="py-3 pr-4 text-sm">
                      {row.suspendedAt ? (
                        <Badge tone="warning">Suspended</Badge>
                      ) : (
                        <Badge tone="positive">Active</Badge>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right text-sm tabular-nums text-neutral-700">
                      {row.counts.users}
                    </td>
                    <td className="py-3 pr-4 text-right text-sm tabular-nums text-neutral-700">
                      {row.counts.students}
                    </td>
                    <td className="py-3 pr-3 text-right text-sm tabular-nums text-neutral-700">
                      {row.counts.cohorts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {(page.offset > 0 || page.hasMore) && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <span className="text-xs tabular-nums text-neutral-500">
              Page {Math.floor(page.offset / page.limit) + 1}
            </span>
            <div className="flex items-center gap-2">
              {page.offset > 0 ? (
                <Link href={pageHref(Math.max(0, page.offset - page.limit))}>
                  <Button type="button" variant="secondary">
                    ← Previous
                  </Button>
                </Link>
              ) : null}
              {page.hasMore ? (
                <Link href={pageHref(page.offset + page.limit)}>
                  <Button type="button" variant="secondary">
                    Next →
                  </Button>
                </Link>
              ) : null}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
