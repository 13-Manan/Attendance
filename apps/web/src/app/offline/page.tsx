import Link from "next/link";
import { OfflineShell } from "@/components/offline/offline-shell";

/**
 * The page a hard reload with no network lands on.
 *
 * ## Why it is outside `/dashboard`
 *
 * Because the service worker has to be able to cache it, and the only page
 * safe to cache is one with nothing personal in it. Every route under
 * `/dashboard` is server-rendered from somebody's data; this one is rendered
 * from nothing at all. There is no `requireUser()` here and there cannot be —
 * a page that needs a server round-trip to decide whether to render is a page
 * that cannot render offline.
 *
 * That is not a hole. Nothing sensitive is on this page: it renders the
 * rosters and registers already in *this browser's* IndexedDB, put there by
 * somebody who was signed in and cleared when they sign out. And it grants
 * nothing — every queued register still has to pass the server's
 * authorization when it syncs, under whatever session the cookie carries then.
 *
 * ## What it is not
 *
 * Not an error page. A teacher who reaches this page can open a downloaded
 * class, take the register, finalize it, and queue it — the whole workflow,
 * not a message apologising for the network.
 */
export const dynamic = "force-static";

export const metadata = {
  title: "Offline attendance",
};

export default function OfflineShellPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Offline attendance</h1>
        <p className="text-sm text-neutral-500">
          You are working from this device. Classes you downloaded earlier are below, and
          anything you finalize here will sync on its own.
        </p>
      </header>

      <OfflineShell />

      <p className="text-xs text-neutral-500">
        <Link href="/dashboard" className="underline">
          Back to the dashboard
        </Link>{" "}
        — this needs a connection.
      </p>
    </div>
  );
}
