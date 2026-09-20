"use client";

import type { OfflineKitClass } from "@/modules/offline-sync/offline-kit";
import {
  clearAllOfflineData,
  clearOfflineOwner,
  countUnsyncedWork,
  deleteSessionCascade,
  getCachedClasses,
  getDeviceId,
  getOfflineOwner,
  setOfflineOwner,
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
  /**
   * Set when this device holds another account's offline work.
   *
   * Everything stays on disk — it is somebody's attendance and discarding it
   * silently is the one thing this module must never do — but it is hidden
   * from the current user and never sent under their session. They see a
   * short explanation instead of a roster they should not have.
   */
  foreignOwner: boolean;
  /** How much unsynced work is on this device, for the sign-out warning. */
  unsyncedCount: number;
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
  foreignOwner: false,
  unsyncedCount: 0,
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

/**
 * Work on this device the server has not accepted.
 *
 * One definition, used by the sign-out warning, the hand-over button and the
 * guard inside `takeOverDevice`. They have to agree: a screen that says
 * "nothing is waiting" beside a button that silently refuses to act is worse
 * than either alone.
 */
function unsyncedWorkIn(queue: QueueRecord[], sessions: LocalSession[]): number {
  return (
    queue.filter((item) => item.status !== "SYNCED").length +
    sessions.filter((session) => session.syncStatus === "DRAFT").length
  );
}

export async function refresh(): Promise<void> {
  try {
    const [snapshot, queue, sessions, cached, deviceId] = await Promise.all([
      snapshotQueue(),
      listQueue(),
      listSessions(),
      getCachedClasses<OfflineKitClass>(),
      getDeviceId(),
    ]);
    if (state.foreignOwner) {
      // Another account's work is on this device. Counted so the UI can say
      // how much is waiting, but never listed and never drained.
      set({
        ready: true,
        storageAvailable: true,
        snapshot: EMPTY_SNAPSHOT,
        queue: [],
        sessions: [],
        cachedClasses: null,
        deviceId,
        // Drafts count, not just queued items. A register marked but never
        // finalized exists only here, so it is the *most* fragile thing on the
        // device — and this number is what decides whether the hand-over
        // button appears. Counting only the queue would offer to wipe it.
        unsyncedCount: unsyncedWorkIn(queue, sessions),
      });
      return;
    }
    set({
      ready: true,
      storageAvailable: true,
      snapshot,
      queue,
      sessions,
      cachedClasses: cached.length > 0 ? cached : null,
      deviceId,
      unsyncedCount: unsyncedWorkIn(queue, sessions),
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
export async function start(currentUserId?: string | null): Promise<void> {
  if (started) return;
  started = true;
  if (!isOfflineStorageAvailable()) {
    set({ ready: true, storageAvailable: false });
    return;
  }
  try {
    if (currentUserId) await claimOwnership(currentUserId);
    await recoverQueue();
    void requestPersistentStorage();
  } catch {
    set({ ready: true, storageAvailable: false });
    return;
  }
  await refresh();
}

/**
 * Decides whether this device's offline data belongs to the person using it.
 *
 * Three cases, and the middle one is the reason this exists:
 *
 * - **No owner recorded.** A fresh device, or data queued before ownership was
 *   tracked. Claim it for the current user. Adopting rather than discarding
 *   keeps an upgrade from stranding a register that was already waiting.
 * - **A different owner.** Hide everything and drain nothing. The data stays
 *   on disk so its owner can sign back in and send it; the current user is
 *   told only that some other account's work is here, not whose or what.
 * - **The same owner.** Normal operation.
 *
 * Only called where the signed-in user is actually known — a server-rendered
 * page. The static offline shell cannot know, and does not guess; the queue's
 * own owner stamp is what protects a drain from there, because sending
 * requires a network and the server refuses a mismatch.
 */
async function claimOwnership(currentUserId: string): Promise<void> {
  const owner = await getOfflineOwner();
  if (owner !== null) {
    set({ foreignOwner: owner !== currentUserId });
    return;
  }

  // No owner recorded: either a device that has never been used, or one
  // holding data from a build that predates ownership tracking.
  //
  // An empty device is claimed silently — there is nothing to mis-attribute.
  // A device that already holds registers is *not*, because nothing here can
  // say whose they are, and the person signing in now is as likely to be the
  // second teacher as the first. Claiming it for them is precisely the bug
  // this guard exists to close, so it is quarantined instead and they are
  // offered an explicit choice.
  const [sessions, queue] = await Promise.all([listSessions(), listQueue()]);
  if (sessions.length === 0 && queue.length === 0) {
    await setOfflineOwner(currentUserId);
    set({ foreignOwner: false });
    return;
  }
  set({ foreignOwner: true });
}

/**
 * Claims a device whose previous registers have all reached the server.
 *
 * The explicit way out of `foreignOwner`, and deliberately not offered while
 * anything is unsynced: what is discarded here is a stale roster and copies
 * of registers the server already holds, never attendance that exists only on
 * this device.
 */

export async function takeOverDevice(currentUserId: string): Promise<void> {
  if ((await countUnsyncedWork()) > 0) return;
  await clearAllOfflineData();
  await setOfflineOwner(currentUserId);
  set({ foreignOwner: false });
  await refresh();
}

/**
 * Sign-out cleanup.
 *
 * Clears the roster, the registers and the captured photos so the next
 * teacher on a shared tablet finds nothing of the last one's — but only when
 * the server already has everything. With work still queued it keeps the
 * data and reports the count, and the sign-out UI warns instead of wiping.
 * Returns what it did, so the caller can say so.
 */
export async function clearForSignOut(): Promise<{ cleared: boolean; unsynced: number }> {
  if (!isOfflineStorageAvailable()) return { cleared: false, unsynced: 0 };
  try {
    const unsynced = await countUnsyncedWork();
    if (unsynced > 0) return { cleared: false, unsynced };
    await clearAllOfflineData();
    await clearOfflineOwner();
    set({
      snapshot: EMPTY_SNAPSHOT,
      queue: [],
      sessions: [],
      cachedClasses: null,
      foreignOwner: false,
      unsyncedCount: 0,
    });
    return { cleared: true, unsynced: 0 };
  } catch {
    return { cleared: false, unsynced: 0 };
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncNow(): Promise<void> {
  if (state.draining || !state.storageAvailable) return;
  // Belt and braces with the server's own refusal: a device holding another
  // account's work does not even attempt a drain, so their register is not
  // repeatedly rejected under a session that can never accept it.
  if (state.foreignOwner) return;
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
