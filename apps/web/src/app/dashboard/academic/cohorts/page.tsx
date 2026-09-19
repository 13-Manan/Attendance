import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import {
  getCohortFormOptionsForRequest,
  listCohortsForRequest,
} from "@/modules/cohorts/directory-service";
import {
  ANY_TEACHER,
  COHORT_SORTS,
  NO_TEACHER,
  cohortFilterQuery,
  hasActiveCohortFilters,
  parseCohortFilters,
} from "@/modules/cohorts/directory-filters";
import {
  COHORT_FACULTY_ROLE_LABEL,
  COHORT_WORDS,
  type CohortListRow,
} from "@/modules/cohorts/directory-types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/academic/cohorts";

function TeacherCell({ cohort }: { cohort: CohortListRow }) {
  if (cohort.teachers.length === 0) {
    // Amber rather than grey: a class with nobody attached is not a neutral
    // fact, it is a class whose register cannot be opened.
    return <span className="text-sm text-amber-700">Nobody assigned</span>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {cohort.teachers.map((teacher) => (
        <li key={teacher.linkId} className="text-sm text-neutral-600">
          {teacher.name}
          <span className="block text-xs text-neutral-400">
            {COHORT_FACULTY_ROLE_LABEL[teacher.role]}
            {teacher.accountStatus === "ACTIVE" ? "" : " · account stopped"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The classes a register can be taken for.
 *
 * ## Why this list is narrowed in SQL
 *
 * Classes multiply: a college with forty departments, eight semesters and three
 * sections has nearly a thousand in one year, and every past year is kept
 * because the attendance under it has to stay readable. So the search, the
 * filters, the ordering and the paging all happen in the database — see
 * `modules/cohorts/directory-filters.ts`, which also explains why the campus
 * list does the opposite.
 *
 * ## Why the filters are a GET form
 *
 * A filtered list is then a URL, which can be bookmarked and sent to a
 * colleague, and no client JavaScript is needed to produce one. The form
 * deliberately does not carry the page number, so a new search starts at the
 * first page rather than at page 7 of a list that now has two.
 *
 * Read-gated on `cohort.read`; the create and edit controls are gated on
 * `cohort.manage` and rendered only when the viewer holds it.
 */
export default async function CohortsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("cohort.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no classes
        here.
      </p>
    );
  }

  const params = await searchParams;
  const filters = parseCohortFilters(params);
  const [page, options] = await Promise.all([
    listCohortsForRequest(user, filters),
    getCohortFormOptionsForRequest(user),
  ]);

  const words = COHORT_WORDS[options.institutionType];
  const isCollege = options.institutionType === "COLLEGE";
  const filtered = hasActiveCohortFilters(filters);
  const canManage = hasPermission(user, "cohort.manage");

  const firstOnPage = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const lastOnPage = Math.min(page.page * page.pageSize, page.total);

  const labelClass = "flex flex-col gap-1 text-xs font-medium text-neutral-600";
  const inputClass =
    "w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500";
  const pagerClass =
    "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50";

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-900">{words.Plural}</h2>
        <p className="max-w-3xl text-sm text-neutral-500">
          {isCollege
            ? "A section of a semester, for one academic year. Registers are taken per subject, so each section carries the subjects it is offered and who teaches them."
            : "A class for one academic year — the group a daily register is taken for. Students are placed in one, and a class teacher takes the register."}
        </p>
      </header>

      <Panel
        title={`Find a ${words.singular}`}
        description="Search by name, term, the part of the structure it sits in, or the academic year."
        action={
          canManage ? (
            <Link
              href={`${BASE}/new`}
              className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
            >
              New {words.singular}
            </Link>
          ) : null
        }
      >
        <form method="get" action={BASE} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className={labelClass}>
              Search
              <input
                type="search"
                name="q"
                defaultValue={filters.q}
                placeholder="8-A, Term 1, Physics"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Academic year
              <Select name="sessionId" defaultValue={filters.sessionId} className="px-2.5 py-1.5">
                <option value="">Every year</option>
                {options.sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                    {session.isCurrent ? " (current)" : ""}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Part of the structure
              <Select name="unitId" defaultValue={filters.unitId} className="px-2.5 py-1.5">
                <option value="">Anywhere</option>
                {options.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                    {unit.code ? ` (${unit.code})` : ""} — {unit.kind.toLowerCase()}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Teacher
              <Select name="teacher" defaultValue={filters.teacher} className="px-2.5 py-1.5">
                <option value="">Assigned or not</option>
                <option value={NO_TEACHER}>Nobody assigned</option>
                <option value={ANY_TEACHER}>Somebody assigned</option>
              </Select>
            </label>
            <label className={labelClass}>
              Sort by
              <Select name="sort" defaultValue={filters.sort} className="px-2.5 py-1.5">
                {COHORT_SORTS.map((option) => (
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
                ? `No ${words.plural} yet.`
                : filtered
                  ? `${page.total.toLocaleString()} of ${page.totalAll.toLocaleString()} match`
                  : `${page.totalAll.toLocaleString()} ${page.totalAll === 1 ? words.singular : words.plural}, ${page.currentYearAll.toLocaleString()} in the current year`}
            </p>
          </div>
        </form>
      </Panel>

      <Panel
        title={words.Plural}
        description={
          page.total === 0
            ? "Nothing to show."
            : `Showing ${firstOnPage.toLocaleString()}–${lastOnPage.toLocaleString()} of ${page.total.toLocaleString()}.`
        }
      >
        {page.rows.length === 0 ? (
          <EmptyState>
            {page.totalAll === 0 ? (
              canManage ? (
                <>
                  No {words.plural} yet. A {words.singular} needs somewhere to sit in the structure
                  and an academic year to belong to — create those first if they are not there.
                </>
              ) : (
                <>No {words.plural} have been created yet.</>
              )
            ) : (
              <>
                Nothing matched. Clear the filters to see all {page.totalAll.toLocaleString()}{" "}
                {words.plural}.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <TableScroll minWidth="min-w-[56rem]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">{words.Singular}</th>
                    <th className="py-2 pr-4 font-medium">Academic year</th>
                    <th className="py-2 pr-4 font-medium">Students</th>
                    <th className="py-2 pr-4 font-medium">Teachers</th>
                    {isCollege ? <th className="py-2 pr-4 font-medium">Subjects</th> : null}
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((cohort) => (
                    <tr key={cohort.id} className="border-b border-neutral-100 align-top">
                      <td className="py-3 pr-4">
                        <Link
                          href={`${BASE}/${cohort.id}`}
                          className="text-sm font-medium text-neutral-900 hover:underline"
                        >
                          {cohort.name}
                        </Link>
                        <p className="text-xs text-neutral-500">
                          {cohort.academicUnitName}
                          {cohort.academicUnitCode ? ` (${cohort.academicUnitCode})` : ""}
                        </p>
                        {cohort.termLabel ? (
                          <p className="text-xs text-neutral-400">{cohort.termLabel}</p>
                        ) : null}
                        {cohort.campusName ? (
                          <p className="text-xs text-neutral-400">{cohort.campusName}</p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4">
                        <p className="text-sm text-neutral-600">{cohort.academicSessionName}</p>
                        {cohort.academicSessionIsCurrent ? (
                          <Badge tone="positive">Current year</Badge>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-sm tabular-nums text-neutral-600">
                        {cohort.studentCount.toLocaleString()}
                        <span className="block text-xs text-neutral-400">on roll</span>
                      </td>
                      <td className="py-3 pr-4">
                        <TeacherCell cohort={cohort} />
                      </td>
                      {isCollege ? (
                        <td className="py-3 pr-4 text-sm tabular-nums text-neutral-600">
                          {cohort.subjectCount === 0 ? (
                            <span className="text-amber-700">None</span>
                          ) : (
                            cohort.subjectCount.toLocaleString()
                          )}
                        </td>
                      ) : null}
                      <td className="py-3">
                        <div className="flex flex-col items-start gap-2">
                          <Link
                            href={`${BASE}/${cohort.id}`}
                            className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
                          >
                            Open
                          </Link>
                          {canManage ? (
                            <Link
                              href={`${BASE}/${cohort.id}/edit`}
                              className="text-xs text-neutral-600 underline hover:text-neutral-900"
                            >
                              Rename
                            </Link>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>

            {page.pageCount > 1 ? (
              <nav
                aria-label={`${words.Plural} pages`}
                className="mt-3 flex flex-wrap items-center justify-between gap-2"
              >
                {/* Links rather than buttons: a page of a list is a place, and a
                    reader should be able to open page 3 in a new tab or come
                    back to it from history. */}
                {page.page > 1 ? (
                  <Link
                    href={`${BASE}${cohortFilterQuery(filters, { page: page.page - 1 })}`}
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
                    href={`${BASE}${cohortFilterQuery(filters, { page: page.page + 1 })}`}
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
    </div>
  );
}
