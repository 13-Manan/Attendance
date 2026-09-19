import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  getUnitFormOptionsForRequest,
  listUnitsForRequest,
} from "@/modules/academic-structure/directory-service";
import { flattenUnitTree } from "@/modules/academic-structure/directory-tree";
import { STRUCTURE_WORDS } from "@/modules/academic-structure/directory-types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/academic/units";

/**
 * The academic structure: the shelf everything else is filed on.
 *
 * Shown as a tree flattened into a table, rather than paginated. A tree cannot
 * be cut at row 25 without orphaning what follows, and the ceiling here is the
 * number of departments and semesters an institution actually has — hundreds,
 * not the hundreds of thousands the class list can reach. The indent is the
 * nesting; the counts are what is already filed underneath.
 *
 * Gated on `academicStructure.manage`, which is the existing gate on this
 * section and on the read below it.
 */
export default async function AcademicUnitsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no structure
        here.
      </p>
    );
  }

  const query = await searchParams;
  const [tree, options] = await Promise.all([
    listUnitsForRequest(user),
    getUnitFormOptionsForRequest(user),
  ]);

  const rows = flattenUnitTree(tree);
  const words = STRUCTURE_WORDS[options.institutionType];
  const hasCampuses = options.campuses.length > 0;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-900">{words.title}</h2>
        <p className="max-w-3xl text-sm text-neutral-500">{words.description}</p>
      </header>

      {query.created === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Added to the structure. Classes can now be created underneath it.
        </p>
      ) : null}
      {query.saved === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Saved.
        </p>
      ) : null}

      <Panel
        title={words.title}
        description={
          rows.length === 0
            ? "Nothing yet."
            : `${rows.length.toLocaleString()} ${rows.length === 1 ? "entry" : "entries"}, nested as they are organised.`
        }
        action={
          <Link
            href={`${BASE}/new`}
            className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Add
          </Link>
        }
      >
        {rows.length === 0 ? (
          <EmptyState>
            Nothing has been set up yet. Start with{" "}
            {options.institutionType === "COLLEGE"
              ? "a department, then the semesters inside it"
              : "a grade, then the sections inside it"}
            . Classes are created underneath, one per academic year.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[48rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Kind</th>
                  {hasCampuses ? <th className="py-2 pr-4 font-medium">Campus</th> : null}
                  <th className="py-2 pr-4 font-medium">Classes</th>
                  <th className="py-2 pr-4 font-medium">Order</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((unit) => (
                  <tr key={unit.id} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4">
                      {/* The indent is the nesting. Padding rather than a
                          character, so a screen reader is not made to read
                          "dash dash Semester 3". */}
                      <div style={{ paddingLeft: unit.depth * 16 }}>
                        <p className="text-sm font-medium text-neutral-900">{unit.name}</p>
                        {unit.code ? (
                          <p className="text-xs text-neutral-500">{unit.code}</p>
                        ) : null}
                        {unit.childCount > 0 ? (
                          <p className="text-xs text-neutral-400">
                            {unit.childCount.toLocaleString()} inside
                          </p>
                        ) : null}
                        {unit.facultyCount > 0 ? (
                          <p className="text-xs text-neutral-400">
                            {unit.facultyCount.toLocaleString()} staff
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge tone="neutral">{options.labels[unit.kind] ?? unit.kind}</Badge>
                    </td>
                    {hasCampuses ? (
                      <td className="py-3 pr-4 text-sm text-neutral-600">
                        {unit.campusName ?? <span className="text-neutral-400">—</span>}
                      </td>
                    ) : null}
                    <td className="py-3 pr-4 text-sm tabular-nums text-neutral-600">
                      {unit.cohortCount.toLocaleString()}
                    </td>
                    <td className="py-3 pr-4 text-sm tabular-nums text-neutral-500">
                      {unit.sortOrder}
                    </td>
                    <td className="py-3">
                      <Link
                        href={`${BASE}/${unit.id}/edit`}
                        className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <p className="text-xs text-neutral-500">
        Nothing here can be deleted. A grade or a department is what a year of attendance is filed
        against, and removing one would take the registers with it — something set up by mistake is
        left in place with nothing underneath it.
      </p>
    </div>
  );
}
