import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAcademicUnitLabels, resolveAttendanceMode } from "@/modules/institutions/service";

const SECTIONS = [
  { href: "/dashboard/academic/sessions", label: "Academic sessions" },
  { href: "/dashboard/academic/units", label: "Classes / units" },
  { href: "/dashboard/academic/cohorts", label: "Cohorts" },
  { href: "/dashboard/academic/subjects", label: "Subjects (college)" },
  { href: "/dashboard/academic/enrollments", label: "Enrollments" },
];

export default async function AcademicLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePermissionOrRedirect("academicStructure.manage");

  let institutionLine: string | null = null;
  if (user.institutionId) {
    const institution = await getInstitutionById(user.institutionId);
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
