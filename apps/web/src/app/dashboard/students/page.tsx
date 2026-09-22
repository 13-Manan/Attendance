import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import {
  getStudentFormOptionsForRequest,
  listStudentsForRequest,
} from "@/modules/students/directory-service";
import {
  NO_CAMPUS,
  NO_COHORT,
  STUDENT_SORTS,
  hasActiveStudentFilters,
  parseStudentFilters,
  studentFilterQuery,
} from "@/modules/students/directory-filters";
import {
  STUDENT_STATUSES,
  STUDENT_STATUS_LABEL,
  type StudentListRow,
  type StudentStatus,
} from "@/modules/students/directory-types";
import { studentDisplayName } from "@/modules/students/types";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/students";

/**
 * Formatted in UTC because an admission date is stored as UTC midnight — the
 * calendar day somebody typed. Formatting it in the reader's zone would show
 * the day before to anybody west of Greenwich.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const STATUS_TONE: Record<StudentStatus, BadgeTone> = {
  ACTIVE: "positive",
  INACTIVE: "neutral",
  TRANSFERRED: "neutral",
  COMPLETED: "info",
};

function ClassCell({ student }: { student: StudentListRow }) {
  if (student.classes.length === 0) {
    return <span className="text-sm text-amber-700">Not placed</span>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {student.classes.map((link) => (
        <li key={link.enrollmentId} className="text-sm text-neutral-600">
          {link.cohortName}
          {link.termLabel ? ` · ${link.termLabel}` : ""}
          <span className="block text-xs text-neutral-400">
            {link.academicSessionName}
            {link.academicSessionIsCurrent ? " (current year)" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The student directory.
 *
 * ## Why this list is narrowed in SQL
 *
 * It is the one list in this product that genuinely grows. A school with four
 * thousand students on roll cannot have every one of them read into memory to
 * render twenty-five rows, so the search, the filters, the ordering and the
 * paging all happen in the database — see `modules/students/directory-filters.ts`,
 * which also explains why the campus list does the opposite.
 *
 * ## Why the filters are a GET form
 *
 * The same reason the audit log's are: a filtered list is then a URL, which
 * can be bookmarked and sent to a colleague, and no client JavaScript is
 * needed to produce one. The form deliberately does not carry the page number,
 * so any new search starts at the first page rather than at page 7 of a list
 * that now has two.
 *
 * Read-gated on `student.read`; each control is write-gated on the permission
 * that matches what it does, and the page renders only the ones the viewer may
 * actually use.
 */
