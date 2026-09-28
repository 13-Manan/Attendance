import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { createDepartmentStudentAction } from "@/modules/college-setup/actions";
import { MIN_STUDENT_SEARCH } from "@/modules/college-setup/policy";
import {
  getDepartmentStudentPick,
  getDepartmentStudents,
  searchStudentsForDepartment,
} from "@/modules/college-setup/service";
import type { SectionChoice } from "@/modules/college-setup/types";
import { getStudentFormOptionsForRequest } from "@/modules/students/directory-service";
import { STUDENT_STATUS_LABEL, type StudentFormOptions } from "@/modules/students/directory-types";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { StudentForm } from "@/app/dashboard/students/student-form";
import { StudentSectionForm } from "@/app/dashboard/college/college-controls";
import {
  LINK_PRIMARY,
  LINK_SECONDARY,
  departmentHref,
  departmentPeopleHref,
  departmentTrail,
  first,
  readOrDeny,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const TAB_CURRENT =
  "inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white sm:min-h-10";

/**
 * Adding a student to the department, from the department: an existing
 * student of the college — found by student ID, name or admission number, then
 * placed in one of the department's course sections — or a new one, admitted
 * through the college's usual Add student form straight into the section
 * chosen on it. Either way the student's own page opens next, with their face
 * enrolment and their other courses a click away.
 */
export default async function AddDepartmentStudentPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;
  const isAdmin = hasPermission(user, "academicStructure.manage");
  const creating = first(query.mode) === "new";
  const chosenId = first(query.student);
  const rawQuery = first(query.q) ?? "";
  const here = departmentPeopleHref(departmentId, "students", "add");

  const result = await readOrDeny(async () => {
    if (creating) return { kind: "new" as const, view: await getDepartmentStudents(user, departmentId) };
    if (chosenId) return { kind: "pick" as const, view: await getDepartmentStudentPick(user, departmentId, chosenId) };
    return { kind: "search" as const, view: await searchStudentsForDepartment(user, departmentId, rawQuery) };
  });
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <PageTrail items={[{ label: "Students" }, { label: "Add student" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const page = result.value;
  // Another department's page, or a chosen student who is not this college's: not found.
  if (!page.view) notFound();
  const { department, session } = page.view;
  const searchQuery = page.kind === "search" ? page.view.query : "";
  const trail = departmentTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    list: { label: "Students", href: departmentPeopleHref(department.id, "students") },
    leaf: { label: "Add student" },
  });

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Add student</h1>
        <p className="text-sm text-neutral-500">
          To one of {department.name}&apos;s course sections{session ? ` in ${session.name}` : ""}. A student can be in
          sections of several courses.
        </p>
      </header>

      <nav aria-label="How to add a student" className="flex flex-wrap gap-2">
        {creating ? (
          <Link href={here} className={LINK_SECONDARY}>
            Add existing student
          </Link>
        ) : (
          <span aria-current="page" className={TAB_CURRENT}>
            Add existing student
          </span>
        )}
        {creating ? (
          <span aria-current="page" className={TAB_CURRENT}>
            Create new student
          </span>
        ) : (
          <Link href={`${here}?mode=new`} className={LINK_SECONDARY}>
            Create new student
          </Link>
        )}
      </nav>

      {!session?.isActive ? (
        <EmptyState>
          {session ? `${session.name} is archived, so students can't be added to its sections.` : "There is no academic session yet."}
        </EmptyState>
      ) : page.kind === "new" ? (
        <NewStudent
          departmentId={department.id}
          sections={page.view.sections}
          campuses={
            hasPermission(user, "student.read") ? (await getStudentFormOptionsForRequest(user)).campuses : []
          }
        />
      ) : page.kind === "pick" ? (
        <Panel
          title={`${page.view.student.firstName} ${page.view.student.lastName}`}
          description={`Student ID ${page.view.student.studentCode}${page.view.student.admissionNumber ? ` · Admission no. ${page.view.student.admissionNumber}` : ""}`}
          action={
            <Link href={rawQuery ? `${here}?q=${encodeURIComponent(rawQuery)}` : here} className={LINK_SECONDARY}>
              Choose someone else
            </Link>
          }
        >
          {page.view.placements.length > 0 ? (
            <p className="text-sm text-neutral-700">
              In {department.name} now:{" "}
              {page.view.placements.map((placement) => `${placement.courseName} — ${placement.label}`).join(", ")}.
            </p>
          ) : (
            <p className="text-sm text-neutral-700">Not in any of {department.name}&apos;s sections yet.</p>
          )}
          {page.view.student.status !== "ACTIVE" ? (
            <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
              {STUDENT_STATUS_LABEL[page.view.student.status]} — not on roll, so they can&apos;t be added to a section.
            </p>
          ) : (
            <StudentSectionForm
              departmentId={department.id}
              studentId={page.view.student.studentId}
              studentName={`${page.view.student.firstName} ${page.view.student.lastName}`.trim()}
              choices={page.view.sectionChoices}
            />
          )}
        </Panel>
      ) : (
        <>
          <form method="get" action={here} role="search" className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label htmlFor="department-student-q" className="text-sm font-medium text-neutral-900">
                Search by student ID, name or admission number
              </label>
              <Input
                id="department-student-q"
                name="q"
                defaultValue={page.view.query || rawQuery}
                placeholder="e.g. CSE001 or Aman"
                autoComplete="off"
                autoFocus
              />
            </div>
            <Button type="submit">Search</Button>
            {rawQuery ? (
              <Link href={here} className={LINK_SECONDARY}>
                Clear
              </Link>
            ) : null}
          </form>
          {!page.view.hasSections ? (
            <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {department.name} has no course sections this session yet.{" "}
              <Link href="/dashboard/college/courses" className="font-medium underline underline-offset-2">
                Add a course and its sections
              </Link>{" "}
              first.
            </p>
          ) : null}
          {page.view.searched ? (
            <Panel
              title={`Students found (${page.view.results.length}${page.view.truncated ? "+" : ""})`}
              description={
                page.view.truncated
                  ? `The first ${page.view.results.length} matches. Type more of the name or ID to narrow them.`
                  : "Students of this college matching the search."
              }
            >
              {page.view.results.length === 0 ? (
                <EmptyState>
                  No student of this college matches “{page.view.query}”.{" "}
                  <Link href={`${here}?mode=new`} className="font-medium text-neutral-900 underline">
                    Create a new student
                  </Link>{" "}
                  instead.
                </EmptyState>
              ) : (
                <ul className="flex flex-col divide-y divide-neutral-100">
                  {page.view.results.map((student) => {
                    const name = `${student.firstName} ${student.lastName}`.trim();
                    return (
                      <li key={student.studentId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium text-neutral-900">{name}</span>
                          <span className="text-xs text-neutral-500">
                            <span className="font-mono">{student.studentCode}</span>
                            {student.admissionNumber ? ` · Admission no. ${student.admissionNumber}` : ""}
                          </span>
                          {student.sections.length > 0 ? (
                            <span className="text-xs text-neutral-600">
                              In {student.sections.map((section) => `${section.courseName} — ${section.label}`).join(", ")}
                            </span>
                          ) : null}
                        </div>
                        {student.status !== "ACTIVE" ? (
                          <Badge tone="neutral">{STUDENT_STATUS_LABEL[student.status]} — not on roll</Badge>
                        ) : (
                          <Link
                            href={`${here}?${new URLSearchParams({ student: student.studentId, q: searchQuery })}`}
                            className={LINK_PRIMARY}
                          >
                            Choose<span className="sr-only"> {name}</span>
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          ) : rawQuery.trim() !== "" ? (
            <p className="text-sm text-neutral-600">Type at least {MIN_STUDENT_SEARCH} characters to search.</p>
          ) : (
            <p className="text-sm text-neutral-600">
              Search for a student of the college, choose them, then choose the course and section they join. Someone
              not at the college yet?{" "}
              <Link href={`${here}?mode=new`} className="font-medium text-neutral-900 underline underline-offset-2">
                Create a new student
              </Link>
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The college's usual Add student form — the same fields, checked by the same
 * student service — with the course section the new student joins first, from
 * this department only.
 */
function NewStudent({
  departmentId,
  sections,
  campuses,
}: {
  departmentId: string;
  sections: readonly SectionChoice[];
  campuses: StudentFormOptions["campuses"];
}) {
  if (sections.length === 0) {
    return (
      <EmptyState>
        The department has no course sections this session yet, and a new student joins one.{" "}
        <Link href="/dashboard/college/courses" className="font-medium text-neutral-900 underline">
          Add a course and its sections
        </Link>{" "}
        first.
      </EmptyState>
    );
  }
  return (
    <StudentForm
      mode="create"
      options={{ campuses, cohorts: [] }}
      canPlace={false}
      action={createDepartmentStudentAction}
      hidden={{ departmentId }}
      leading={
        <Field label="Course and section they join" htmlFor="new-student-section">
          <Select id="new-student-section" name="sectionId" required defaultValue="">
            <option value="">Choose…</option>
            {sections.map((section) => (
              <option key={section.sectionId} value={section.sectionId}>
                {section.course.name} — {section.label} ({section.groupName})
              </option>
            ))}
          </Select>
        </Field>
      }
    />
  );
}
