import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { listKnownTwinPairs, listTwinConfirmations } from "@/modules/twin-confirmation/service";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState } from "@/components/ui/panel";
import { departmentHref, departmentPeopleHref, departmentTrail, first, readOrDeny } from "@/app/dashboard/college/shared";
import { KnownPairsSection } from "@/app/dashboard/students/twin-confirmations/known-pairs";
import { TwinConfirmationListView } from "@/app/dashboard/students/twin-confirmations/twin-views";

interface PageProps {
  params: Promise<{ departmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * A college department's twin / lookalike confirmations: the pairs where both
 * students are in the department's current sections, for its head — or for an
 * administrator looking at the department. A head of another department, or
 * anybody who is neither, is refused by the department scope check.
 */
export default async function DepartmentTwinConfirmationsPage({ params, searchParams }: PageProps) {
  const user = await requireUser();
  const { departmentId } = await params;
  const query = await searchParams;

  const result = await readOrDeny(() =>
    Promise.all([listTwinConfirmations(user, { departmentId }), listKnownTwinPairs(user, { departmentId })]),
  );
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-4xl flex-col gap-5">
        <PageTrail items={[{ label: "Twin / Lookalike confirmations" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const [list, known] = result.value;
  const department = list.reviewer.department ?? { id: departmentId, name: "Department" };
  const studentsHref = departmentPeopleHref(department.id, "students");
  const here = departmentPeopleHref(department.id, "students", "twin-confirmations");
  const trail = departmentTrail({
    viewer: hasPermission(user, "academicStructure.manage") ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    list: { label: "Students", href: studentsHref },
    leaf: { label: "Twin / Lookalike confirmations" },
  });

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Twin / Lookalike confirmations</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          When a student&apos;s face matches another enrolled student, face enrollment stops until you decide. Confirm a
          pair only if they are two different people; a student can never confirm this for themselves.
        </p>
      </header>
      <TwinConfirmationListView
        list={list}
        itemHref={(pair) => `${here}/${encodeURIComponent(pair)}`}
        decided={first(query.decided) ?? null}
        known={
          <KnownPairsSection
            list={known}
            departmentId={department.id}
            initialStudentId={first(query.declare) ?? null}
            studentHref={(studentId) => departmentPeopleHref(department.id, "students", studentId)}
          />
        }
      />
    </div>
  );
}
