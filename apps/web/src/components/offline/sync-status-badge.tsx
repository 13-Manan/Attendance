"use client";

import Link from "next/link";
import { describeIndicator } from "@/modules/offline-sync/status";
import { useSync } from "./sync-provider";

/**
 * The connectivity and sync indicator, in the topbar on every dashboard page.
 *
 * ## Why it is a link and not a tooltip
 *
 * Because every state except "Synced" has something a person can do about it,
 * and a status that cannot be acted on trains people to stop reading it. The
 * badge goes to `/dashboard/offline`, where the queue is itemised with a
 * reason and a retry.
 *
 * ## Why it renders nothing when idle and online
 *
 * A permanent green "Synced" pill is noise that gets tuned out within a day,
 * and the state it reports is the one that needs no attention. It appears the
 * moment something is queued, offline, failed, or in conflict — so its
 * presence alone carries information. It does stay visible for a few seconds
 * after a successful drain, because a teacher who just pressed Finalize
 * deserves to see it land.
 */
export function SyncStatusBadge() {
  const sync = useSync();
  if (!sync) return null;

  const { indicator, snapshot, isOffline, storageAvailable } = sync;

  if (!storageAvailable) {
    // Not a sync problem — this browser cannot store anything offline at all.
    // Said plainly, because a teacher who believes offline capture works here
    // and takes a register in a basement classroom would lose it.
    return (
      <span
        role="status"
        title="This browser is blocking local storage (private browsing, or a restricted profile). Attendance taken here is not saved on the device."
        className="hidden shrink-0 rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-900 sm:inline"
      >
        Offline capture unavailable
      </span>
    );
  }

  if (indicator === "SYNCED" && snapshot.total === 0 && !isOffline) return null;

  const { label, detail, className } = describeIndicator(indicator, {
    isOffline,
    pending: snapshot.pending,
    syncing: snapshot.syncing,
    failed: snapshot.failed,
    conflicts: snapshot.conflicts,
  });

  return (
    <Link
      href="/dashboard/offline"
      role="status"
      // `aria-live="polite"` and not `assertive`: a screen-reader user in the
      // middle of marking a register should hear "offline" at the next pause,
      // not have their current sentence interrupted by it.
      aria-live="polite"
      title={detail}
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors hover:brightness-95 ${className}`}
    >
      {label}
    </Link>
  );
}
