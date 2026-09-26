import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { logout } from "@/modules/auth-tenancy/actions";
import { hasPermission } from "@/modules/authorization/service";
import { describeEnrollment, getStudentDashboard } from "@/modules/attendance-analytics/service";
import { getInstitutionIdentity } from "@/modules/institutions/repository";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import { ChangePasswordForm } from "./change-password-form";

/**
 * The student account: who it belongs to, its password, and signing out.
 *
 * One account per student, used by the student and by their parents, on as
 * many phones and computers as they like — so the words here say "this
 * account", never "your device". Everything shown is the signed-in student's
 * own, resolved from the session; nothing on this page takes a student id.
 */
export default async function StudentAccountPage() {
  const user = await requirePermissionOrRedirect("student.read.own");
  const [dashboard, institution] = await Promise.all([
    hasPermission(user, "attendanceRecord.read.own") ? getStudentDashboard(user) : null,
    user.institutionId ? getInstitutionIdentity(user.institutionId) : null,
  ]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Account</h1>
        <p className="text-sm text-neutral-500">
          This student account can be signed in on several phones and computers at once — by the
          student and by their parents.
        </p>
      </header>

      <Panel title="Profile">
        {dashboard ? (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="Name">{dashboard.fullName}</Detail>
            <Detail label="Student ID">
              <span className="font-mono">{dashboard.studentCode}</span>
            </Detail>
            <Detail label="School">{institution?.name ?? "—"}</Detail>
            <Detail label={dashboard.attendanceMode === "SUBJECT_WISE" ? "Programme" : "Class"}>
              {dashboard.enrollments.length === 0 ? (
                <span className="text-neutral-400">Not placed yet</span>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {dashboard.enrollments.map((enrollment) => (
                    <li key={enrollment.cohortId}>{describeEnrollment(enrollment).join(" · ")}</li>
                  ))}
                </ul>
              )}
            </Detail>
          </dl>
        ) : (
          <EmptyState>
            This account is not linked to a student yet. Please contact your school.
          </EmptyState>
        )}
      </Panel>

      <Panel
        title="Password"
        description="Changing it signs out every other phone or computer using this account."
      >
        <ChangePasswordForm />
      </Panel>

      <Panel title="Sign out" description="Signs out this phone or computer only.">
        <form action={logout}>
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{children}</dd>
    </div>
  );
}
