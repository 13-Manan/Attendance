import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { subjectsApplyForRequest } from "@/modules/subjects/directory-service";
import { BackToParent } from "@/components/nav/back-to-parent";
import { Panel } from "@/components/ui/panel";
import { SubjectForm } from "../subject-form";

/**
 * Add a subject.
 *
 * The college check happens here as well as in the service so a school
 * administrator who reached this URL reads an explanation rather than filling
 * in a form that is refused on submit.
 */
export default async function NewSubjectPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no subjects
        to add.
      </p>
    );
  }

  if (!(await subjectsApplyForRequest(user))) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-900">Subjects</h2>
        <p className="text-sm text-neutral-500">
          Subjects belong to colleges. A school takes one register a day for the whole class, so
          there is nothing to attach a subject to.
        </p>
        <Link
          href="/dashboard/academic/cohorts"
          className="text-sm text-neutral-600 underline hover:text-neutral-900"
        >
          Go to classes
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <BackToParent href="/dashboard/academic/subjects" label="Subjects" />
        <h2 className="text-lg font-semibold text-neutral-900">New subject</h2>
        <p className="max-w-2xl text-sm text-neutral-500">
          The subject as the college lists it. Which sections offer it, and who teaches each one,
          is set on the section afterwards.
        </p>
      </header>

      <Panel title="Subject details">
        <SubjectForm mode="create" />
      </Panel>
    </div>
  );
}
