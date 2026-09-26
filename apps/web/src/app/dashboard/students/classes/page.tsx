import Link from "next/link";
import { redirect } from "next/navigation";
import { hasPermission } from "@/modules/authorization/service";
import { getStudentClassesForRequest } from "@/modules/students/class-navigation-service";
import {
  STUDENTS_BASE,
  STUDENT_CLASSES_BASE,
} from "@/modules/students/class-navigation-paths";
import { BackToParent } from "@/components/nav/back-to-parent";
import { EmptyState } from "@/components/ui/panel";
import { YearSwitcher } from "../../academic/classes/shared";
import { ClassGrid } from "./class-navigation";
import { first, requireClassNavigation } from "./guard";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Students, by class: every class of one academic year — the current one
 * unless another is chosen — each opening onto its sections.
 *
 * The Students page shows the same classes for the current year above its
 * directory; this page is where another year can be chosen, with the Classes
 * screens' own year switcher.
 */
export default async function StudentClassesPage({ searchParams }: PageProps) {
  const user = await requireClassNavigation();
  const params = await searchParams;

  const view = await getStudentClassesForRequest(user, first(params.year));
  if (!view) redirect(STUDENTS_BASE);
  const { year, years, classes, otherGroups } = view;
  const canSetUp = hasPermission(user, "academicStructure.manage");

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <BackToParent href={STUDENTS_BASE} label="Students" />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
            Classes
          </h1>
          <p className="text-sm text-neutral-500">
            {year
              ? `Manage students by class and section — ${year.name}.`
              : "Manage students by class and section."}
          </p>
        </div>
        {year ? (
          <YearSwitcher action={STUDENT_CLASSES_BASE} years={years} selectedId={year.id} />
        ) : null}
      </header>

      {year && !year.isActive ? (
        <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {year.name} is archived. Its classes are shown as they were.
        </p>
      ) : year && !year.isCurrent ? (
        <p role="status" className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
          You are viewing {year.name}, which is not the current academic year.
        </p>
      ) : null}

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
      ) : classes.length === 0 ? (
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
        <ClassGrid classes={classes} yearId={year.id} />
      )}

      {year && otherGroups > 0 ? (
        <p className="text-xs text-neutral-500">
          {otherGroups} {otherGroups === 1 ? "group" : "groups"} in {year.name}{" "}
          {otherGroups === 1 ? "is" : "are"} not under a class, so {otherGroups === 1 ? "it is" : "they are"}{" "}
          not shown here. Use the Class filter in the{" "}
          <Link href={STUDENTS_BASE} className="underline">
            student directory
          </Link>{" "}
          to find {otherGroups === 1 ? "its" : "their"} students.
        </p>
      ) : null}
    </div>
  );
}
