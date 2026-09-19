import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getCohortFormOptionsForRequest } from "@/modules/cohorts/directory-service";
import { COHORT_WORDS } from "@/modules/cohorts/directory-types";
import { Panel } from "@/components/ui/panel";
import { CohortForm } from "../cohort-form";

/**
 * Create a class.
 *
 * Gated on `cohort.manage` at the door as well as in the service: the service
 * check is the one that protects the data, this one is what stops somebody who
 * cannot use the form from being shown it.
 */
export default async function NewCohortPage() {
  const user = await requirePermissionOrRedirect("cohort.manage");
  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no structure
        to create a class in.
      </p>
    );
  }

  const options = await getCohortFormOptionsForRequest(user);
  const words = COHORT_WORDS[options.institutionType];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link
          href="/dashboard/academic/cohorts"
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          ← Back to {words.plural}
        </Link>
        <h2 className="text-lg font-semibold text-neutral-900">New {words.singular}</h2>
        <p className="max-w-2xl text-sm text-neutral-500">
          {options.institutionType === "COLLEGE"
            ? "A section of a semester, for one academic year. Subjects and who teaches them are added once it exists."
            : "A class for one academic year. The class teacher and the students are added once it exists."}
        </p>
      </header>

      <Panel title={`${words.Singular} details`}>
        <CohortForm mode="create" options={options} />
      </Panel>
    </div>
  );
}
