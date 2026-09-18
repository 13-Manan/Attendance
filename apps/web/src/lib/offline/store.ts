"use client";

import type { OfflineKitClass } from "@/modules/offline-sync/offline-kit";
import {
  deleteSessionCascade,
  getCachedClasses,
  getDeviceId,
  isOfflineStorageAvailable,
  listQueue,
  listSessions,
  putCachedClasses,
  putSession,
  requestPersistentStorage,
  updateSession,
  type LocalSession,
  type QueueRecord,
} from "./db";
import {
  drainQueue,
  queueSession,
  recoverQueue,
  resolveConflictWithLocal,
  resolveConflictWithServer,
  retryItem,
  snapshotQueue,
  EMPTY_SNAPSHOT,
  type QueueSnapshot,
} from "./queue";

/**
 * Everything this device knows about offline attendance, as one external store.
 *
 * ## Why a store and not component state
 *
 * Because IndexedDB genuinely *is* an external system, and the React rule
 * against calling `setState` inside an effect is pointing at something real
 * here rather than being a lint to route around. Three different screens —
 * the topbar badge, the workbench, the queue panel — all read the same
 * database and all must agree; keeping a copy in each component's `useState`
 * and re-reading it in three separate effects means three chances to show a
 * teacher a stale count of unsynced registers.
 *
 * So there is one snapshot, `useSyncExternalStore` subscribes to it, and every
 * mutation goes through an action here that writes to IndexedDB and then
 * refreshes. Components hold no offline state of their own.
 *
 * ## The snapshot is immutable
 *
 * `getState()` returns the same object reference until something actually
 * changes. `useSyncExternalStore` compares by identity and will loop forever
 * against a getter that builds a fresh object each call — which is the one
 * way this pattern goes wrong, so it is worth stating.
 */

export interface OfflineState {
  /** False until the first read of IndexedDB completes. */
  ready: boolean;
  /** False when IndexedDB is blocked — private mode, locked-down profile. */
  storageAvailable: boolean;
  snapshot: QueueSnapshot;
  queue: QueueRecord[];
  sessions: LocalSession[];
  /** Null when nothing has been downloaded on this device yet. */
  cachedClasses: OfflineKitClass[] | null;
  deviceId: string | null;
  /** True while a drain is in flight, for the "Sync now" button. */
  draining: boolean;
}

const INITIAL: OfflineState = {
  ready: false,
  storageAvailable: true,
  snapshot: EMPTY_SNAPSHOT,
  queue: [],
  sessions: [],
  cachedClasses: null,
  deviceId: null,
  draining: false,
};

let state: OfflineState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<OfflineState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): OfflineState {
  return state;
}

/**
 * The server snapshot, and why it is a separate constant.
 *
 * `useSyncExternalStore` calls this during SSR and hydration. It must be a
 * stable reference that never changes, and it must describe a device that has
 * nothing — because on the server, that is true: there is no IndexedDB, no
 * queue, and no device. Returning the live `state` here would be a hydration
 * mismatch waiting for the first teacher with a pending register.
 */
