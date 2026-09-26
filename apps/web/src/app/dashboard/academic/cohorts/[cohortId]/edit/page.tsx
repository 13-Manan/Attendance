import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  getCohortDetailForRequest,
  getCohortFormOptionsForRequest,
} from "@/modules/cohorts/directory-service";
import { COHORT_WORDS, CohortError, type CohortDetail } from "@/modules/cohorts/directory-types";
import { PageTrail } from "@/components/nav/page-trail";
import { Panel } from "@/components/ui/panel";
import { CohortForm } from "../../cohort-form";

interface PageProps {
  params: Promise<{ cohortId: string }>;
}

/**
 * Rename one class.
 *
 * Gated on `cohort.manage`, which is also what `cohort.read` would require
 * here — the form has to show the current values to be an edit rather than a
 * re-entry, and the same institution-scoped read serves both. An id copied from
 * another institution's URL is a 404, not a form pre-filled with their class.
 *
 * Only the label is editable. Where the class sits and which year it belongs to
 * are shown as facts, for the reason recorded in `cohort-form.tsx`.
 */
export default async function EditCohortPage({ params }: PageProps) {
  const user = await requirePermissionOrRedirect("cohort.manage");
  const { cohortId } = await params;

  let cohort: CohortDetail;
  try {
    cohort = await getCohortDetailForRequest(user, cohortId);
  } catch (error) {
    if (error instanceof CohortError) notFound();
    throw error;
  }

  const options = await getCohortFormOptionsForRequest(user);
  const words = COHORT_WORDS[options.institutionType];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Academic", href: "/dashboard/academic" },
          { label: words.Plural, href: "/dashboard/academic/cohorts" },
          { label: cohort.name, href: `/dashboard/academic/cohorts/${cohort.id}` },
          { label: "Edit" },
        ]}
      />

      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-900">Rename {words.singular}</h2>
        <p className="text-sm text-neutral-500">
          {cohort.academicUnitName} · {cohort.academicSessionName}
        </p>
      </header>

      <Panel title={`${words.Singular} details`}>
        <CohortForm mode="edit" cohort={cohort} options={options} />
      </Panel>
    </div>
  );
}
