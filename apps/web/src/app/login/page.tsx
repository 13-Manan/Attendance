import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { safeNextPath } from "@/modules/auth-tenancy/redirect";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Attendance Platform",
};

interface PageProps {
  searchParams: Promise<{ next?: string; signedOut?: string }>;
}

/**
 * The only unauthenticated page anyone is meant to arrive at.
 *
 * Two pieces of state come in on the URL and both are treated as untrusted:
 * `next` is sanitised by `safeNextPath` before it is ever rendered into the
 * form, and `signedOut` is read as a boolean and never echoed. Nothing else
 * from the query string reaches the page.
 */
export default async function LoginPage({ searchParams }: PageProps) {
  const { next, signedOut } = await searchParams;
  const safeNext = safeNextPath(next);

  // Already signed in: honour the same `next` rather than always landing on
  // the dashboard, so a bookmarked deep link survives a visit to /login.
  const user = await getCurrentUser();
  if (user) redirect(safeNext);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-4 py-10 sm:px-6">
      <div className="w-full max-w-sm">
        <header className="mb-6 flex flex-col items-center gap-2 text-center">
          {/* Decorative: the product name is right beneath it in real text,
              so announcing the monogram too would just repeat it. */}
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-xl bg-neutral-900 text-lg font-semibold text-white"
          >
            A
          </span>
          <h1 className="text-xl font-semibold text-neutral-900">Attendance Platform</h1>
          <p className="text-sm text-neutral-500">
            Sign in with your institution account to continue.
          </p>
        </header>

        {signedOut ? (
          // `role="status"` rather than `alert`: signing out worked, and an
          // assertive announcement would interrupt somebody who is already
          // typing their next password.
          <p
            role="status"
            className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            You have been signed out.
          </p>
        ) : null}

        <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
          <LoginForm next={safeNext} />
        </div>

        <p className="mt-6 text-center text-xs text-neutral-500">
          Accounts are issued by your institution administrator. If you cannot sign
          in, contact them rather than creating a second account.
        </p>
      </div>
    </main>
  );
}
