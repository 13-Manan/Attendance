"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  discardDraft,
  downloadClasses,
  openLocalSession,
  takeOverDevice,
} from "@/lib/offline/store";
import type { OfflineKitClass } from "@/modules/offline-sync/offline-kit";
import { OfflineCapture } from "./offline-capture";
import { SyncQueuePanel } from "./sync-queue-panel";
import { useSync } from "./sync-provider";

/**
 * `/dashboard/offline`, the whole of it.
 *
 * Three things a teacher needs, in the order they need them:
 *
 * 1. **Download the classes** they will teach without a network. This is the
 *    step that makes the rest possible, and it is explicit rather than
 *    automatic — a silent background download of every roster in the
 *    institution onto a shared tablet is not a thing to do on someone's
 *    behalf.
 * 2. **Take a register**, with no network, from a downloaded class.
 * 3. **See the queue**: what has synced, what has not, and why.
 *
 * The kit arrives as a prop from the server component, which is what makes
 * the download honest: the page only renders classes this user is actually
 * allowed to take a register for, resolved server-side by the same checks the
 * online capture flow uses.
 *
 * Every piece of device state here — downloaded rosters, drafts, the queue —
 * comes from the offline store, not from this component. The only local state
 * is which register is open on screen, which is a property of this screen and
 * of nothing else.
 */
export function OfflineWorkbench({
  classes,
  /**
   * True when this is the cached `/offline` shell, where the server sent
   * nothing because it could not be reached. Distinguishes "you have no
   * classes" from "the server was not asked" — two situations that produce an
   * identical empty array and need opposite advice.
   */
  shell = false,
  userId = null,
}: {
  classes: OfflineKitClass[];
  shell?: boolean;
  /** Signed-in user, when the page is server-rendered and therefore knows. */
  userId?: string | null;
}) {
  const sync = useSync();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cached = sync?.offline.cachedClasses ?? null;
  const sessions = sync?.offline.sessions ?? [];
  const deviceId = sync?.offline.deviceId ?? null;
  const storageBlocked = sync ? !sync.storageAvailable : false;
  const offline = sync?.offline ?? { foreignOwner: false, unsyncedCount: 0 };

  /**
   * Stores the rosters for offline use.
   *
   * Explicit, on a button, with a sentence underneath saying what is and is not
   * downloaded. A background prefetch would be more convenient and would also
   * mean every classroom tablet in the school quietly accumulating rosters
   * nobody asked it to hold.
   */
  const download = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await downloadClasses(classes);
    } catch {
      setError("Could not save these classes for offline use.");
    } finally {
      setSaving(false);
    }
  }, [classes]);

  const openClass = useCallback(async (klass: OfflineKitClass) => {
    try {
      setActiveSessionId(await openLocalSession(klass));
    } catch {
      setError("Could not start a register on this device.");
    }
  }, []);

  if (activeSessionId) {
    return (
      <Panel title="Offline register">
        <OfflineCapture
          localSessionId={activeSessionId}
          onDone={() => setActiveSessionId(null)}
        />
      </Panel>
    );
  }

  const available = cached ?? classes;
  const noNetworkSource = shell || sync?.isOffline || classes.length === 0;
  const drafts = sessions.filter((s) => s.syncStatus === "DRAFT");
  const message =
    error ??
    (storageBlocked
      ? "This browser is blocking local storage, so offline capture is unavailable here."
      : null);

  // Another account's work is on this device. Shown instead of the workbench,
  // not beside it: the point is that this user sees no roster, no register and
  // no queue belonging to somebody else.
  if (offline.foreignOwner) {
    return (
      <Panel title="This device holds another account's registers">
        <p className="text-sm text-neutral-700">
          Someone else took attendance on this device and has not sent it to the
          server yet. It is kept safe here and is only visible to them.
        </p>
        <p className="text-sm text-neutral-700">
          {offline.unsyncedCount > 0
            ? `${offline.unsyncedCount} register${offline.unsyncedCount === 1 ? " is" : "s are"} waiting. Ask that teacher to sign in on this device while it has a connection, and it will send itself.`
            : "Nothing is waiting to be sent, so this device can be handed over."}
        </p>
        {offline.unsyncedCount === 0 && userId ? (
          <div>
            <Button onClick={() => void takeOverDevice(userId)}>Use this device for my classes</Button>
          </div>
        ) : null}
        <p className="text-xs text-neutral-500">
          Their register cannot be sent under your account — the server refuses
          it — and nothing here is discarded to make room.
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {message}
        </p>
      ) : null}

      <Panel
        title="Classes available offline"
        description={
          cached
            ? "Downloaded. You can open any of these with no connection."
            : "Download your classes while you have a connection, so you can take the register without one."
        }
        action={
          // Nothing to download when the server sent nothing. Disabled rather
          // than hidden, so the control the instructions mention is where the
          // instructions say it is.
          <Button onClick={() => void download()} disabled={saving || noNetworkSource}>
            {saving ? "Saving…" : cached ? "Refresh" : "Download for offline"}
          </Button>
        }
      >
        {available.length === 0 ? (
          <EmptyState>
            {shell || sync?.isOffline
              ? "No classes have been downloaded on this device. Connect once and download them, then this page works without a network."
              : "You have no classes you can take a register for."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
            {available.map((klass) => (
              <li key={klass.key} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-neutral-900">
                    {klass.cohortName}
                    {klass.subjectName ? ` · ${klass.subjectName}` : ""}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {klass.students.length} students
                    {klass.termLabel ? ` · ${klass.termLabel}` : ""}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  className="shrink-0 px-3 py-1.5 text-xs"
                  onClick={() => void openClass(klass)}
                >
                  Open class
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-neutral-500">
          Rosters only — names and roll numbers, the same as a paper register. No photographs
          and no face data are downloaded to this device, offline or not.
        </p>
      </Panel>

      {drafts.length > 0 ? (
        <Panel
          title="Registers in progress"
          description="Started on this device and not finalized. Nothing here has been sent."
        >
          <ul className="flex flex-col divide-y divide-neutral-100 rounded-md border border-neutral-200">
            {drafts.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-neutral-900">
                    {session.cohortName}
                    {session.subjectName ? ` · ${session.subjectName}` : ""}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {Object.keys(session.marks).length} of {session.students.length} marked ·
                    started {new Date(session.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => setActiveSessionId(session.id)}
                  >
                    Continue
                  </Button>
                  {/* Discard exists only for drafts — a register that was never
                      finalized and never queued. There is no equivalent for
                      anything the server has not yet acknowledged. */}
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => {
                      if (
                        confirm(
                          `Discard the unfinished register for ${session.cohortName}? Marks made so far will be deleted from this device.`,
                        )
                      ) {
                        void discardDraft(session.id);
                      }
                    }}
                  >
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <SyncQueuePanel />

      {deviceId ? (
        <p className="text-xs text-neutral-400">
          Device ID {deviceId.slice(0, 8)} — recorded with synced registers so an administrator
          can tell which device a register came from. It is not a sign-in credential.
        </p>
      ) : null}
    </div>
  );
}
