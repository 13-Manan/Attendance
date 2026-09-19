import Link from "next/link";

/**
 * 404, for an unknown URL and for any `notFound()` raised by a route without
 * a closer boundary.
 *
 * It offers the homepage rather than the dashboard on purpose: a 404 is served
 * to signed-out visitors and crawlers too, and pointing them at a route that
 * only redirects them to /login is a worse answer than the front door. Anyone
 * signed in gets one extra click and lands where they expect.
 *
 * Deliberately says nothing about whether the address exists-but-is-forbidden.
 * That distinction is /unauthorized's to make, for a request that got far
 * enough to be identified; volunteering it here would turn a 404 into a probe
 * for valid routes.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-xs font-semibold tracking-widest text-neutral-400 uppercase">
        Error 404
      </p>
      <h1 className="text-2xl font-semibold text-neutral-900">Page not found</h1>
      <p className="max-w-sm text-sm text-neutral-500">
        The address you followed doesn&apos;t match anything here. It may have been
        moved, or the link may be out of date.
      </p>
      <Link href="/" className="mt-2 text-sm font-medium text-neutral-900 underline">
        Go to the homepage
      </Link>
    </main>
  );
}