export function getServerState(): OfflineState {
  return INITIAL;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function refresh(): Promise<void> {
  try {
    const [snapshot, queue, sessions, cached, deviceId] = await Promise.all([
      snapshotQueue(),
      listQueue(),
      listSessions(),
      getCachedClasses<OfflineKitClass>(),
      getDeviceId(),
    ]);
    set({
      ready: true,
      storageAvailable: true,
      snapshot,
      queue,
      sessions,
      cachedClasses: cached.length > 0 ? cached : null,
      deviceId,
    });
  } catch {
    set({ ready: true, storageAvailable: false });
  }
}

let started = false;

/**
 * One-time startup. Safe to call from every provider that mounts.
 *
 * Releases claims stranded by a tab that closed mid-drain — otherwise those
 * operations are in `SYNCING` forever, picked up by no drain and reported by
 * nothing, which is a lost register that merely looks tidy.
 */
export async function start(): Promise<void> {
  if (started) return;
  started = true;
  if (!isOfflineStorageAvailable()) {
    set({ ready: true, storageAvailable: false });
    return;
  }
  try {
    await recoverQueue();
    void requestPersistentStorage();
  } catch {
    set({ ready: true, storageAvailable: false });
    return;
  }
  await refresh();
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncNow(): Promise<void> {
  if (state.draining || !state.storageAvailable) return;
  set({ draining: true });
  try {
    await drainQueue();
  } catch {
    set({ storageAvailable: false });
  } finally {
    set({ draining: false });
    await refresh();
  }
}

export async function retryQueueItem(id: string): Promise<void> {
  await retryItem(id);
  await refresh();
  await syncNow();
}

export async function keepLocalAnswer(
  queueItemId: string,
  attendanceSessionId: string,
  studentId: string,
  result: "PRESENT" | "ABSENT",
): Promise<void> {
  await resolveConflictWithLocal(queueItemId, attendanceSessionId, studentId, result);
  await refresh();
  await syncNow();
}

export async function keepServerAnswer(queueItemId: string, studentId: string): Promise<void> {
  await resolveConflictWithServer(queueItemId, studentId);
  await refresh();
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export async function downloadClasses(classes: OfflineKitClass[]): Promise<void> {
  await putCachedClasses(classes);
  await refresh();
}

// ---------------------------------------------------------------------------
// Local registers
// ---------------------------------------------------------------------------

export async function openLocalSession(klass: OfflineKitClass): Promise<string> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await putSession({
    id,
    cohortId: klass.cohortId,
    cohortName: klass.cohortName,
    cohortSubjectId: klass.cohortSubjectId,
    subjectName: klass.subjectName,
    sessionDate: now,
    students: klass.students.map((s) => ({
      studentId: s.studentId,
      fullName: s.fullName,
      rollNumber: s.rollNumber,
    })),
    marks: {},
    // Honest by default, and only ever upgraded when a local node actually
    // proposed the marks — never because one was merely reachable.
    markSource: "MANUAL",
    finalizedAt: null,
    createdAt: now,
    updatedAt: now,
    syncStatus: "DRAFT",
    conflicts: [],
    serverSessionId: null,
  });
  await refresh();
  return id;
}

export async function markStudent(
  localSessionId: string,
  studentId: string,
  result: "PRESENT" | "ABSENT",
): Promise<void> {
  await updateSession(localSessionId, (session) => ({
    ...session,
    marks: {
      ...session.marks,
      [studentId]: { studentId, result, markedAt: new Date().toISOString() },
    },
    updatedAt: new Date().toISOString(),
  }));
  await refresh();
}

/**
 * Finalizes on the device and queues.
 *
 * Throws if the queue write fails, so the caller can say the true thing: the
 * register is still saved here, only the queueing failed, and Finalize can be
 * pressed again. What it must never do is report success — a teacher who
 * believes a register was lost will take it again, and then there are two.
 */
export async function finalizeLocalSession(
  localSessionId: string,
  captureImageCount: number,
): Promise<void> {
  const session = state.sessions.find((s) => s.id === localSessionId);
  if (!session) throw new Error("local_session_not_found");

  const finalizedAt = new Date().toISOString();
  await updateSession(localSessionId, (s) => ({ ...s, finalizedAt, updatedAt: finalizedAt }));
  await queueSession({
    localSessionId,
    cohortId: session.cohortId,
    cohortSubjectId: session.cohortSubjectId,
    sessionDate: session.sessionDate,
    marks: Object.values(session.marks),
    finalizedLocally: true,
    finalizedAt,
    markSource: session.markSource,
    captureImageCount,
  });
  await refresh();
  // Try immediately. If there is no network this is a no-op that costs one
  // failed fetch, and if there is, the register lands before the teacher has
  // left the room.
  await syncNow();
}

/**
 * Deletes an unfinished draft.
 *
 * The only deletion path in this module that a person can reach, and it is
 * restricted to a register that was never finalized and never queued. There is
 * deliberately no way to delete anything the server has not acknowledged.
 */
export async function discardDraft(localSessionId: string): Promise<void> {
  const session = state.sessions.find((s) => s.id === localSessionId);
  if (!session || session.syncStatus !== "DRAFT") return;
  await deleteSessionCascade(localSessionId);
  await refresh();
}
