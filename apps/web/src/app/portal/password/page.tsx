import { redirect } from "next/navigation";
import { logout, replaceIssuedPasswordAction } from "@/modules/auth-tenancy/actions";
import { requireUserForPasswordChange } from "@/modules/auth-tenancy/session";
import { isReceptionist } from "@/modules/receptionists/catalog";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { ChangePasswordForm } from "@/components/account/change-password-form";

/**
 * "Create your new password": where a student lands after signing in with a
 * password somebody else issued — the temporary password a new account comes
 * with, or one from a reset — and where every other page sends them until
 * they have chosen their own.
 *
 * The one page `requireUserForPasswordChange` lets such a session reach. The
 * issued password is asked for again, as on the Account page, so an
 * unattended browser that is still signed in cannot be given a password by
 * whoever walks up to it; the new one may not be the issued one.
 *
 * A school receptionist lands here too, on their first sign-in and after the
 * principal resets their password. Their wording is a member of staff's: a
 * staff password is never revealed to anyone, only replaced.
 */
export default async function CreatePasswordPage() {
  const user = await requireUserForPasswordChange();
  // Only a receptionist's page differs; everyone else's is as it was.
  const receptionist = isReceptionist(user);
  // Nothing owed. The ordinary change lives under Account.
  if (!user.mustChangePassword) redirect(receptionist ? "/dashboard/account" : "/portal/account");

  if (receptionist) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Create your new password</h1>
          <p className="text-sm text-neutral-600">
            You signed in with a temporary password from your school. Choose your own to continue. The temporary one
            stops working as soon as you do.
          </p>
          <p className="text-sm text-neutral-600">
            Your password is stored securely and nobody can read it back. If you forget it, the principal can issue a
            new one.
          </p>
        </header>

        <Panel title="New password" description="Other phones or computers signed in to this account are signed out.">
          <ChangePasswordForm
            action={replaceIssuedPasswordAction}
            currentLabel="Temporary password"
            submitLabel="Save password and continue"
            pendingLabel="Saving…"
            hint="At least 8 characters. Not your email address, and not the temporary password."
          />
        </Panel>

        <form action={logout}>
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">Create your new password</h1>
        <p className="text-sm text-neutral-600">
          You signed in with a temporary password from your college. Choose your own to continue. The temporary
          one stops working as soon as you do.
        </p>
        <p className="text-sm text-neutral-600">
          Your password is stored securely. Authorized college staff may be able to reset or reveal your current
          portal password, so don&apos;t use one you use anywhere else.
        </p>
      </header>

      <Panel title="New password" description="Other phones or computers signed in to this account are signed out.">
        <ChangePasswordForm
          action={replaceIssuedPasswordAction}
          currentLabel="Temporary password"
          submitLabel="Save password and continue"
          pendingLabel="Saving…"
          hint="At least 8 characters. Not your student ID, and not the temporary password."
        />
      </Panel>

      <form action={logout}>
        <Button type="submit" variant="secondary">
          Sign out
        </Button>
      </form>
    </div>
  );
}
