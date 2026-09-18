"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel } from "@/components/ui/panel";
import type { QueueRecord } from "@/lib/offline/db";
import { keepLocalAnswer, keepServerAnswer, retryQueueItem } from "@/lib/offline/store";
import { describeSyncError } from "@/modules/offline-sync/status";
import type { SyncConflict, SyncStatus } from "@/modules/offline-sync/types";
import { useSync } from "./sync-provider";

/**
 * The queue, itemised.
 *
 * The point of this screen is accountability: for every register taken on this
 * device there is a row saying where it is, and for every row that is not
 * moving there is a reason in words and a button. Attendance that a background
 * process quietly gave up on — with no row, no reason, and no way to make it
 * try again — is the failure mode that makes people stop trusting an offline
 * feature and go back to paper.
 *
 * Nothing on this screen deletes an unsynced operation. There is no "clear
 * queue".
 */

const STATUS_STYLE: Record<SyncStatus, string> = {
  PENDING: "border-neutral-300 bg-neutral-50 text-neutral-700",
  SYNCING: "border-blue-300 bg-blue-50 text-blue-900",
  SYNCED: "border-emerald-300 bg-emerald-50 text-emerald-900",
  FAILED: "border-red-300 bg-red-50 text-red-900",
  CONFLICT: "border-purple-300 bg-purple-50 text-purple-900",
};

const STATUS_LABEL: Record<SyncStatus, string> = {
  PENDING: "Pending sync",
  SYNCING: "Syncing",
  SYNCED: "Synced",
  FAILED: "Sync failed",
  CONFLICT: "Needs your decision",
};

export function SyncQueuePanel() {
  const sync = useSync();
  const items: QueueRecord[] = sync?.offline.queue ?? [];
  const loading = sync ? !sync.offline.ready : true;

  if (!sync?.storageAvailable) {
    return (
      <Panel title="Sync queue">
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          This browser is blocking local storage, so nothing can be saved offline here.
          Private browsing windows and some managed profiles do this. Use a normal window,
          or take attendance while connected.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Sync queue"
      description={
        sync.isOffline
          ? "No connection. Queued attendance will send itself when the network returns."
          : "Everything taken on this device, and where it is."
      }
      action={
        <Button
          variant="secondary"
          onClick={() => void sync.syncNow()}
          disabled={sync.isOffline || sync.offline.draining}
        >
          {sync.offline.draining ? "Syncing…" : "Sync now"}
        </Button>
      }
    >
      {loading ? (
        <p className="text-sm text-neutral-500">Reading the queue…</p>
      ) : items.length === 0 ? (
        <EmptyState>
          Nothing queued. Registers taken offline appear here until the server has them.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function QueueRow({ item }: { item: QueueRecord }) {
  const reason = describeSyncError(item.lastError);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-neutral-900">
            {item.kind === "attendance.session" ? "Attendance register" : "Attendance correction"}
          </span>
          <span className="text-xs text-neutral-500">
            Queued {new Date(item.createdAt).toLocaleString()}
            {item.attemptCount > 0 ? ` · ${item.attemptCount} attempt${item.attemptCount === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[item.status]}`}
        >
          {STATUS_LABEL[item.status]}
        </span>
      </div>

      {reason ? <p className="text-xs text-neutral-600">{reason}</p> : null}

      {item.status === "PENDING" && item.nextAttemptAt ? (
        <p className="text-xs text-neutral-500">
          Next attempt {new Date(item.nextAttemptAt).toLocaleTimeString()}.
        </p>
      ) : null}

      {item.status === "FAILED" ? (
        <p className="text-xs text-neutral-600">
          This attendance is still saved on this device. It has not been lost.
          {item.retryable
            ? " Retrying will send it again."
            : " Retrying will not help until the reason above is fixed, but the record is kept."}
        </p>
      ) : null}

      {item.conflicts.length > 0 && item.attendanceSessionId ? (
        <ConflictList
          conflicts={item.conflicts}
          queueItemId={item.id}
          attendanceSessionId={item.attendanceSessionId}
        />
      ) : null}

      {item.status === "FAILED" || item.status === "PENDING" ? (
        <div>
          <Button variant="secondary" onClick={() => void retryQueueItem(item.id)}>
            Retry now
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A disagreement, shown as a disagreement.
 *
 * Both answers side by side, both attributed, neither pre-selected. The server
 * already refused to pick — `applySyncBatch` applies every non-conflicting mark
 * and reports the rest rather than overwriting a human's correction with an
 * older offline one — and this is where the person who was in the room decides.
 *
 * Choosing "keep this device's" queues a *new* correction with its own audit
 * row, rather than replaying the register. The teacher is making a fresh
 * decision now, and the record should say so.
 */
function ConflictList({
  conflicts,
  queueItemId,
  attendanceSessionId,
}: {
  conflicts: SyncConflict[];
  queueItemId: string;
  attendanceSessionId: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const keepLocal = async (conflict: SyncConflict) => {
    if (conflict.localResult !== "PRESENT" && conflict.localResult !== "ABSENT") return;
    setBusy(conflict.studentId);
    try {
      await keepLocalAnswer(
        queueItemId,
        attendanceSessionId,
        conflict.studentId,
        conflict.localResult,
      );
    } finally {
      setBusy(null);
    }
  };

  const keepServer = async (conflict: SyncConflict) => {
    setBusy(conflict.studentId);
    try {
      await keepServerAnswer(queueItemId, conflict.studentId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-purple-200 bg-purple-50/50 p-3">
      <p className="text-xs text-purple-900">
        The server already holds a different answer for {conflicts.length} student
        {conflicts.length === 1 ? "" : "s"}. Nothing was overwritten. Choose which record is
        right.
      </p>
      <ul className="flex flex-col gap-2">
        {conflicts.map((conflict) => (
          <li
            key={conflict.studentId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-purple-200 bg-white px-3 py-2"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-neutral-900">
                {conflict.studentName ?? conflict.studentId}
              </span>
              <span className="text-xs text-neutral-500">
                This device: {conflict.localResult} · Server: {conflict.serverResult} ·{" "}
                {conflict.reason === "session_already_finalized"
                  ? "the register was already finalized"
                  : "corrected by a person on the server"}
              </span>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="secondary"
                className="px-2.5 py-1 text-xs"
                disabled={busy === conflict.studentId}
                onClick={() => void keepLocal(conflict)}
              >
                Keep this device&apos;s
              </Button>
              <Button
                variant="secondary"
                className="px-2.5 py-1 text-xs"
                disabled={busy === conflict.studentId}
                onClick={() => void keepServer(conflict)}
              >
                Keep the server&apos;s
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
