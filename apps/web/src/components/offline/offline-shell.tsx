"use client";

import { OfflineWorkbench } from "./offline-workbench";
import { SyncProvider } from "./sync-provider";

/**
 * The offline shell's client root.
 *
 * Carries its own `SyncProvider` because it renders outside the dashboard
 * layout — a reload with no network never reaches that layout, since rendering
 * it needs a server. The queue has to keep draining here too: this is the
 * screen a teacher is on when the network comes back.
 *
 * `classes={[]}` is not a placeholder. The server genuinely sent nothing —
 * this page is static — and the workbench falls back to the rosters in
 * IndexedDB, which is the whole point of having downloaded them.
 */
export function OfflineShell() {
  return (
    <SyncProvider>
      <OfflineWorkbench classes={[]} shell />
    </SyncProvider>
  );
}
