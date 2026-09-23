import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { safeNextPath } from "@/modules/auth-tenancy/redirect";
import { InstallAppButton } from "@/components/pwa/install-app-button";
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
 *
 * Presentation (Phase 4): a single centred column on the canvas token, split
 * two-up on very wide screens to give the brand column somewhere to live
 * without inventing a marketing page. The auth flow, sanitisation, redirect,
 * and status region semantics below are exactly what shipped before.
 */
export default async function LoginPage({ searchParams }: PageProps) {
  const { next, signedOut } = await searchParams;
  const safeNext = safeNextPath(next);

  // Already signed in: honour the same `next` rather than always landing on
  // the dashboard, so a bookmarked deep link survives a visit to /login.
  const user = await getCurrentUser();
  if (user) redirect(safeNext);

  return (
    <main
      className="flex min-h-screen w-full flex-col bg-neutral-50 lg:grid lg:grid-cols-2"
      style={{ backgroundColor: "var(--color-bg-canvas)" }}
    >
      {/* Brand column: shown only on lg+ so the form dominates on phones and
          tablets. Deliberately restrained — an operational product, not a
          marketing landing. No decorative image, no gradient, no glass.

          Colour discipline: the brand column is a designed "always dark"
          hero, so every foreground here is hard-coded to white via inline
          `color`. The Tailwind palette remap in dark mode flips utility
          classes like `text-white` and `bg-white/10` — leaving them on
          would produce dark text on the dark brand background, which is
          exactly the bug this page had before. Inline styles override the
          remap because they reference literal white, not a CSS variable. */}
      <aside
        aria-hidden
        className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12"
        style={{ backgroundColor: "var(--color-brand)", color: "#ffffff" }}
      >
        <div className="flex items-center gap-3">
          <span
            className="flex size-10 items-center justify-center rounded-xl text-lg font-semibold ring-1"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.1)",
              color: "#ffffff",
              boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.15)",
            }}
          >
            A
          </span>
          <span className="text-sm font-semibold tracking-tight" style={{ color: "#ffffff" }}>
            Attendance Platform
          </span>
        </div>
        <div className="flex max-w-sm flex-col gap-4">
          <p className="text-2xl font-semibold leading-snug" style={{ color: "#ffffff" }}>
            Face-assisted attendance for schools and colleges.
          </p>
          <p className="text-sm leading-relaxed" style={{ color: "rgba(255, 255, 255, 0.7)" }}>
            Faculty stay in control. AI assists — it never overrides a human
            decision. Every correction is auditable.
          </p>
        </div>
        <p className="text-xs" style={{ color: "rgba(255, 255, 255, 0.5)" }}>
          © {new Date().getFullYear()} Attendance Platform
        </p>
      </aside>

      {/* Form column. `safe-area-inset` covers landscape iPhones where the
          notch would otherwise eat the card's left/right edge. */}
      <section className="safe-area-inset flex flex-1 flex-col justify-center px-4 py-10 sm:px-6 lg:px-12">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
          <header className="flex flex-col items-center gap-3 text-center lg:items-start lg:text-left">
            {/* Small brand mark on the form column too, so the identity is
                still present on mobile where the brand column is hidden.
                Decorative — the product name is right beneath it in real
                text, so announcing the monogram would just repeat it. */}
            <span
              aria-hidden
              className="flex size-11 items-center justify-center rounded-xl text-lg font-semibold lg:hidden"
              style={{ backgroundColor: "var(--color-brand)", color: "#ffffff" }}
            >
              A
            </span>
            <div className="flex flex-col gap-1.5">
              <h1
                className="text-2xl font-semibold tracking-tight text-neutral-900"
                style={{ color: "var(--color-text-primary)" }}
              >
                Sign in
              </h1>
              <p
                className="text-sm text-neutral-500"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Use your institution account to continue.
              </p>
            </div>
          </header>

          {signedOut ? (
            // `role="status"` rather than `alert`: signing out worked, and an
            // assertive announcement would interrupt somebody who is already
            // typing their next password.
            <p
              role="status"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              You have been signed out.
            </p>
          ) : null}

          <div
            className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6"
            style={{
              backgroundColor: "var(--color-bg-surface)",
              borderColor: "var(--color-border-subtle)",
              boxShadow: "var(--elev-1)",
            }}
          >
            <LoginForm next={safeNext} />
          </div>

          <p
            className="text-center text-xs leading-relaxed text-neutral-500 lg:text-left"
            style={{ color: "var(--color-text-muted)" }}
          >
            Accounts are issued by your institution administrator. If you cannot
            sign in, contact them rather than creating a second account.
          </p>

          {/* Secondary product action. Client-side; renders nothing on the
              server, and nothing at all when installation is unavailable or
              the app is already installed. Deliberately below the primary
              copy so it never competes visually with the Sign-in flow. */}
          <InstallAppButton />
        </div>
      </section>
    </main>
  );
}
