import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  getStudentSectionForRequest,
  listSectionStudentsForRequest,
} from "@/modules/students/class-navigation-service";
import {
  STUDENTS_BASE,
  addStudentToSectionHref,
  studentClassHref,
  studentClassesHref,
  studentSectionHref,
} from "@/modules/students/class-navigation-paths";
import type { StudentSectionView } from "@/modules/students/class-navigation-types";
import {
  getStudentForRequest,
  getStudentFormOptionsForRequest,
} from "@/modules/students/directory-service";
import { hasActiveStudentFilters, parseStudentFilters } from "@/modules/students/directory-filters";
import { studentDisplayName } from "@/modules/students/types";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import { LINK_PRIMARY, LINK_SECONDARY } from "../../../../../academic/classes/shared";
import { ClassTeacherName, StudentsTrail } from "../../../class-navigation";
import { first, requireClassNavigation } from "../../../guard";
import {
  StudentDirectoryPager,
  StudentDirectoryTable,
  StudentFilterFields,
} from "../../../../student-directory";

interface PageProps {
  params: Promise<{ classId: string; sectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * One section's students: the student directory, with the class fixed to
 * this section and everything else — search, status, sort, the columns, the
 * View and Enroll face actions — exactly as it is for the whole school.
 *
 * Who is "in" the section is the directory's own class filter: a current
 * placement. A student moved to another section through their record leaves
 * this list and appears in that one; nothing here keeps a copy.
 *
 * A section reached through another class's URL, or one from another school,
 * is a 404.
 */
export default async function StudentSectionPage({ params, searchParams }: PageProps) {
  const user = await requireClassNavigation();
  const { classId, sectionId } = await params;
  const query = await searchParams;

  const view = await getStudentSectionForRequest(user, classId, sectionId);
  if (!view) notFound();
  const { section, year } = view;

  // The class is this page's, whatever the query string says.
  const filters = { ...parseStudentFilters(query), cohortId: "" };
  const [page, options, added] = await Promise.all([
    listSectionStudentsForRequest(user, section.id, filters),
    getStudentFormOptionsForRequest(user),
    addedStudent(user, first(query.added), section.id),
  ]);

  const here = studentSectionHref(classId, section.id);
  const filtered = hasActiveStudentFilters(filters);
  const canEnrollFace = hasPermission(user, "faceEmbedding.manage");
  // Adding here places the new student in this section, which is its own
  // permission; without it the form could only add them unplaced.
  const canAdd =
    hasPermission(user, "student.create") && hasPermission(user, "enrollment.manage") && year.isActive;
  const addHref = addStudentToSectionHref(section.id);

  const firstOnPage = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const lastOnPage = Math.min(page.page * page.pageSize, page.total);

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <StudentsTrail
        items={[
          { label: "Students", href: STUDENTS_BASE },
          { label: "Classes", href: studentClassesHref(year.id) },
          { label: view.className, href: studentClassHref(classId, year.id) },
          { label: section.label },
        ]}
      />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            {view.className} · {section.label}
          </h1>
          <p className="text-sm text-neutral-500">
            Academic year {year.name}
            {year.isCurrent ? " (current)" : ""} · shown elsewhere as {section.groupName}
          </p>
        </div>
        {canAdd ? (
          <Link href={addHref} className={LINK_PRIMARY}>
            + Add student<span className="sr-only"> to {section.groupName}</span>
          </Link>
        ) : null}
      </header>

      <dl className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Class teacher</dt>
          <dd>
            <ClassTeacherName teacher={section.classTeacher} />
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Students</dt>
          <dd className="tabular-nums text-neutral-900">
            {section.studentCount.toLocaleString()} on roll
          </dd>
        </div>
      </dl>

      {!year.isActive ? (
        <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {year.name} is archived. This section is shown as it was.
        </p>
      ) : null}

      {added ? <AddedNotice added={added} view={view} canEnrollFace={canEnrollFace} /> : null}

      <Panel
        title="Students"
        description={
          page.total === 0
            ? "Nothing to show."
            : `Showing ${firstOnPage.toLocaleString()}–${lastOnPage.toLocaleString()} of ${page.total.toLocaleString()}.`
        }
      >
        <form method="get" action={here} className="flex flex-col gap-4">
          <StudentFilterFields filters={filters} options={options} showClass={false} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Search</Button>
            {filtered ? (
              <Link href={here} className={LINK_SECONDARY}>
                Clear filters
              </Link>
            ) : null}
            {/* An empty section says so once, in the empty state below. */}
            {page.totalAll > 0 ? (
              <p className="text-xs tabular-nums text-neutral-500">
                {filtered
                  ? `${page.total.toLocaleString()} of ${page.totalAll.toLocaleString()} match`
                  : `${page.totalAll.toLocaleString()} ${page.totalAll === 1 ? "student" : "students"}, ${page.activeAll.toLocaleString()} on roll`}
              </p>
            ) : null}
          </div>
        </form>

        {page.rows.length === 0 ? (
          <EmptyState>
            {page.totalAll === 0 ? (
              <>
                No students in this section yet.
                {canAdd ? (
                  <>
                    {" "}
                    <Link href={addHref} className="font-medium text-neutral-900 underline">
                      Add the first one
                    </Link>
                    .
                  </>
                ) : null}
              </>
            ) : (
              <>
                Nothing matched. Clear the filters to see all {page.totalAll.toLocaleString()}{" "}
                {page.totalAll === 1 ? "student" : "students"} in {section.groupName}.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <StudentDirectoryTable rows={page.rows} canEnrollFace={canEnrollFace} />
            <StudentDirectoryPager
              page={page}
              filters={filters}
              baseHref={here}
              label={`${section.groupName} pages`}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

interface AddedStudent {
  id: string;
  name: string;
  inSection: boolean;
}

/**
 * The student just added from this page, when the Add student form sent the
 * clerk back here. Read through the directory service, so an id that is not
 * this school's student shows nothing.
 */
async function addedStudent(
  user: SessionUser,
  studentId: string | undefined,
  sectionId: string,
): Promise<AddedStudent | null> {
  if (!studentId) return null;
  try {
    const student = await getStudentForRequest(user, studentId);
    return {
      id: student.id,
      name: studentDisplayName(student),
      inSection: student.classes.some((link) => link.cohortId === sectionId),
    };
  } catch {
    return null;
  }
}

function AddedNotice({
  added,
  view,
  canEnrollFace,
}: {
  added: AddedStudent;
  view: StudentSectionView;
  canEnrollFace: boolean;
}) {
  const record = `${STUDENTS_BASE}/${encodeURIComponent(added.id)}`;
  return (
    <p
      role="status"
      className={`rounded-md px-3 py-2 text-sm ${
        added.inSection ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-900"
      }`}
    >
      {added.inSection
        ? `${added.name} was added to ${view.section.groupName}.`
        : `${added.name} was added, but is not placed in ${view.section.groupName}.`}{" "}
      <Link href={record} className="font-medium underline">
        Open their record
      </Link>
      {canEnrollFace ? (
        <>
          {" · "}
          <Link href={`${record}/enroll-face`} className="font-medium underline">
            Enroll face
          </Link>
        </>
      ) : null}
    </p>
  );
}
