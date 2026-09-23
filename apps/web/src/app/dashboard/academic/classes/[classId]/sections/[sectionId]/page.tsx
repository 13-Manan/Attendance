import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getInstitutionType } from "@/modules/institutions/repository";
import { getSectionDetail } from "@/modules/school-setup/service";
import { sectionLabel } from "@/modules/school-setup/policy";
import { SECTION_STATUS_LABEL } from "@/modules/school-setup/types";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import {
  InviteTeacherForm,
  RemoveSectionControl,
  RemoveTeacherButton,
  RenameSectionForm,
  SectionTeacherForm,
} from "../../../class-controls";
import { LINK_SECONDARY, STATUS_TONE } from "../../../shared";

interface PageProps {
  params: Promise<{ classId: string; sectionId: string }>;
}

/**
 * One section in one academic year: its teacher, its students, its name, and
 * — only when nothing has happened in it yet — the way to remove it.
 */
export default async function SectionPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) redirect("/dashboard");
  if ((await getInstitutionType(user.institutionId)) !== "SCHOOL") {
    redirect("/dashboard/academic/cohorts");
  }

  const { classId, sectionId } = await params;
  const detail = await getSectionDetail(user, sectionId);
  // A section reached through another class's URL is not this class's section.
  if (!detail || detail.classId !== classId) notFound();

  const { section, year, removal } = detail;
  const canAssign = hasPermission(user, "cohort.manage") && year.isActive;
  const canInvite = canAssign && hasPermission(user, "user.invite");
  const canChangeStructure =
    canAssign && hasPermission(user, "academicStructure.manage");
  const classHref = `/dashboard/academic/classes/${detail.classId}?year=${encodeURIComponent(year.id)}`;

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={classHref} className="text-sm text-neutral-500 hover:text-neutral-900 hover:underline">
          &larr; Back to {detail.className}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-neutral-900">
            {detail.className} · {sectionLabel(section.name)}
          </h2>
          <Badge tone={STATUS_TONE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
        </div>
        <p className="text-sm text-neutral-500">
          Academic year {year.name} · shown elsewhere as {section.groupName}
        </p>
      </div>

      {!year.isActive ? (
        <p role="status" className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700">
          {year.name} is archived, so this section is shown as it was and can&apos;t be changed.
        </p>
      ) : null}

      <Panel
        title="Teacher"
        description="The teacher takes attendance for this section and sees it on their dashboard."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-md bg-neutral-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col">
              <span className="text-xs text-neutral-500">Current teacher</span>
              <span className="text-base font-medium text-neutral-900">
                {section.teacher ? section.teacher.name : "Not assigned"}
              </span>
              {section.teacher && !section.teacher.active ? (
                <span className="text-xs text-red-700">
                  Their access has been stopped, so they can&apos;t sign in. Choose another
                  teacher or restore their access on the Faculty page.
                </span>
              ) : null}
            </div>
            {canAssign && section.teacher ? (
              <RemoveTeacherButton sectionId={section.id} teacherName={section.teacher.name} />
            ) : null}
          </div>

          {section.otherTeachers.length > 0 ? (
            <p className="text-sm text-neutral-600">
              Also teaching this section:{" "}
              {section.otherTeachers.map((teacher) => teacher.name).join(", ")}. Manage them on the
              Faculty page.
            </p>
          ) : null}

          {canAssign ? (
            <SectionTeacherForm
              sectionId={section.id}
              currentTeacherId={section.teacher?.userId ?? null}
              teachers={detail.teachers}
            />
          ) : null}
          {canInvite ? <InviteTeacherForm sectionId={section.id} /> : null}
        </div>
      </Panel>

      <Panel title="Students">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-neutral-700">
            {section.studentCount === 0
              ? "No students are in this section yet."
              : `${section.studentCount.toLocaleString()} ${section.studentCount === 1 ? "student is" : "students are"} in this section.`}
          </p>
          <Link
            href={`/dashboard/students?cohortId=${encodeURIComponent(section.id)}`}
            className={LINK_SECONDARY}
          >
            {section.studentCount === 0 ? "Go to Students" : "View students"}
          </Link>
        </div>
      </Panel>

      {canChangeStructure ? (
        <Panel title="Section name">
          <RenameSectionForm
            sectionId={section.id}
            name={section.name}
            sharedAcrossYears={detail.sharedAcrossYears}
          />
        </Panel>
      ) : null}

      {canChangeStructure ? (
        <Panel
          title="Remove section"
          description="Only a section with no students, attendance or subjects can be removed."
        >
          {removal.allowed ? (
            <RemoveSectionControl
              sectionId={section.id}
              yearId={year.id}
              sectionName={section.name}
              className={detail.className}
              yearName={year.name}
              teacherName={section.teacher?.name ?? null}
              lastSection={detail.sectionsInYear <= 1}
            />
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-sm font-medium text-neutral-900">
                {sectionLabel(section.name)} can&apos;t be removed:
              </p>
              <ul className="list-disc pl-5 text-sm text-neutral-700">
                {removal.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p className="text-xs text-neutral-500">
                This protects attendance and student records. You can still rename the section or
                change its teacher.
              </p>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
