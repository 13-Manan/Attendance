import { ForbiddenError } from "@/modules/authorization/types";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { buildOfflineKit, type OfflineKitClass } from "@/modules/offline-sync/offline-kit";
import { OfflineWorkbench } from "@/components/offline/offline-workbench";

/**
 * Offline attendance.
 *
 * ## Why this page exists at all
 *
 * Because offline capture needs something no amount of client cleverness can
 * conjure: the roster. A teacher who walks into a classroom with no signal can
 * only take a register if the names are already on the device, and the only
 * moment to put them there is earlier, while there was a network. That makes
 * "prepare for offline" a real step in the workflow rather than a fallback the
 * app silently attempts — so it gets a page, a button, and a sentence saying
 * what was downloaded.
 *
 * ## What is server-rendered and what is not
 *
 * The *list of classes* comes from the server, resolved through the same
 * authorization the online capture flow uses. That is deliberate: the browser
 * must never be the thing that decides which rosters it may hold. Everything
 * after the download — opening a class, capturing, marking, finalizing,
 * queueing, syncing — happens on the client, because none of it may depend on
 * a server being reachable.
 *
 * When this page is opened with no network it still renders: the shell is
 * served by the service worker and the class list comes back empty, at which
 * point the client reads the classes it downloaded earlier out of IndexedDB.
 * The empty server response is not a failure state here; it is the expected
 * one.
 *
 * ## Permission
 *
 * `attendanceSession.capture` — the same permission taking a register online
 * requires. A student, who has none of it, cannot reach this page, and could
 * not alter attendance with it if they did: every write still goes through
 * `applyReviewDecision` on the server.
 */
export default async function OfflinePage() {
  const user = await requirePermissionOrRedirect("attendanceSession.capture");

  let classes: OfflineKitClass[] = [];
  try {
    classes = await buildOfflineKit(user);
  } catch (error) {
    // A roster the user may not read is not an error worth a 500 — it is a
    // shorter list. The client falls back to whatever it already downloaded.
    if (!(error instanceof ForbiddenError)) throw error;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Offline attendance</h1>
        <p className="text-sm text-neutral-500">
          Take a register with no internet. Everything is saved on this device and syncs by
          itself when the connection returns.
        </p>
      </header>

      <OfflineWorkbench classes={classes} userId={user.userId} />

      <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-600">
        <h2 className="text-sm font-semibold text-neutral-900">How this works</h2>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
          <li>
            Download your classes once, while connected. The rosters stay on this device
            until you sign out.
          </li>
          <li>
            A register taken offline is finalized on the device and queued. Closing the app,
            losing battery, or switching networks does not lose it.
          </li>
          <li>
            Each queued register carries a unique key, so if it is sent twice the server
            recognizes it and records the attendance once.
          </li>
          <li>
            Face recognition needs a recognition node on this network. When there is none,
            the register is marked by hand — nothing is guessed, and no student is marked
            present without a person deciding so.
          </li>
          <li>
            If the server already holds a different answer for a student, neither record is
            overwritten. You are asked which is right.
          </li>
        </ul>
      </section>
    </div>
  );
}
