"use client";

import { useEffect } from "react";

/**
 * Registers the app-shell service worker.
 *
 * Renders nothing and returns nothing. Mounted in the root layout because the
 * shell it caches must be available on a cold start from the home-screen icon,
 * which is a load that never passes through the dashboard layout.
 *
 * ## Why it is gated on production
 *
 * A service worker in `next dev` intercepts requests that the dev server is
 * also trying to hot-replace, which produces stale-chunk errors that look like
 * application bugs and are not. Next's own offline guide says the same thing
 * about testing this feature: build and start, do not trust dev mode.
 *
 * ## Why failures are swallowed
 *
 * Registration fails on insecure origins, in some private-browsing modes, and
 * wherever an administrator has disabled workers. None of that stops the app
 * working — it only means a hard reload with no network shows the browser's
 * own error page instead of the offline shell. Every other part of offline
 * capture, including IndexedDB and the sync queue, is unaffected, so this is
 * not something to interrupt anybody about.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // `load` rather than immediately: registration competes for bandwidth with
    // the page's own assets, and the shell is for the *next* visit.
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
