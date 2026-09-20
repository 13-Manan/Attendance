"use client";

import { useEffect, useRef } from "react";
import { logout } from "@/modules/auth-tenancy/actions";
import { clearForSignOut } from "@/lib/offline/store";
import { useSync } from "@/components/offline/sync-provider";

/**
 * Initials for the avatar. Two at most, and from word starts rather than the
 * first two characters, so "Priya Raghunathan" is PR and not "Pr".
 */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export interface UserMenuProps {
  name: string;
  email: string;
  /** Role *names*, already resolved. Never the permission list — the browser
   *  has no use for it and a payload is a thing that gets read. */
  roleNames: string[];
  /** `null` for a platform-level account, which belongs to no one institution. */
  institutionName: string | null;
}

/**
 * The account menu: who you are signed in as, which institution you are
 * operating inside, what you hold, and the way out.
 *
 * The institution line is the point of it. Every query this app runs is scoped
 * to the tenant on the server session, and a user who cannot see which tenant
 * that is has no way to notice if they are somewhere they did not expect. It
 * is displayed, never chosen: there is no control here that could change it,
 * because institution context is not something a client gets to assert.
 *
 * ## Why `<details>` and not a state variable
 *
 * The topbar it replaces had a log-out button that was always in the DOM, and
 * a form posting a Server Action works with no JavaScript at all. Rebuilding
 * this as `useState` + a conditionally rendered panel would have quietly taken
 * that away — on a school tablet that fails to run the bundle, "I can't sign
 * out" is a real problem on a shared device. A disclosure element opens on
 * click natively, manages `aria-expanded` itself, and is keyboard-operable
 * before any of our code runs. The effect below is enhancement on top:
 * Escape and outside-click, which native `<details>` does not do.
 */
export function UserMenu({ name, email, roleNames, institutionName }: UserMenuProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const sync = useSync();
  const unsynced = sync?.offline.unsyncedCount ?? 0;

  /**
   * Clears this device's offline data on the way out — but only when the
   * server already has everything.
   *
   * A shared classroom tablet is the case this exists for: without it the
   * next teacher to sign in inherits the last one's downloaded roster and
   * their draft register. With unsynced work, `clearForSignOut` deliberately
   * keeps the data and the warning above is what the teacher sees; discarding
   * somebody's attendance to tidy up a device is the one thing this must not
   * do.
   *
   * Awaited before the Server Action proceeds, and failure is swallowed: a
   * sign-out that cannot clear IndexedDB must still sign the user out, and the
   * ownership guard hides the leftovers from the next account regardless.
   */
  const signingOut = useRef(false);
  function onSignOut(event: React.FormEvent<HTMLFormElement>) {
    // The second pass, re-entered from `requestSubmit` below. Let it through,
    // otherwise this handler cancels the submit it just asked for.
    if (signingOut.current) return;
    event.preventDefault();
    signingOut.current = true;
    const form = event.currentTarget;
    void clearForSignOut()
      .catch(() => undefined)
      .then(() => form.requestSubmit());
  }

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;

    function close(restoreFocus: boolean) {
      const element = detailsRef.current;
      if (!element?.open) return;
      element.open = false;
      // Focus is otherwise left inside a panel that just disappeared, and the
      // next Tab starts from the top of the document.
      if (restoreFocus) element.querySelector("summary")?.focus();
    }

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!detailsRef.current?.contains(event.target as Node)) close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close(true);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const primaryRole = roleNames[0] ?? "No role assigned";

  return (
    <details ref={detailsRef} className="group relative">
      <summary
        // `list-none` plus the WebKit rule removes the disclosure triangle;
        // the avatar is the affordance. Still a real summary, so the browser
        // keeps the button role, the keyboard handling and aria-expanded.
        className="flex max-w-[12rem] cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 sm:max-w-[16rem] [&::-webkit-details-marker]:hidden"
      >
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-white"
        >
          {initialsOf(name)}
        </span>
        {/* Hidden below `sm` so a phone keeps the avatar and drops the text
            rather than truncating both into illegibility. The screen-reader
            label below covers what the text was saying. */}
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block truncate text-sm font-medium text-neutral-900">{name}</span>
          <span className="block truncate text-xs text-neutral-500">{primaryRole}</span>
        </span>
        <span className="sr-only">Account menu for {name}</span>
      </summary>

      <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
        <div className="flex flex-col gap-1 border-b border-neutral-100 px-3 py-2.5">
          <p className="truncate text-sm font-medium text-neutral-900">{name}</p>
          <p className="truncate text-xs text-neutral-500">{email}</p>
        </div>

        <div className="flex flex-col gap-2 border-b border-neutral-100 px-3 py-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
              Institution
            </span>
            <span className="truncate text-xs text-neutral-700">
              {institutionName ?? "Platform (all institutions)"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
              {roleNames.length === 1 ? "Role" : "Roles"}
            </span>
            {roleNames.length === 0 ? (
              <span className="text-xs text-neutral-500">No role assigned</span>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {roleNames.map((role) => (
                  <li
                    key={role}
                    className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700"
                  >
                    {role}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <form action={logout} onSubmit={onSignOut} className="p-1">
          {unsynced > 0 ? (
            // Said before they press it, not after. On a shared tablet the
            // register would otherwise be left for whoever signs in next, who
            // cannot send it — the server refuses a queue drained by the wrong
            // account — so the only person who can is the one about to leave.
            <p
              role="status"
              className="mb-1 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
            >
              <span className="font-medium">
                {unsynced} register{unsynced === 1 ? "" : "s"} not yet sent.
              </span>{" "}
              Connect and sync before signing out, or it stays on this device
              until you sign in here again.
            </p>
          ) : null}
          <button
            type="submit"
            className="w-full rounded-md px-2 py-2 text-left text-sm font-medium text-neutral-700 hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900"
          >
            Log out
          </button>
        </form>
      </div>
    </details>
  );
}
