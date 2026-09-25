import Link from "next/link";
import { notFound } from "next/navigation";
import { hasPermission } from "@/modules/authorization/service";
import { getStudentClassForRequest } from "@/modules/students/class-navigation-service";
import {
  STUDENTS_BASE,
  studentClassHref,
  studentClassesHref,
} from "@/modules/students/class-navigation-paths";
import { EmptyState } from "@/components/ui/panel";
import { YearSwitcher } from "../../../academic/classes/shared";
import { SectionCards, StudentsTrail } from "../class-navigation";
import { first, requireClassNavigation } from "../guard";

interface PageProps {
  params: Promise<{ classId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * One class, in one academic year: its sections, each with its class teacher
 * and how many students on roll are in it, and the way into each.
 *
 * A class id from another school — or one that is not a class at all — is a
 * 404, the same as the Classes screens.
 */
export default async function StudentClassPage({ params, searchParams }: PageProps) {
  const user = await requireClassNavigation();
  const { classId } = await params;
  const query = await searchParams;

  const view = await getStudentClassForRequest(user, classId, first(query.year));
  if (!view) notFound();
  const { year, years, sections, studentCount } = view;
  const canSetUp = hasPermission(user, "academicStructure.manage");

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <StudentsTrail
        items={[
          { label: "Students", href: STUDENTS_BASE },
          { label: "Classes", href: studentClassesHref(year?.id) },
          { label: view.name },
        ]}
      />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            {view.name}
          </h1>
          <p className="text-sm text-neutral-500">
            {year ? (
              <>
                Academic year {year.name}
                {year.isCurrent ? " (current)" : ""} · {sections.length}{" "}
                {sections.length === 1 ? "section" : "sections"} · {studentCount.toLocaleString()}{" "}
                {studentCount === 1 ? "student" : "students"} on roll
              </>
            ) : (
              "No academic year is set up yet."
            )}
          </p>
        </div>
        {year ? (
          <YearSwitcher action={studentClassHref(view.id)} years={years} selectedId={year.id} />
        ) : null}
      </header>

      {year && !year.isActive ? (
        <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {year.name} is archived. Its sections are shown as they were.
        </p>
      ) : year && !year.isCurrent ? (
        <p role="status" className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
          You are viewing {year.name}, which is not the current academic year.
        </p>
      ) : null}

      {sections.length === 0 ? (
        <EmptyState>
          No sections have been created for this class
          {year ? ` in ${year.name}` : ""} yet.
          {canSetUp ? (
            <>
              {" "}
              <Link
                href={`/dashboard/academic/classes/${encodeURIComponent(view.id)}${
                  year ? `?year=${encodeURIComponent(year.id)}` : ""
                }`}
                className="font-medium text-neutral-900 underline"
              >
                Set up its sections
              </Link>
              .
            </>
          ) : null}
        </EmptyState>
      ) : (
        <SectionCards classId={view.id} sections={sections} />
      )}
    </div>
  );
}
