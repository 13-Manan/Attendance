import Link from "next/link";
import { requireUser } from "@/modules/auth-tenancy/session";
import { getInstitutionIdentity } from "@/modules/institutions/repository";
import { Topbar } from "@/components/nav/topbar";

// All about the student's own data. Kept inline rather than in NAV_ITEMS:
// that list is the staff sidebar's, and the portal is deliberately not a
// smaller dashboard.
const PORTAL_LINKS = [
  { href: "/portal", label: "Overview" },
  { href: "/portal/attendance", label: "My attendance" },
  { href: "/portal/enroll-face", label: "Face enrollment" },
] as const;

/**
 * The student portal. Deliberately separate from /dashboard: dashboard is
 * for staff/faculty, portal is for students. Same auth (server session) but
 * a different, minimal shell — no admin sidebar.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Same reason as the staff shell: a student should be able to see which
  // institution's record they are looking at, resolved from the server session
  // rather than anything the page was asked for.
  const institution = user.institutionId
    ? await getInstitutionIdentity(user.institutionId)
    : null;

  return (
    <div className="flex min-h-screen flex-col">
      <Topbar user={user} institutionName={institution?.name ?? null} />
      {/* Scrolls sideways rather than wrapping or squashing once a phone runs
          out of width. */}
      <nav className="flex gap-4 overflow-x-auto border-b border-neutral-200 px-4 py-2 sm:px-6">
        {PORTAL_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="shrink-0 whitespace-nowrap text-sm text-neutral-600 hover:text-neutral-900 hover:underline"
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
