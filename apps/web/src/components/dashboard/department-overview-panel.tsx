import Link from "next/link";
import type { CollegeHome } from "@/modules/college-setup/types";
import { StatCard } from "@/components/ui/attendance-stat";
import { Panel } from "@/components/ui/panel";

/**
 * A head of department's department, at the top of their Overview: which one,
 * which session and semester, how large it is, what still needs doing, and
 * the four things they most often come to do. The sidebar already lists the
 * department's pages, so this does not repeat them. Below it the page carries
 * on as it does for any lecturer — their own classes, today's registers,
 * their review queue.
 */
export function DepartmentOverviewPanel({ home }: { home: CollegeHome }) {
  const department = `/dashboard/college/departments/${encodeURIComponent(home.department.id)}`;
  // A section is added on its course's page, so + Add section starts on Courses.
  const actions = [
    { href: `${department}/students/add`, label: "+ Add student" },
    { href: `${department}/faculty?add=faculty`, label: "+ Add faculty" },
    { href: "/dashboard/college/courses?add=course", label: "+ Add course" },
    { href: "/dashboard/college/courses", label: "+ Add section" },
  ];
  return (
    <Panel
      title={home.department.code ? `${home.department.name} (${home.department.code})` : home.department.name}
      description={[
        "Your department",
        home.session ? `Academic session ${home.session.name}` : "No academic session yet",
        home.currentSemester ? `Current semester: ${home.currentSemester.name}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      action={
        <Link href={department} className="text-xs text-neutral-600 hover:underline">
          Open department
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Students" value={String(home.counts.students)} hint="In the department's sections" />
        <StatCard label="Faculty" value={String(home.counts.faculty)} />
        <StatCard
          label="Courses"
          value={String(home.counts.courses)}
          hint={`${home.counts.semesters} ${home.counts.semesters === 1 ? "semester" : "semesters"}`}
        />
        <StatCard label="Sections" value={String(home.counts.sections)} hint="This session" />
      </div>
      {home.sectionsNeedingTeacher > 0 ? (
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {home.sectionsNeedingTeacher === 1 ? "1 section needs" : `${home.sectionsNeedingTeacher} sections need`} a
          teacher before attendance can be taken.{" "}
          <Link href="/dashboard/college/sections?show=needs-teacher" className="font-medium underline underline-offset-2">
            Show them
          </Link>
        </p>
      ) : null}
      <nav aria-label="Department quick actions" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {actions.map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:outline-none sm:min-h-10"
          >
            {action.label}
          </Link>
        ))}
      </nav>
    </Panel>
  );
}
