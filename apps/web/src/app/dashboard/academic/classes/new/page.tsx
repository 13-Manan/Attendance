import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionType } from "@/modules/institutions/repository";
import { getNewClassContext } from "@/modules/school-setup/service";
import { EmptyState, Panel } from "@/components/ui/panel";
import { NewClassForm } from "../class-controls";
import { first } from "../shared";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewClassPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("cohort.manage");
  if (!user.institutionId) redirect("/dashboard");
  if ((await getInstitutionType(user.institutionId)) !== "SCHOOL") {
    redirect("/dashboard/academic/cohorts");
  }

  const params = await searchParams;
  const { year, teachers, from } = await getNewClassContext(
    user,
    first(params.year),
    first(params.from),
  );

  const back = year
    ? `/dashboard/academic/classes?year=${encodeURIComponent(year.id)}`
    : "/dashboard/academic/classes";

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={back} className="text-sm text-neutral-500 hover:text-neutral-900 hover:underline">
          &larr; Back to classes
        </Link>
        <h2 className="text-lg font-semibold text-neutral-900">
          {from ? `Set up ${from.name}` : "Add class"}
        </h2>
        {year ? (
          <p className="text-sm text-neutral-500">For academic year {year.name}.</p>
        ) : null}
      </div>

      {!year ? (
        <EmptyState>
          No academic year is currently active. Select an academic year to continue setting up
          your school.{" "}
          <Link href="/dashboard/academic/sessions" className="font-medium text-neutral-900 underline">
            Go to Academic year
          </Link>
        </EmptyState>
      ) : !year.isActive ? (
        <EmptyState>
          {year.name} is archived, so classes can&apos;t be added to it. Choose an open year.
        </EmptyState>
      ) : (
        <Panel title="Class details" description="All fields can be changed later.">
          <NewClassForm
            yearId={year.id}
            yearName={year.name}
            teachers={teachers}
            initialName={from?.name ?? ""}
            initialSections={from?.sectionNames ?? []}
          />
        </Panel>
      )}
    </div>
  );
}
