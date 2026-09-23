import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getInstitutionType } from "@/modules/institutions/repository";
import { sectionLabel } from "@/modules/school-setup/policy";
import { getClassesOverview } from "@/modules/school-setup/service";
import { SECTION_STATUS_LABEL, type ClassSummary } from "@/modules/school-setup/types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { LINK_PRIMARY, LINK_SECONDARY, STATUS_TONE, YearSwitcher, first } from "./shared";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/academic/classes";

/**
 * A school's classes for one academic year: each class, its sections, who
 * teaches each one and how many students are in it.
 *
 * Classes that existed in an earlier year but have no sections in this one
 * are listed separately with a one-click way to set them up again, so moving
 * to a new year is "set up Class 8 for 2027-28", not "create Class 8 again".
 */
export default async function ClassesPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) redirect("/dashboard");
  // A college's structure lives on its own screens; this one is for schools.
  if ((await getInstitutionType(user.institutionId)) !== "SCHOOL") {
    redirect("/dashboard/academic/cohorts");
  }

  const params = await searchParams;
  const overview = await getClassesOverview(user, first(params.year));
  const { year, years, classes, notSetUp, otherGroups } = overview;
  const canChange = hasPermission(user, "cohort.manage");
  const removed = first(params.removed);

  if (!year) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <h2 className="text-lg font-semibold text-neutral-900">Classes</h2>
        <EmptyState>
          No academic year is currently active. Select an academic year to continue setting up
          your school.{" "}
          <Link href="/dashboard/academic/sessions" className="font-medium text-neutral-900 underline">
            Go to Academic year
          </Link>
        </EmptyState>
      </div>
    );
  }

  const newHref = `${BASE}/new?year=${encodeURIComponent(year.id)}`;
  const editable = canChange && year.isActive;

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">Classes</h2>
          <p className="text-sm text-neutral-500">
            Classes, sections and teachers for {year.name}.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <YearSwitcher action={BASE} years={years} selectedId={year.id} />
          {editable ? (
            <Link href={newHref} className={LINK_PRIMARY}>
              Add class
            </Link>
          ) : null}
        </div>
      </header>

      {removed ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {sectionLabel(removed)} was removed.
        </p>
      ) : null}

      {!year.isActive ? (
        <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {year.name} is archived, so its classes are shown as they were and can&apos;t be changed.
        </p>
      ) : !year.isCurrent ? (
        <p role="status" className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
          You are viewing {year.name}, which is not the current academic year.
        </p>
      ) : null}

      {classes.length === 0 ? (
        <EmptyState>
          No classes are set up for {year.name} yet.
          {editable ? (
            <>
              {" "}
              <Link href={newHref} className="font-medium text-neutral-900 underline">
                Add your first class
              </Link>
              .
            </>
          ) : null}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {classes.map((summary) => (
            <ClassCard key={summary.id} summary={summary} yearId={year.id} />
          ))}
        </ul>
      )}

      {notSetUp.length > 0 && editable ? (
        <Panel
          title={`Not set up for ${year.name}`}
          description="Classes from other years with no sections in this one. Set one up to reuse its name and section names."
        >
          <ul className="flex flex-col divide-y divide-neutral-100">
            {notSetUp.map((unit) => (
              <li
                key={unit.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-neutral-900">{unit.name}</span>
                  {unit.sectionNames.length > 0 ? (
                    <span className="text-xs text-neutral-500">
                      Sections before: {unit.sectionNames.join(", ")}
                    </span>
                  ) : null}
                </div>
                <Link
                  href={`${newHref}&from=${encodeURIComponent(unit.id)}`}
                  className={LINK_SECONDARY}
                >
                  Set up <span className="sr-only">{unit.name}</span> for {year.name}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {otherGroups > 0 ? (
        <p className="text-xs text-neutral-500">
          {otherGroups} {otherGroups === 1 ? "group" : "groups"} in {year.name} {otherGroups === 1 ? "is" : "are"} not
          under a class, so {otherGroups === 1 ? "it is" : "they are"} not shown here. They still
          appear in attendance and reports.
        </p>
      ) : null}
    </div>
  );
}

function ClassCard({ summary, yearId }: { summary: ClassSummary; yearId: string }) {
  const href = `${BASE}/${summary.id}?year=${encodeURIComponent(yearId)}`;
  const sections = summary.sections.length;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col">
          <h3 className="text-base font-semibold text-neutral-900">
            <Link href={href} className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900">
              {summary.name}
            </Link>
          </h3>
          <p className="text-sm text-neutral-500">
            {sections} {sections === 1 ? "section" : "sections"} ·{" "}
            {summary.studentCount.toLocaleString()} {summary.studentCount === 1 ? "student" : "students"}
          </p>
        </div>
        {summary.needsTeacher === 0 ? (
          <Badge tone="positive">Ready</Badge>
        ) : (
          <Badge tone="warning">
            {summary.needsTeacher} {summary.needsTeacher === 1 ? "needs" : "need"} a teacher
          </Badge>
        )}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {summary.sections.map((section) => (
          <li key={section.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="font-medium text-neutral-900">{sectionLabel(section.name)}</span>
            <span className="flex items-center gap-2 text-neutral-600">
              {section.teacher ? section.teacher.name : <span className="text-amber-800">Not assigned</span>}
              {section.status === "teacher_inactive" ? (
                <Badge tone={STATUS_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-auto">
        <Link href={href} className={LINK_SECONDARY}>
          Open {summary.name}
        </Link>
      </div>
    </li>
  );
}
