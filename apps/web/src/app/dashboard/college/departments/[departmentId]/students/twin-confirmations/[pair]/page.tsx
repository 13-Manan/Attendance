import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getTwinConfirmation } from "@/modules/twin-confirmation/service";
import { TwinConfirmationError } from "@/modules/twin-confirmation/types";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState } from "@/components/ui/panel";
import { departmentHref, departmentPeopleHref, departmentTrail, readOrDeny } from "@/app/dashboard/college/shared";
import { TwinConfirmationReviewView } from "@/app/dashboard/students/twin-confirmations/twin-views";

interface PageProps {
  params: Promise<{ departmentId: string; pair: string }>;
}

/**
 * One pair, decided from the department: only a pair whose two students are
 * both in the department's current sections. Anything else is a 404 here —
 * a cross-department pair is the Director's, on the college-wide page.
 */
export default async function DepartmentTwinConfirmationReviewPage({ params }: PageProps) {
  const user = await requireUser();
  const { departmentId, pair } = await params;

  const result = await readOrDeny(async () => {
    try {
      return await getTwinConfirmation(user, decodeURIComponent(pair), { departmentId });
    } catch (error) {
      if (error instanceof TwinConfirmationError) return null;
      throw error;
    }
  });
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-5">
        <PageTrail items={[{ label: "Twin / Lookalike confirmations" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const detail = result.value;
  if (!detail) notFound();

  const department = detail.reviewer.department ?? { id: departmentId, name: "Department" };
  const list = departmentPeopleHref(department.id, "students", "twin-confirmations");
  const { blocked, matched } = detail.item;
  const trail = departmentTrail({
    viewer: hasPermission(user, "academicStructure.manage") ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    list: { label: "Students", href: departmentPeopleHref(department.id, "students") },
    leaf: { label: "Twin / Lookalike confirmations", href: list },
    subleaf: `${blocked.firstName} ${blocked.lastName} & ${matched.firstName} ${matched.lastName}`,
  });

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Review twin / lookalike confirmation</h1>
        <p className="text-sm text-neutral-500">
          Decide whether these two students are different people. The decision applies to this pair only.
        </p>
      </header>
      <TwinConfirmationReviewView detail={detail} departmentId={department.id} listHref={list} />
    </div>
  );
}
