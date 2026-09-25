import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import {
  getStudentFormOptionsForRequest,
  listStudentsForRequest,
} from "@/modules/students/directory-service";
import {
  classNavigationAvailable,
  getStudentClassesForRequest,
} from "@/modules/students/class-navigation-service";
import { studentClassesHref } from "@/modules/students/class-navigation-paths";
import type { StudentClassesView } from "@/modules/students/class-navigation-types";
import { hasActiveStudentFilters, parseStudentFilters } from "@/modules/students/directory-filters";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import { ClassGrid } from "./classes/class-navigation";
import { StudentDirectoryPager, StudentDirectoryTable, StudentFilterFields } from "./student-directory";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/students";

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
  const [page, options, classes] = await Promise.all([
    listStudentsForRequest(user, filters),
    getStudentFormOptionsForRequest(user),
    // The class panel is a second way in, and never the reason the directory
    // fails to load: a failure here leaves the panel saying so and the rest of
    // the page working.
    classNavigationAvailable(user)
      .then((available) => (available ? getStudentClassesForRequest(user) : null))
      .catch((): "unavailable" => "unavailable"),
  ]);

  const filtered = hasActiveStudentFilters(filters);
  const canCreate = hasPermission(user, "student.create");
  const canEnrollFace = hasPermission(user, "faceEmbedding.manage");

  const firstOnPage = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const lastOnPage = Math.min(page.page * page.pageSize, page.total);

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

      {classes === "unavailable" ? (
        <Panel title="Classes">
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            The classes could not be loaded just now.{" "}
            <Link href={BASE} className="font-medium underline">
              Try again
            </Link>
            . The directory below is unaffected.
          </p>
        </Panel>
      ) : classes ? (
        <ClassesPanel classes={classes} canSetUp={hasPermission(user, "academicStructure.manage")} />
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
          <StudentFilterFields filters={filters} options={options} showClass />
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
            <StudentDirectoryTable rows={page.rows} canEnrollFace={canEnrollFace} />
            <StudentDirectoryPager
              page={page}
              filters={filters}
              baseHref={BASE}
              label="Directory pages"
            />
          </>
        )}
      </Panel>
    </div>
  );
}

/**
 * The way in by class: every class of the current academic year, each opening
 * onto its sections. The directory below stays exactly as it was — this is a
 * second way to the same students, for when you know the class and not the
 * name.
 */
function ClassesPanel({ classes, canSetUp }: { classes: StudentClassesView; canSetUp: boolean }) {
  const { year, years, classes: cards, otherGroups } = classes;
  return (
    <Panel
      title="Classes"
      description={
        year
          ? `Manage students by class and section — ${year.name}${year.isCurrent ? " (current year)" : ""}.`
          : "Manage students by class and section."
      }
      action={
        years.length > 1 ? (
          <Link
            href={studentClassesHref(year?.id)}
            className="rounded-sm text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900"
          >
            Other academic years
          </Link>
        ) : null
      }
    >
      {!year ? (
        <EmptyState>
          No academic year is set up yet, so there are no classes to show.
          {canSetUp ? (
            <>
              {" "}
              <Link href="/dashboard/academic/sessions" className="font-medium text-neutral-900 underline">
                Set up an academic year
              </Link>
              .
            </>
          ) : null}
        </EmptyState>
      ) : cards.length === 0 ? (
        <EmptyState>
          No classes found for {year.name}.
          {canSetUp ? (
            <>
              {" "}
              <Link href="/dashboard/academic/classes" className="font-medium text-neutral-900 underline">
                Set up classes and sections
              </Link>
              .
            </>
          ) : null}
        </EmptyState>
      ) : (
        <>
          <ClassGrid classes={cards} yearId={year.id} />
          {otherGroups > 0 ? (
            <p className="text-xs text-neutral-500">
              {otherGroups} {otherGroups === 1 ? "group" : "groups"} in {year.name}{" "}
              {otherGroups === 1 ? "is" : "are"} not under a class, so{" "}
              {otherGroups === 1 ? "it is" : "they are"} not shown here. Use the Class filter in the
              directory to find {otherGroups === 1 ? "its" : "their"} students.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
