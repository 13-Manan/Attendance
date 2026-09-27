import Link from "next/link";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getSemestersIndex } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { departmentHref, readOrDeny, semesterHref } from "@/app/dashboard/college/shared";

/**
 * Every semester the viewer may see, by department. Semesters are added and
 * changed on the department's own page; this is the way into them.
 */
export default async function SemestersIndexPage() {
  const user = await requireUser();
  const result = await readOrDeny(() => getSemestersIndex(user));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-5xl flex-col gap-5">
        <PageTrail items={[{ label: "Semesters" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const { departments } = result.value;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <PageTrail items={[{ label: "Semesters" }]} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Semesters</h1>
        <p className="text-sm text-neutral-500">
          Each department&apos;s semesters, in programme order. Open one to see and add its courses.
        </p>
      </header>

      {departments.length === 0 ? (
        <EmptyState>No departments yet. Semesters are added to a department.</EmptyState>
      ) : (
        departments.map((department) => (
          <Panel
            key={department.id}
            title={department.code ? `${department.name} (${department.code})` : department.name}
            action={
              <Link
                href={departmentHref(department.id)}
                className="text-sm font-medium text-neutral-700 underline underline-offset-2"
              >
                Add or change semesters
              </Link>
            }
          >
            {department.semesters.length === 0 ? (
              <EmptyState>No semesters in {department.name} yet.</EmptyState>
            ) : (
              <ul className="flex flex-col divide-y divide-neutral-100">
                {department.semesters.map((semester) => (
                  <li key={semester.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={semesterHref(department.id, semester.id)}
                        className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                      >
                        {semester.name}
                      </Link>
                      {semester.id === department.currentSemesterId ? <Badge tone="info">Current</Badge> : null}
                    </div>
                    <span className="text-sm text-neutral-500">
                      {semester.courses} {semester.courses === 1 ? "course" : "courses"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ))
      )}
    </div>
  );
}
