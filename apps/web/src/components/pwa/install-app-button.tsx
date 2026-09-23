"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The install action for the login page.
 *
 * ## What it is
 *
 * A first-class product control that maps to the browser's own installation
 * mechanism where one exists, and to a truthful "Add to Home Screen" hint on
 * iOS Safari where none does. Nothing fake, nothing pretend — no bookmark
 * shortcut, no wallpaper — just the real install prompt or the exact iOS
 * steps.
 *
 * ## When it renders
 *
 * Four cases, resolved on the client after mount:
 *
 *   1. Already-installed (running in `display-mode: standalone` or the iOS
 *      `navigator.standalone` flag). Renders null — do not offer to install
 *      the app the user is already inside.
 *   2. Chromium-family browser that fired `beforeinstallprompt`. Renders the
 *      button. Click calls `prompt()` on the deferred event; on `accepted`
 *      or `dismissed` we clear the reference so the button never re-shows a
 *      stale event.
 *   3. iOS Safari (no `beforeinstallprompt`). Renders a small "Install on
 *      iOS" toggle that expands a short, sober set of Add-to-Home-Screen
 *      instructions.
 *   4. Anything else. Renders null — a broken install button is worse than
 *      no install button.
 *
 * ## Why it is client-only
 *
 * Every capability check reads a browser API (`matchMedia`, `navigator`,
 * `window.addEventListener`). Rendering any UI on the server would either
 * flash the wrong state or produce a hydration mismatch. The mount hook
 * gates every branch behind `mounted`, so SSR emits the null shell and the
 * real state resolves on the first client tick.
 *
 * ## Security
 *
 * No credentials, no tokens, no personal data cross the browser boundary.
 * The install prompt is a native event; the iOS hint is static text. The
 * service worker registered by `ServiceWorkerRegistrar` is what makes the
 * installability criteria pass; this component only surfaces the result.
 */

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function InstallAppButton() {
  const [mounted, setMounted] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [isPrompting, setIsPrompting] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    // Deliberate SSR-safety pattern: we must delay every capability check
    // until we know we are on the client, and `mounted` gates the render
    // branches below to prevent a hydration mismatch. This is exactly the
    // case the react-hooks/set-state-in-effect rule is *not* meant to fire
    // on — Next.js App Router client components run this effect once on
    // mount, and there is no cascading re-render because none of the state
    // this sets is derived from props or other state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);

    if (typeof window === "undefined") return;

    // Standalone detection: covers Chromium/Firefox/desktop PWAs
    // (`display-mode: standalone`) and legacy iOS Safari
    // (`navigator.standalone`). Either one is enough — we do not want to
    // offer install to somebody already inside the installed app.
    const media = window.matchMedia("(display-mode: standalone)");
    // iOS Safari sets a non-standard `standalone` boolean on `navigator`.
    // Narrow to a plain read so TS doesn't complain about the union.
    type NavigatorWithStandalone = Navigator & { standalone?: boolean };
    const iosNav = navigator as NavigatorWithStandalone;
    const alreadyInstalled = media.matches || iosNav.standalone === true;
    setIsStandalone(alreadyInstalled);

    // iOS detection: enough to distinguish "no beforeinstallprompt" (real
    // Chromium/Edge) from "no beforeinstallprompt because the platform does
    // not have one" (Safari on iOS/iPadOS). Includes iPadOS 13+, which
    // reports as Macintosh with a touch stack — hence the `maxTouchPoints`
    // check.
    const ua = navigator.userAgent;
    const platform = navigator.platform || "";
    const isIosDevice =
      /iPhone|iPad|iPod/.test(ua) ||
      (platform === "MacIntel" && navigator.maxTouchPoints > 1);
    // Safari is the only browser where iOS's Add-to-Home-Screen path is
    // both available and the ONLY install path. Chromium on iOS (`CriOS`)
    // does not expose it.
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    setIsIos(isIosDevice && isSafari && !alreadyInstalled);

    // Capture the deferred install prompt for later use. Do not call
    // `preventDefault()` — Chromium already suppresses the mini-infobar for
    // us in most contexts, and calling `preventDefault` inside a passive
    // event listener produces a console warning that reads like a real
    // error.
    const onBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      // If the browser fires this while the app is already installed
      // (rare, mostly stale references), ignore it.
      if (alreadyInstalled) return;
      setDeferredPrompt(promptEvent);
    };

    // Clear our state as soon as the app is installed. The button hides
    // itself immediately, no waiting for the next reload.
    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    // Live standalone tracking: if the user launches the installed PWA
    // while this tab is still open, `display-mode` flips and the button
    // vanishes.
    const onMediaChange = (mediaEvent: MediaQueryListEvent) => {
      if (mediaEvent.matches) setIsStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    media.addEventListener?.("change", onMediaChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      media.removeEventListener?.("change", onMediaChange);
    };
  }, []);

  const handleInstallClick = useCallback(async () => {
    if (!deferredPrompt) return;
    setIsPrompting(true);
    try {
      await deferredPrompt.prompt();
      // Await the user's choice. `accepted` will also fire `appinstalled`
      // and clean up above; here we just make sure the button does not sit
      // in a loading state if they dismiss the sheet.
      await deferredPrompt.userChoice;
    } catch {
      // The browser can reject `prompt()` if the user has already dismissed
      // it recently. Not something to surface — the button simply becomes
      // available again the next time the browser considers the app
      // installable.
    } finally {
      // The spec says a deferred prompt is single-use. Clear it so a second
      // click does not fire a stale event that the browser will refuse.
      setDeferredPrompt(null);
      setIsPrompting(false);
    }
  }, [deferredPrompt]);

  // Server render + first client tick: null. Prevents SSR/CSR mismatch and
  // keeps the login page identity-independent until we know the platform.
  if (!mounted) return null;

  // Case 1: already installed. Nothing to offer.
  if (isStandalone) return null;

  // Case 2: Chromium-family with a deferred prompt in hand.
  if (deferredPrompt) {
    return (
      <div className="flex flex-col items-center gap-2 text-center lg:items-start lg:text-left">
        <button
          type="button"
          onClick={handleInstallClick}
          disabled={isPrompting}
          aria-busy={isPrompting || undefined}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 sm:min-h-10"
        >
          <DownloadIcon />
          <span>{isPrompting ? "Opening…" : "Install app"}</span>
        </button>
        <p className="max-w-xs text-xs text-neutral-500 lg:mx-0">
          Install the Attendance Platform for quicker access. Nothing sensitive
          is stored offline.
        </p>
      </div>
    );
  }

  // Case 3: iOS Safari — offer the Add-to-Home-Screen hint. Not a fake
  // install button; the copy states exactly what the user has to do.
  if (isIos) {
    return (
      <div className="flex flex-col items-center gap-2 text-center lg:items-start lg:text-left">
        <button
          type="button"
          onClick={() => setShowIosHint((v) => !v)}
          aria-expanded={showIosHint}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 sm:min-h-10"
        >
          <DownloadIcon />
          <span>Install on iOS</span>
        </button>
        {showIosHint ? (
          <p
            role="note"
            className="max-w-xs rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs leading-relaxed text-neutral-700"
          >
            Tap the Share button in Safari, then choose{" "}
            <span className="font-semibold">Add to Home Screen</span>. The
            Attendance icon will appear on your Home Screen.
          </p>
        ) : null}
      </div>
    );
  }

  // Case 4: platform does not support installation from a website — Firefox
  // Desktop, in-app browsers, older browsers. Render nothing rather than a
  // broken button.
  return null;
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v12" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 21h16" />
    </svg>
  );
}
