import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getSubjectForRequest } from "@/modules/subjects/directory-service";
import { SubjectError, type SubjectRow } from "@/modules/subjects/directory-types";
import { PageTrail } from "@/components/nav/page-trail";
import { Panel } from "@/components/ui/panel";
import { SubjectForm } from "../../subject-form";

interface PageProps {
  params: Promise<{ subjectId: string }>;
}

/**
 * Correct one subject.
 *
 * An id copied from another institution's URL is a 404 rather than a form
 * pre-filled with their subject: the read is institution-scoped, and "does not
 * exist" is the only answer it gives.
 */
export default async function EditSubjectPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  const { subjectId } = await params;

  let subject: SubjectRow;
  try {
    subject = await getSubjectForRequest(user, subjectId);
  } catch (error) {
    if (error instanceof SubjectError) notFound();
    throw error;
  }

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Academic", href: "/dashboard/academic" },
          { label: "Subjects", href: "/dashboard/academic/subjects" },
          { label: subject.name },
        ]}
      />

      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-900">{subject.name}</h2>
        <p className="text-sm text-neutral-500">{subject.code}</p>
      </header>

      <Panel title="Subject details">
        <SubjectForm mode="edit" subject={subject} />
      </Panel>
    </div>
  );
}
