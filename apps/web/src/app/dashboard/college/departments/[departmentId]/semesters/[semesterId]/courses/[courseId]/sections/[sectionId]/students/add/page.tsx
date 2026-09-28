import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { MIN_STUDENT_SEARCH, sectionFullName } from "@/modules/college-setup/policy";
import { searchStudentsForSection } from "@/modules/college-setup/service";
import type { StudentSearchRow } from "@/modules/college-setup/types";
import { STUDENT_STATUS_LABEL } from "@/modules/students/directory-types";
import { withReturnPath } from "@/lib/return-path";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { AddStudentsByIdForm, AddToSectionButton } from "@/app/dashboard/college/college-controls";
import {
  COURSES_PATH,
  LINK_SECONDARY,
  courseHref,
  courseTrail,
  departmentHref,
  departmentPeopleHref,
  first,
  readOrDeny,
  sectionHref,
  sectionStudentsHref,
  semesterHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string; courseId: string; sectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Adding students to one course section: an existing student of the college,
 * found by student ID, name or admission number — or, before anything is
 * typed, one of the department's students from its other sections — or a new
 * student through the college's usual Add student form.
 *
 * Adding a student here places them in this section and changes nothing
 * else: a student is in Physics A and Chemistry B at once. The search reads
 * this college's students only, and the section is checked through every
 * parent — for a head of department, to their own department — on the server.
 */
export default async function AddSectionStudentsPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const ids = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const rawQuery = first(query.q) ?? "";

  const result = await readOrDeny(() => searchStudentsForSection(user, ids, rawQuery, first(query.added)));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <PageTrail items={[isAdmin ? { label: "Departments", href: "/dashboard/college/departments" } : { label: "Courses", href: COURSES_PATH }, { label: "Add students" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const search = result.value;
  if (!search) notFound();

  const { department, semester, course, session, section } = search.placement;
  const sectionPage = sectionHref(department.id, semester.id, course.id, section.id);
  const here = sectionStudentsHref(ids, "add");
  const fullName = sectionFullName(course.name, section.label);
  const canOpenRecord = hasPermission(user, "student.read");
  const trail = courseTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    semester: { name: semester.name, href: semesterHref(department.id, semester.id) },
    course: { name: course.name, code: course.code, href: courseHref(department.id, semester.id, course.id) },
    section: { label: section.label, href: sectionPage },
    leaf: "Add students",
  });
  const viewHref = (studentId: string) =>
    withReturnPath(
      canOpenRecord
        ? `/dashboard/students/${encodeURIComponent(studentId)}`
        : departmentPeopleHref(department.id, "students", studentId),
      sectionPage,
    );
  const typedTooLittle = rawQuery.trim() !== "" && !search.searched;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Add students</h1>
        <p className="text-sm text-neutral-500">
          To <span className="font-medium text-neutral-900">{fullName}</span> · {semester.name} · {department.name}
        </p>
      </header>

      <nav aria-label="How to add a student" className="flex flex-wrap gap-2">
        <span
          aria-current="page"
          className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white sm:min-h-10"
        >
          Select existing student
        </span>
        <Link href={sectionStudentsHref(ids, "new")} className={LINK_SECONDARY}>
          Create new student
        </Link>
      </nav>

      {!session.isActive ? (
        <EmptyState>{session.name} is archived, so students can&apos;t be added to its sections.</EmptyState>
      ) : (
        <>
          {search.added ? (
            <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
              {search.added.name} was added to {fullName}.{" "}
              <Link href={viewHref(search.added.studentId)} className="font-medium underline">
                View {search.added.name}
              </Link>
              {" · "}
              <Link href={sectionPage} className="font-medium underline">
                Back to the section
              </Link>
            </p>
          ) : null}

          <form method="get" action={here} role="search" className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor="add-student-q" className="text-sm font-medium text-neutral-900">
                Search by student ID, name or admission number
              </label>
              <Input
                id="add-student-q"
                name="q"
                defaultValue={search.query || rawQuery}
                placeholder="e.g. CSE001 or Aman"
                autoComplete="off"
                autoFocus={!search.added}
              />
            </div>
            <Button type="submit">Search</Button>
            {rawQuery ? (
              <Link href={here} className={LINK_SECONDARY}>
                Clear
              </Link>
            ) : null}
          </form>

          {search.searched ? (
            <Panel
              title={`Students found (${search.results.length}${search.truncated ? "+" : ""})`}
              description={
                search.truncated
                  ? `The first ${search.results.length} matches. Type more of the name or ID to narrow them.`
                  : "Students of this college matching the search."
              }
            >
              {search.results.length === 0 ? (
                <EmptyState>
                  No student of this college matches “{search.query}”. Check the spelling or the ID, or{" "}
                  <Link href={sectionStudentsHref(ids, "new")} className="font-medium text-neutral-900 underline">
                    create a new student
                  </Link>
                  .
                </EmptyState>
              ) : (
                <StudentRows
                  rows={search.results}
                  ids={ids}
                  query={search.query}
                  groupName={section.groupName}
                  viewHref={viewHref}
                />
              )}
            </Panel>
          ) : (
            <Panel
              title={`In ${department.name}'s other sections (${search.suggestions.length}${search.suggestionsTruncated ? "+" : ""})`}
              description={
                typedTooLittle
                  ? `Type at least ${MIN_STUDENT_SEARCH} characters to search the whole college.`
                  : `Students already in this session's other ${department.name} sections and not yet in this one. Search to find anyone else at the college.`
              }
            >
              {search.suggestions.length === 0 ? (
                <EmptyState>
                  Nobody to suggest yet. Search above for a student of the college, or create a new one.
                </EmptyState>
              ) : (
                <StudentRows
                  rows={search.suggestions}
                  ids={ids}
                  query=""
                  groupName={section.groupName}
                  viewHref={viewHref}
                />
              )}
            </Panel>
          )}

          <details className="rounded-lg border border-neutral-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-medium text-neutral-900">
              Add several at once by student ID
            </summary>
            <div className="mt-3">
              <AddStudentsByIdForm ids={ids} />
            </div>
          </details>
        </>
      )}

      <div>
        <Link href={sectionPage} className={LINK_SECONDARY}>
          Done — back to {fullName}
        </Link>
      </div>
    </div>
  );
}

function StudentRows({
  rows,
  ids,
  query,
  groupName,
  viewHref,
}: {
  rows: readonly StudentSearchRow[];
  ids: { departmentId: string; semesterId: string; courseId: string; sectionId: string };
  query: string;
  groupName: string;
  viewHref: (studentId: string) => string;
}) {
  return (
    <ul className="flex flex-col divide-y divide-neutral-100">
      {rows.map((student) => {
        const name = `${student.firstName} ${student.lastName}`.trim();
        return (
          <li key={student.studentId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-neutral-900">{name}</span>
              <span className="text-xs text-neutral-500">
                <span className="font-mono">{student.studentCode}</span>
                {student.admissionNumber ? ` · Admission no. ${student.admissionNumber}` : ""}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {student.inSection ? (
                <>
                  <Badge tone="positive">In {groupName}</Badge>
                  <Link href={viewHref(student.studentId)} className={LINK_SECONDARY}>
                    View<span className="sr-only"> {name}</span>
                  </Link>
                </>
              ) : student.status !== "ACTIVE" ? (
                <Badge tone="neutral">{STUDENT_STATUS_LABEL[student.status]} — not on roll</Badge>
              ) : (
                <AddToSectionButton ids={ids} studentId={student.studentId} name={name} query={query} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
