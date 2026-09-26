import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getStudentProfileByUserId } from "@/modules/attendance-analytics/repository";
import { resolveSelfEnrollmentEnabled } from "@/modules/face-enrollment/policy";
import { getInstitutionById } from "@/modules/institutions/repository";
import { NavLink } from "@/components/nav/nav-link";
import { Topbar } from "@/components/nav/topbar";
import { portalLinks } from "@/components/portal/portal-links";

// All about the student's own data. Kept inline rather than in NAV_ITEMS:
// that list is the staff sidebar's, and the portal is deliberately not a
// smaller dashboard.
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
  const [institution, student] = await Promise.all([
    user.institutionId ? getInstitutionById(user.institutionId) : null,
    getStudentProfileByUserId(user.userId),
  ]);
  const links = portalLinks({
    faceEnrollment:
      hasPermission(user, "faceEmbedding.enroll.own") &&
      Boolean(institution && resolveSelfEnrollmentEnabled(institution)),
  });

  return (
    <div className="flex min-h-screen flex-col">
      <Topbar
        user={user}
        institutionName={institution?.name ?? null}
        // A student account is known by its student ID; its email may be a
        // stand-in that means nothing to anyone.
        accountLabel={student ? `Student account · ${student.studentCode}` : undefined}
      />
      {/* Scrolls sideways rather than wrapping or squashing once a phone runs
          out of width. */}
      <nav
        aria-label="Student"
        className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-2 py-2 sm:gap-2 sm:px-4 print:hidden"
      >
        {links.map((link) => (
          <NavLink
            key={link.href}
            href={link.href}
            label={link.label}
            siblingHrefs={links.map((l) => l.href)}
          />
        ))}
      </nav>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
