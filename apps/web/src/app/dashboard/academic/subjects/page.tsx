import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  listSubjectsForRequest,
  subjectsApplyForRequest,
} from "@/modules/subjects/directory-service";
import {
  NOT_OFFERED,
  OFFERED,
  SUBJECT_SORTS,
  hasActiveSubjectFilters,
  parseSubjectFilters,
  subjectFilterQuery,
} from "@/modules/subjects/directory-filters";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/academic/subjects";

/**
 * The subjects a college teaches.
 *
 * ## Why a school sees a sentence instead
 *
 * A school takes one register a day for a whole class; it has no subjects at
 * all, and the service refuses to create one. Showing a school an empty table
 * with a button that always fails would be a worse lie than saying so.
 *
 * ## Why the filters are a GET form
 *
 * A filtered list is then a URL, which can be bookmarked and sent to a
 * colleague, and no client JavaScript is needed to produce one. The form
 * deliberately does not carry the page number, so a new search starts at the
 * first page rather than at page 7 of a list that now has two.
 *
 * Gated on `academicStructure.manage`, the existing gate on this section.
 */
export default async function SubjectsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no subjects
        here.
      </p>
    );
  }

  const applies = await subjectsApplyForRequest(user);
  if (!applies) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">Subjects</h2>
        <p className="text-sm text-neutral-500">
          Subjects belong to colleges. A school takes one register a day for the whole class, so
          there is nothing here to set up — attendance is taken against the class itself.
        </p>
        <Link
          href="/dashboard/academic/cohorts"
          className="text-sm text-neutral-600 underline hover:text-neutral-900"
        >
          Go to classes
        </Link>
      </div>
    );
  }

  const params = await searchParams;
  const filters = parseSubjectFilters(params);
  const page = await listSubjectsForRequest(user, filters);

  const filtered = hasActiveSubjectFilters(filters);
  const firstOnPage = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const lastOnPage = Math.min(page.page * page.pageSize, page.total);

  const labelClass = "flex flex-col gap-1 text-xs font-medium text-neutral-600";
  const inputClass =
    "w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500";
  const pagerClass =
    "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50";

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-900">Subjects</h2>
        <p className="max-w-3xl text-sm text-neutral-500">
          Every subject the college teaches. A section offers some of them, and a register is taken
          per subject — which subjects a section offers, and who teaches each one, is set on the
          section itself.
        </p>
      </header>

      {params.created === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Subject added. Attach it to the sections that teach it from each section&apos;s page.
        </p>
      ) : null}
      {params.saved === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Saved.
        </p>
      ) : null}

      <Panel
        title="Find a subject"
        description="Search by code or by name."
        action={
          <Link
            href={`${BASE}/new`}
            className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            New subject
          </Link>
        }
      >
        <form method="get" action={BASE} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className={labelClass}>
              Search
              <input
                type="search"
                name="q"
                defaultValue={filters.q}
                placeholder="PHY301, Quantum"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Taught anywhere
              <Select name="offered" defaultValue={filters.offered} className="px-2.5 py-1.5">
                <option value="">Offered or not</option>
                <option value={OFFERED}>Offered by a section</option>
                <option value={NOT_OFFERED}>Offered by nobody</option>
              </Select>
            </label>
            <label className={labelClass}>
              Sort by
              <Select name="sort" defaultValue={filters.sort} className="px-2.5 py-1.5">
                {SUBJECT_SORTS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
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
              {page.totalAll === 0
                ? "No subjects yet."
                : filtered
                  ? `${page.total.toLocaleString()} of ${page.totalAll.toLocaleString()} match`
                  : `${page.totalAll.toLocaleString()} ${page.totalAll === 1 ? "subject" : "subjects"}, ${page.unusedAll.toLocaleString()} offered by nobody`}
            </p>
          </div>
        </form>
      </Panel>

      <Panel
        title="Subjects"
        description={
          page.total === 0
            ? "Nothing to show."
            : `Showing ${firstOnPage.toLocaleString()}–${lastOnPage.toLocaleString()} of ${page.total.toLocaleString()}.`
        }
      >
        {page.rows.length === 0 ? (
          <EmptyState>
            {page.totalAll === 0 ? (
              <>
                No subjects yet. Add the ones the college teaches, then attach each to the sections
                that take it — a register cannot be opened for a subject a section does not offer.
              </>
            ) : (
              <>
                Nothing matched. Clear the filters to see all {page.totalAll.toLocaleString()}{" "}
                subjects.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <TableScroll minWidth="min-w-[40rem]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Code</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Offered by</th>
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((subject) => (
                    <tr key={subject.id} className="border-b border-neutral-100 align-top">
                      <td className="py-3 pr-4 text-sm font-medium text-neutral-900">
                        {subject.code}
                      </td>
                      <td className="py-3 pr-4 text-sm text-neutral-600">{subject.name}</td>
                      <td className="py-3 pr-4 text-sm tabular-nums text-neutral-600">
                        {subject.cohortCount === 0 ? (
                          // Amber rather than grey: a subject nobody offers is
                          // not a neutral fact, it is a subject no register can
                          // be taken for.
                          <span className="text-amber-700">Nobody</span>
                        ) : (
                          <>
                            {subject.cohortCount.toLocaleString()}
                            <span className="block text-xs text-neutral-400">
                              {subject.cohortCount === 1 ? "section" : "sections"}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="py-3">
                        <Link
                          href={`${BASE}/${subject.id}/edit`}
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

            {page.pageCount > 1 ? (
              <nav
                aria-label="Subject pages"
                className="mt-3 flex flex-wrap items-center justify-between gap-2"
              >
                {/* Links rather than buttons: a page of a list is a place, and a
                    reader should be able to open page 3 in a new tab or come
                    back to it from history. */}
                {page.page > 1 ? (
                  <Link
                    href={`${BASE}${subjectFilterQuery(filters, { page: page.page - 1 })}`}
                    className={pagerClass}
                  >
                    ← Previous
                  </Link>
                ) : (
                  <span className="px-3 py-2 text-sm text-neutral-400">← Previous</span>
                )}
                <p className="text-xs tabular-nums text-neutral-500">
                  Page {page.page} of {page.pageCount}
                </p>
                {page.page < page.pageCount ? (
                  <Link
                    href={`${BASE}${subjectFilterQuery(filters, { page: page.page + 1 })}`}
                    className={pagerClass}
                  >
                    Next →
                  </Link>
                ) : (
                  <span className="px-3 py-2 text-sm text-neutral-400">Next →</span>
                )}
              </nav>
            ) : null}
          </>
        )}
      </Panel>

      <p className="text-xs text-neutral-500">
        A subject cannot be deleted. It is what a register is filed against, and removing one would
        take that attendance with it — a subject added by mistake is left offered by nobody.
      </p>
    </div>
  );
}
