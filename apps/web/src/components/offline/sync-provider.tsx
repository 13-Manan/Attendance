"use client";

import { useOffline } from "next/offline";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  getServerState,
  getState,
  refresh,
  start,
  subscribe,
  syncNow,
  type OfflineState,
} from "@/lib/offline/store";
import { syncIndicator, type SyncIndicator } from "@/modules/offline-sync/status";
import type { QueueSnapshot } from "@/lib/offline/queue";

/**
 * Owns the sync loop for the whole dashboard.
 *
 * One provider, mounted once in the dashboard layout, because the loop must
 * keep running while the teacher is on any page — the register they queued in
 * a classroom should sync while they read a report, with no component of the
 * capture flow still mounted.
 *
 * ## Where the state lives
 *
 * Not here. `lib/offline/store` holds it, and this component subscribes with
 * `useSyncExternalStore`. IndexedDB is a real external system shared by every
 * screen that shows a sync count, so a per-component copy kept in sync by
 * effects would be three copies that can disagree. This also means the queue
 * keeps draining across route changes without a render to drive it.
 *
 * ## When it drains
 *
 * Four triggers, and the combination matters more than any one of them:
 *
 * - **Connectivity returns.** `useOffline()` rather than `navigator.onLine`,
 *   because the failure this app actually meets is a school access point that
 *   is associated and has no upstream. `navigator.onLine` reports `true` for
 *   that; Next's detection does not, because it is derived from requests that
 *   really failed plus an active poll.
 * - **The tab becomes visible.** A teacher switching back to the app is the
 *   moment they want to see that the register went through.
 * - **A timer.** Because an item may be parked behind a backoff that expires
 *   with no event to announce it.
 * - **Explicitly**, from the sync panel's Retry button.
 *
 * ## What it does not do
 *
 * It never clears the queue, never marks anything synced on its own, and never
 * reports success it did not hear from the server. Every state it shows comes
 * from IndexedDB, which is the record of truth on this device.
 */

export interface SyncContextValue {
  /** Live connectivity, from Next's detection. `false` during SSR/hydration. */
  isOffline: boolean;
  snapshot: QueueSnapshot;
  indicator: SyncIndicator;
  /** False when IndexedDB is blocked — private mode, locked-down profile. */
  storageAvailable: boolean;
  /** The whole device state, for screens that need the sessions and queue. */
  offline: OfflineState;
  /** Runs a drain now and refreshes the snapshot. */
  syncNow: () => Promise<void>;
  /** Re-reads the queue without sending anything. */
  refresh: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/** How often to look for work that has come due behind a backoff. */
const POLL_INTERVAL_MS = 20_000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const isOffline = useOffline();
  const offline = useSyncExternalStore(subscribe, getState, getServerState);

  // Startup: release claims stranded by a tab that closed mid-drain, ask for
  // storage the browser will not evict, and take a first reading. `start` is
  // idempotent, so the second provider on the `/offline` shell is harmless.
  useEffect(() => {
    void start();
  }, []);

  // Drain when connectivity returns. The dependency is the flag itself, so
  // this fires on the offline → online edge and not on every render.
  useEffect(() => {
    if (isOffline || !offline.storageAvailable) return;
    void syncNow();
  }, [isOffline, offline.storageAvailable]);

  // Drain on tab focus and on a slow timer.
  useEffect(() => {
    if (!offline.storageAvailable) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void syncNow();
    }, POLL_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [offline.storageAvailable]);

  const value = useMemo<SyncContextValue>(
    () => ({
      isOffline,
      snapshot: offline.snapshot,
      indicator: syncIndicator({
        isOffline,
        pending: offline.snapshot.pending,
        syncing: offline.snapshot.syncing,
        failed: offline.snapshot.failed,
        conflicts: offline.snapshot.conflicts,
      }),
      storageAvailable: offline.storageAvailable,
      offline,
      syncNow,
      refresh,
    }),
    [isOffline, offline],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * Returns `null` outside the provider rather than throwing.
 *
 * The badge and the capture flow both render on pages that may one day sit
 * outside the dashboard layout, and a missing sync indicator is a cosmetic
 * problem. Crashing the register screen over it would not be.
 */
export function useSync(): SyncContextValue | null {
  return useContext(SyncContext);
}
