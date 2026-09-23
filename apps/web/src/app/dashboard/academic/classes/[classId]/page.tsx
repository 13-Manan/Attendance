import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getInstitutionType } from "@/modules/institutions/repository";
import { sectionKey, sectionLabel, suggestSectionName } from "@/modules/school-setup/policy";
import { getClassDetail } from "@/modules/school-setup/service";
import { SECTION_STATUS_LABEL, SchoolSetupError } from "@/modules/school-setup/types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { AddSectionForm, QuickAssignTeacher, RenameClassForm } from "../class-controls";
import { LINK_SECONDARY, STATUS_TONE, YearSwitcher, first } from "../shared";

interface PageProps {
  params: Promise<{ classId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/academic/classes";

/**
 * One class in one academic year: its sections, each with its teacher,
 * student count and whether it is ready to take attendance.
 */
export default async function ClassPage({ params, searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) redirect("/dashboard");
  if ((await getInstitutionType(user.institutionId)) !== "SCHOOL") {
    redirect("/dashboard/academic/cohorts");
  }

  const { classId } = await params;
  const query = await searchParams;

  let detail;
  try {
    detail = await getClassDetail(user, classId, first(query.year));
  } catch (error) {
    if (error instanceof SchoolSetupError) {
      return <EmptyState>{error.message}</EmptyState>;
    }
    throw error;
  }
  if (!detail) notFound();

  const { year, years, sections, teachers } = detail;
  const canChange = hasPermission(user, "cohort.manage");
  const editable = canChange && year.isActive;
  const yearQuery = `year=${encodeURIComponent(year.id)}`;
  const created = first(query.created) === "1";
  const removed = first(query.removed);
  const students = sections.reduce((sum, section) => sum + section.studentCount, 0);

  const used = new Set(sections.map((section) => sectionKey(section.name)));
  let suggestion = "";
  for (let index = 0; index < 60; index += 1) {
    const candidate = suggestSectionName(index);
    if (!used.has(sectionKey(candidate))) {
      suggestion = candidate;
      break;
    }
  }

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <Link
            href={`${BASE}?${yearQuery}`}
            className="text-sm text-neutral-500 hover:text-neutral-900 hover:underline"
          >
            &larr; All classes
          </Link>
          <h2 className="text-lg font-semibold text-neutral-900">{detail.name}</h2>
          <p className="text-sm text-neutral-500">
            Academic year {year.name} · {sections.length}{" "}
            {sections.length === 1 ? "section" : "sections"} · {students.toLocaleString()}{" "}
            {students === 1 ? "student" : "students"}
          </p>
        </div>
        <YearSwitcher action={`${BASE}/${detail.id}`} years={years} selectedId={year.id} />
      </div>

      {created ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {detail.name} is set up for {year.name}.
          {sections.some((section) => !section.teacher)
            ? " Assign a teacher to each section so attendance can be taken."
            : ""}
        </p>
      ) : null}
      {removed ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {sectionLabel(removed)} was removed.
        </p>
      ) : null}
      {!year.isActive ? (
        <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {year.name} is archived, so this class is shown as it was and can&apos;t be changed.
        </p>
      ) : null}

      <Panel title="Sections" description="Each section's teacher, students and status.">
        {sections.length === 0 ? (
          <EmptyState>
            {detail.name} has no sections in {year.name}.
            {editable ? " Add one below." : ""}
          </EmptyState>
        ) : (
          <>
            {/* Phones: one card per section. */}
            <ul className="flex flex-col gap-3 md:hidden">
              {sections.map((section) => (
                <li
                  key={section.id}
                  className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base font-medium text-neutral-900">{sectionLabel(section.name)}</h3>
                    <Badge tone={STATUS_TONE[section.status]}>
                      {SECTION_STATUS_LABEL[section.status]}
                    </Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-neutral-500">Teacher</dt>
                      <dd className="text-neutral-800">
                        {section.teacher ? section.teacher.name : "Not assigned"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-neutral-500">Students</dt>
                      <dd className="tabular-nums text-neutral-800">
                        {section.studentCount.toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                  {editable && !section.teacher ? (
                    <QuickAssignTeacher
                      sectionId={section.id}
                      sectionName={section.name}
                      teachers={teachers}
                    />
                  ) : null}
                  <Link
                    href={`${BASE}/${detail.id}/sections/${section.id}`}
                    className={LINK_SECONDARY}
                  >
                    Manage {sectionLabel(section.name)}
                  </Link>
                </li>
              ))}
            </ul>

            {/* Tablets and up: a table. */}
            <div className="hidden md:block">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Section</th>
                    <th className="py-2 pr-4 font-medium">Teacher</th>
                    <th className="py-2 pr-4 font-medium">Students</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sections.map((section) => (
                    <tr key={section.id} className="border-b border-neutral-100 align-top">
                      <td className="py-3 pr-4 text-sm font-medium text-neutral-900">
                        {sectionLabel(section.name)}
                      </td>
                      <td className="py-3 pr-4 text-sm text-neutral-700">
                        {section.teacher ? (
                          section.teacher.name
                        ) : editable ? (
                          <div className="flex flex-col gap-2">
                            <span className="text-neutral-500">Not assigned</span>
                            <QuickAssignTeacher
                              sectionId={section.id}
                              sectionName={section.name}
                              teachers={teachers}
                            />
                          </div>
                        ) : (
                          <span className="text-neutral-500">Not assigned</span>
                        )}
                        {section.otherTeachers.length > 0 ? (
                          <p className="mt-1 text-xs text-neutral-500">
                            Also: {section.otherTeachers.map((teacher) => teacher.name).join(", ")}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-sm tabular-nums text-neutral-700">
                        {section.studentCount.toLocaleString()}
                      </td>
                      <td className="py-3 pr-4">
                        <Badge tone={STATUS_TONE[section.status]}>
                          {SECTION_STATUS_LABEL[section.status]}
                        </Badge>
                      </td>
                      <td className="py-3 text-right">
                        <Link
                          href={`${BASE}/${detail.id}/sections/${section.id}`}
                          className={LINK_SECONDARY}
                          aria-label={`Manage ${sectionLabel(section.name)}`}
                        >
                          Manage
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {editable && teachers.length === 0 && sections.some((section) => !section.teacher) ? (
          <p className="text-xs text-neutral-500">
            No teachers are available to choose yet. Open a section to add a new teacher.
          </p>
        ) : null}
      </Panel>

      {editable ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Add a section" description={`Adds a section to ${detail.name} for ${year.name}.`}>
            <AddSectionForm
              classId={detail.id}
              yearId={year.id}
              teachers={teachers}
              suggestion={suggestion}
            />
          </Panel>
          <Panel title="Class name">
            <RenameClassForm classId={detail.id} yearId={year.id} name={detail.name} />
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
