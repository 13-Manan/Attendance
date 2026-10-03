import { redirect } from "next/navigation";
import { logout } from "@/modules/auth-tenancy/actions";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission, isPlatformUser } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getCollegeHome } from "@/modules/college-setup/service";
import { isReceptionist } from "@/modules/receptionists/catalog";
import { CollegeSetupError } from "@/modules/college-setup/types";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { PageTrail } from "@/components/nav/page-trail";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

/**
 * A head of department's or a school receptionist's own account: who they are
 * signed in as, a new password of their choosing, and signing out.
 *
 * Changing the password keeps this device signed in and signs every other
 * one out — the same rule as the student portal, from the same service. An
 * administrator resets a head's password from the department page instead;
 * nobody can read one back.
 */
export default async function AccountPage() {
  const user = await requireUser();
  // A head of department's page, and a receptionist's; the platform role holds
  // every permission but is neither.
  const receptionist = isReceptionist(user);
  const headOfDepartment = hasPermission(user, "department.manage") && !isPlatformUser(user);
  if (!headOfDepartment && !receptionist) redirect("/unauthorized");

  // The account works whatever state the department designation is in: a head
  // whose department was changed elsewhere can still change their password.
  let home: Awaited<ReturnType<typeof getCollegeHome>> = null;
  if (headOfDepartment) {
    try {
      home = await getCollegeHome(user);
    } catch (error) {
      if (!(error instanceof ForbiddenError) && !(error instanceof CollegeSetupError)) throw error;
    }
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <PageTrail items={[{ label: "My account" }]} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">My account</h1>
        <p className="text-sm text-neutral-500">Your sign-in details and password.</p>
      </header>

      <Panel title="Profile">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Name</dt>
            <dd className="text-neutral-900">{user.name}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Login</dt>
            <dd className="break-all font-mono text-neutral-900">{user.email}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Role</dt>
            <dd className="text-neutral-900">{headOfDepartment ? "Head of Department" : "Receptionist"}</dd>
          </div>
          {headOfDepartment ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Department</dt>
              <dd className="text-neutral-900">
                {home ? home.department.name : <span className="text-neutral-400">Not currently heading one</span>}
              </dd>
            </div>
          ) : null}
        </dl>
      </Panel>

      <Panel
        title="Change password"
        description="Your other devices are signed out when it changes; this one stays signed in."
      >
        <ChangePasswordForm hint="At least 8 characters. Not the same as your email address." />
      </Panel>

      <Panel title="Sign out" description="Signs out this device only.">
        <form action={logout}>
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </Panel>
    </div>
  );
}