export default async function StudentsPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("student.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no student
        directory here.
      </p>
    );
  }

  const params = await searchParams;
  const filters = parseStudentFilters(params);
  const [page, options] = await Promise.all([
    listStudentsForRequest(user, filters),
    getStudentFormOptionsForRequest(user),
  ]);

  const filtered = hasActiveStudentFilters(filters);
  const canCreate = hasPermission(user, "student.create");
  const canEnrollFace = hasPermission(user, "faceEmbedding.manage");

  const firstOnPage = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const lastOnPage = Math.min(page.page * page.pageSize, page.total);

  const labelClass = "flex flex-col gap-1.5 text-xs font-medium text-neutral-600";

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          People
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Students
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Everyone enrolled at this institution. A student is never deleted — one who leaves is
          taken off roll, which keeps every register they appear in and stops them being listed
          for new ones.
        </p>
      </header>

      {params.archived === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Student taken off roll.
        </p>
      ) : null}

      <Panel
        title="Find a student"
        description="Search by name, student code, email or admission number. Terms are matched separately, so “priya sharma” finds Priya Sharma."
        action={
          canCreate ? (
            <Link href={`${BASE}/new`}>
              <Button type="button">+ Add student</Button>
            </Link>
          ) : null
        }
      >
        <form method="get" action={BASE} className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className={labelClass}>
              Search
              <Input
                type="search"
                name="q"
                defaultValue={filters.q}
                placeholder="Name, code, email, admission no."
                autoComplete="off"
              />
            </label>
            <label className={labelClass}>
              Status
              <Select name="status" defaultValue={filters.status}>
                <option value="">Every status</option>
                {STUDENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STUDENT_STATUS_LABEL[status]}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Class
              <Select name="cohortId" defaultValue={filters.cohortId}>
                <option value="">Any class</option>
                <option value={NO_COHORT}>Not placed in any class</option>
                {options.cohorts.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.name}
                    {cohort.termLabel ? ` · ${cohort.termLabel}` : ""} —{" "}
                    {cohort.academicSessionName}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Sort by
              <Select name="sort" defaultValue={filters.sort}>
                {STUDENT_SORTS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            {options.campuses.length > 0 ? (
              <label className={labelClass}>
                Campus
                <Select name="campusId" defaultValue={filters.campusId}>
                  <option value="">Any campus</option>
                  <option value={NO_CAMPUS}>No campus</option>
                  {options.campuses.map((campus) => (
                    <option key={campus.id} value={campus.id}>
                      {campus.name} ({campus.code})
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Search</Button>
            {filtered ? (
              <Link href={BASE}>
                <Button type="button" variant="secondary">
                  Clear filters
                </Button>
              </Link>
            ) : null}
            <p className="text-xs tabular-nums text-neutral-500">
              {page.totalAll === 0
                ? "No students yet."
                : filtered
                  ? `${page.total.toLocaleString()} of ${page.totalAll.toLocaleString()} match`
                  : `${page.totalAll.toLocaleString()} ${page.totalAll === 1 ? "student" : "students"}, ${page.activeAll.toLocaleString()} on roll`}
            </p>
          </div>
        </form>
      </Panel>

      <Panel
        title="Directory"
        description={
          page.total === 0
            ? "Nothing to show."
            : `Showing ${firstOnPage.toLocaleString()}–${lastOnPage.toLocaleString()} of ${page.total.toLocaleString()}.`
        }
      >
        {page.rows.length === 0 ? (
          <EmptyState>
            {page.totalAll === 0 ? (
              canCreate ? (
                <>
                  No students yet. Add the first one — a student needs a name and the
                  institution&apos;s own code for them, and can be placed in a class straight away
                  or later.
                </>
              ) : (
                <>No students have been added yet.</>
              )
            ) : (
              <>
                Nothing matched. Clear the filters to see all {page.totalAll.toLocaleString()}{" "}
                students.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <TableScroll minWidth="min-w-[52rem]">
              <table className="w-full border-collapse text-left">
                <thead className="bg-neutral-50">
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2.5 pr-4 pl-3 font-medium">Student</th>
                    <th className="py-2.5 pr-4 font-medium">Class</th>
                    <th className="py-2.5 pr-4 font-medium">Admission</th>
                    <th className="py-2.5 pr-4 font-medium">Status</th>
                    <th className="py-2.5 pr-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {page.rows.map((student) => (
                    <tr key={student.id} className="align-top transition-colors hover:bg-neutral-50/60">
                      <td className="py-3 pr-4 first:pl-3">
                        <Link
                          href={`${BASE}/${student.id}`}
                          className="text-sm font-medium text-neutral-900 hover:underline"
                        >
                          {studentDisplayName(student)}
                        </Link>
                        <p className="font-mono text-xs text-neutral-500">{student.studentCode}</p>
                        {student.campusName ? (
                          <p className="text-xs text-neutral-400">{student.campusName}</p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 first:pl-3">
                        <ClassCell student={student} />
                      </td>
                      <td className="py-3 pr-4 text-sm text-neutral-600">
                        {student.admissionNumber ?? (
                          <span className="text-neutral-400">No number</span>
                        )}
                        {student.admissionDate ? (
                          <span className="block text-xs text-neutral-400">
                            {DATE_FORMAT.format(student.admissionDate)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 first:pl-3">
                        <Badge tone={STATUS_TONE[student.status]}>
                          {STUDENT_STATUS_LABEL[student.status]}
                        </Badge>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-col items-start gap-2">
                          <Link href={`${BASE}/${student.id}`}>
                            <Button type="button" variant="secondary">
                              View
                            </Button>
                          </Link>
                          {canEnrollFace ? (
                            <Link
                              href={`${BASE}/${student.id}/enroll-face`}
                              className="text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-900"
                            >
                              Enroll face
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
                aria-label="Directory pages"
                className="mt-3 flex flex-wrap items-center justify-between gap-2"
              >
                {/* Links rather than buttons: a page of a list is a place, and
                    a reader should be able to open page 3 in a new tab or come
                    back to it from history. */}
                {page.page > 1 ? (
                  <Link href={`${BASE}${studentFilterQuery(filters, { page: page.page - 1 })}`}>
                    <Button type="button" variant="secondary">
                      ← Previous
                    </Button>
                  </Link>
                ) : (
                  <span className="px-3 py-2 text-sm text-neutral-400">← Previous</span>
                )}
                <p className="text-xs tabular-nums text-neutral-500">
                  Page {page.page} of {page.pageCount}
                </p>
                {page.page < page.pageCount ? (
                  <Link href={`${BASE}${studentFilterQuery(filters, { page: page.page + 1 })}`}>
                    <Button type="button" variant="secondary">
                      Next →
                    </Button>
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
