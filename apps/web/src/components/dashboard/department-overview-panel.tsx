import Link from "next/link";
import type { CollegeHome } from "@/modules/college-setup/types";
import { StatCard } from "@/components/ui/attendance-stat";
import { Panel } from "@/components/ui/panel";

/**
 * A head of department's department, at the top of their Overview: which one,
 * which session and semester, how large it is, and what still needs doing.
 * Below it the page carries on as it does for any lecturer — their own
 * classes, today's registers, their review queue.
 */
export function DepartmentOverviewPanel({ home }: { home: CollegeHome }) {
  const department = `/dashboard/college/departments/${encodeURIComponent(home.department.id)}`;
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
        <StatCard label="Courses" value={String(home.counts.courses)} hint={`${home.counts.semesters} semesters`} />
        <StatCard label="Sections" value={String(home.counts.sections)} hint="This session" />
        <StatCard label="Faculty" value={String(home.counts.faculty)} />
        <StatCard label="Students" value={String(home.counts.students)} hint="In the department's sections" />
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
      <nav aria-label="Department" className="flex flex-wrap gap-2">
        {[
          { href: "/dashboard/college/semesters", label: "Semesters" },
          { href: "/dashboard/college/courses", label: "Courses" },
          { href: "/dashboard/college/sections", label: "Sections" },
          { href: `${department}/faculty`, label: "Faculty" },
          { href: `${department}/students`, label: "Students" },
        ].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="inline-flex min-h-10 items-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:outline-none"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </Panel>
  );
}
