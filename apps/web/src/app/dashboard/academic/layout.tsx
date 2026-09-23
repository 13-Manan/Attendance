import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAcademicUnitLabels, resolveAttendanceMode } from "@/modules/institutions/service";
import { AcademicTabs } from "./academic-tabs";

const SECTIONS = [
  { href: "/dashboard/academic/sessions", label: "Academic sessions" },
  { href: "/dashboard/academic/units", label: "Classes / units" },
  { href: "/dashboard/academic/cohorts", label: "Cohorts" },
  { href: "/dashboard/academic/subjects", label: "Subjects (college)" },
  { href: "/dashboard/academic/enrollments", label: "Enrollments" },
];

/**
 * A school sees two tabs in its own words. Everything a school sets up — its
 * classes, their sections and who teaches them — lives under Classes; the
 * structure, cohort and enrollment screens a college uses are the same rows
 * one table at a time, and their routes still answer if bookmarked.
 */
const SCHOOL_SECTIONS = [
  { href: "/dashboard/academic/sessions", label: "Academic year" },
  { href: "/dashboard/academic/classes", label: "Classes" },
];

export default async function AcademicLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");

  let institutionLine: string | null = null;
  if (user.institutionId) {
    const institution = await getInstitutionById(user.institutionId);
    if (institution?.type === "SCHOOL") {
      return (
        <div className="flex flex-col gap-4">
          <header className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-neutral-900 sm:text-2xl">Academic setup</h1>
            <p className="text-sm text-neutral-500">
              Set the academic year, then add classes, their sections and their teachers.
            </p>
          </header>
          <AcademicTabs tabs={SCHOOL_SECTIONS} />
          <div>{children}</div>
        </div>
      );
    }
    if (institution) {
      const labels = resolveAcademicUnitLabels(institution);
      const mode = resolveAttendanceMode(institution);
      institutionLine = `${institution.name} · ${institution.type} · ${mode === "DAILY" ? "Daily attendance" : "Subject-wise attendance"} · Labels: ${labels.GRADE}/${labels.SECTION}`;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-neutral-900">Academic management</h1>
        {institutionLine && <p className="text-xs text-neutral-500">{institutionLine}</p>}
      </header>
      <nav className="flex flex-wrap gap-2 border-b border-neutral-200 pb-2 text-sm">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="rounded-md px-3 py-1 text-neutral-700 hover:bg-neutral-100"
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  );
}
