import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getStudentFormOptionsForRequest } from "@/modules/students/directory-service";
import {
  classNavigationAvailable,
  findSectionForRequest,
} from "@/modules/students/class-navigation-service";
import { studentSectionHref } from "@/modules/students/class-navigation-paths";
import type { StudentSectionView } from "@/modules/students/class-navigation-types";
import { BackToParent } from "@/components/nav/back-to-parent";
import { StudentForm } from "../student-form";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Admit a student.
 *
 * The same form as the edit page, in create mode. The institution is not a
 * field on it — it comes from the session inside the service — so there is
 * nothing on this page that a crafted submission could point at another
 * school, which is what the earlier hidden `institutionId` input made possible
 * in principle.
 *
 * Opened from a section (`?cohortId=`), the class the student is placed in
 * starts as that section and the page leads back to it. It is still the same
 * class field, checked by the same service when the form is sent, and it can
 * still be changed; an id that is not one of this school's classes is simply
 * not preselected.
 */
export default async function NewStudentPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("student.create");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is nowhere to
        admit a student from here. Sign in as an institution administrator.
      </p>
    );
  }

  // The dropdowns need `student.read`, which every role that may admit a
  // student also holds. A role configured with one and not the other still
  // gets a working form: without the options there is no campus or class to
  // pick, and both are optional at admission.
  const canRead = hasPermission(user, "student.read");
  const canPlace = hasPermission(user, "enrollment.manage");
  const options = canRead
    ? await getStudentFormOptionsForRequest(user)
    : { campuses: [], cohorts: [] };

  const params = await searchParams;
  const requested = typeof params.cohortId === "string" ? params.cohortId : undefined;
  const defaultCohortId =
    canPlace && requested && options.cohorts.some((cohort) => cohort.id === requested)
      ? requested
      : undefined;
  const section = defaultCohortId ? await sectionOf(user, defaultCohortId) : null;
  const sectionHref = section ? studentSectionHref(section.classId, section.section.id) : null;

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <BackToParent
        href={sectionHref ?? "/dashboard/students"}
        label={section ? `${section.className} · ${section.section.label}` : "Students"}
      />

      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Add student</h1>
        {section ? (
          <p className="max-w-xl text-sm text-neutral-700">
            They will be placed in{" "}
            <span className="font-medium text-neutral-900">
              {section.className} · {section.section.label}
            </span>{" "}
            ({section.section.groupName}, {section.year.name}).
          </p>
        ) : null}
        <p className="max-w-xl text-sm text-neutral-500">
          Only a name and a student code are required. Everything else — admission details, campus,
          class — can be filled in now or later from the student&apos;s record.
        </p>
      </header>

      <StudentForm
        mode="create"
        options={options}
        canPlace={canPlace}
        defaultCohortId={defaultCohortId}
        returnTo={sectionHref ?? undefined}
      />
    </div>
  );
}

/** The section a class group is, when the class-first view applies and it is one. */
async function sectionOf(
  user: Awaited<ReturnType<typeof requirePermissionOrRedirect>>,
  cohortId: string,
): Promise<StudentSectionView | null> {
  if (!(await classNavigationAvailable(user))) return null;
  return findSectionForRequest(user, cohortId).catch(() => null);
}
