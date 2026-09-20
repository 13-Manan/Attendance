"use client";

import type {
  OfflineMark,
  OfflineMarkSource,
  SyncConflict,
  SyncStatus,
} from "@/modules/offline-sync/types";

/**
 * The durable store behind offline attendance.
 *
 * ## Why IndexedDB, and not localStorage
 *
 * Not a style preference — localStorage is disqualified three times over for
 * what this holds:
 *
 * 1. **It is synchronous.** Every read and write blocks the main thread. A
 *    register of 400 students serialized on the UI thread janks the tap the
 *    teacher just made.
 * 2. **It only stores strings.** Classroom photos are `Blob`s. Base64-ing them
 *    into a string store inflates them by a third and puts megabytes of image
 *    data through `JSON.stringify`.
 * 3. **It is a flat, unindexed, ~5 MB bag.** There is no way to ask it for
 *    "queue items that are due" without deserializing everything, and no way
 *    to atomically move an item from PENDING to SYNCING. A crash mid-write
 *    leaves a half-written register with no transaction to roll it back.
 *
 * The brief's rule — *do not store sensitive data carelessly in localStorage* —
 * is about the third point most of all. An attendance register is somebody's
 * record. Storage that cannot write atomically can lose it, and this module's
 * central promise is that nothing is lost.
 *
 * ## What is deliberately *not* stored here
 *
 * - **No face templates, embeddings, or biometric vectors.** Those never leave
 *   the server, offline or not (see ARCHITECTURE.md). A device that could
 *   match faces locally would be a device carrying every student's biometric
 *   data through a school corridor.
 * - **No session cookie, token, or credential.** Authentication stays in the
 *   `HttpOnly` cookie the server set. `deviceId` is an audit label, not a key:
 *   a stolen one grants nothing.
 * - **No roster beyond the class being taken**, and only names and roll
 *   numbers — what a paper register would show.
 *
 * ## Why hand-written and not a wrapper library
 *
 * The IndexedDB surface this needs is four object stores, two indexes, and
 * one versioned upgrade. A promise wrapper is about sixty lines of that, and
 * it is the part that has to be exactly right when a teacher's tab is closed
 * mid-transaction. A dependency would be more code, not less, and one more
 * thing to audit for what it writes where.
 */

const DB_NAME = "attendance-offline";
const DB_VERSION = 1;

export const STORE_SESSIONS = "sessions";
export const STORE_IMAGES = "images";
export const STORE_QUEUE = "queue";
export const STORE_CLASSES = "classes";
export const STORE_META = "meta";

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

/** A register as it exists on the device, before and after it has been sent. */
export interface LocalSession {
  /** Device-local id. Not a server id — the server may not know this yet. */
  id: string;
  cohortId: string;
  cohortName: string;
  cohortSubjectId: string | null;
  subjectName: string | null;
  /** ISO date-time of the class, from the device clock. */
  sessionDate: string;
  /** Roster snapshot taken while online, so the class can be opened offline. */
  students: LocalRosterStudent[];
  marks: Record<string, OfflineMark>;
  markSource: OfflineMarkSource;
  /** Set when the teacher pressed Finalize on the device. */
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Mirrors the queue item's status, for listing without a join. */
  syncStatus: SyncStatus | "DRAFT";
  /** Populated from the server's response when a sync conflicts. */
  conflicts: SyncConflict[];
  /** Server id, once the server has told us one. */
  serverSessionId: string | null;
}

export interface LocalRosterStudent {
  studentId: string;
  fullName: string;
  rollNumber: string | null;
}

/**
 * A captured classroom photo, held as a `Blob`.
 *
 * Kept separate from the session record on purpose. Images are large and
 * read rarely; the queue and the review screen read sessions constantly, and
 * an object store row carrying five megapixels of JPEG would be deserialized
 * on every one of those reads.
 *
 * These are **not** uploaded by the sync engine in this phase — see
 * `docs/OFFLINE_SYNC.md`. They stay on the device as the teacher's own
 * evidence and are deleted with the session.
 */
export interface LocalImage {
  id: string;
  localSessionId: string;
  sequenceNumber: number;
  blob: Blob;
  capturedAt: string;
}

export interface QueueRecord {
  /** The operation id. Also the idempotency key sent to the server. */
  id: string;
  kind: "attendance.session" | "attendance.correction";
  localSessionId: string | null;
  /** The exact JSON body that will be sent, frozen at queue time. */
  payload: unknown;
  attendanceSessionId: string | null;
  status: SyncStatus;
  attemptCount: number;
  createdAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** False once the server says a retry can never succeed. */
  retryable: boolean;
  conflicts: SyncConflict[];
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

export function isOfflineStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!isOfflineStorageAvailable()) {
      reject(new Error("indexeddb_unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        sessions.createIndex("bySyncStatus", "syncStatus", { unique: false });
        sessions.createIndex("byCohort", "cohortId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const images = db.createObjectStore(STORE_IMAGES, { keyPath: "id" });
        images.createIndex("bySession", "localSessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const queue = db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
        queue.createIndex("byStatus", "status", { unique: false });
        queue.createIndex("bySession", "localSessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CLASSES)) {
        db.createObjectStore(STORE_CLASSES, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the schema, this connection must step aside
      // rather than hold the old version open and block it forever.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
    // Private-browsing Firefox and a few locked-down enterprise profiles
    // block IndexedDB outright. Rejecting is the honest outcome — the UI
    // says offline capture is unavailable rather than pretending to save.
    request.onblocked = () => reject(new Error("indexeddb_blocked"));
  });
  return dbPromise;
}

/**
 * Runs `work` inside one transaction and resolves when the transaction
 * *commits*, not when the last request succeeds.
 *
 * That distinction is the reason this helper exists. Awaiting individual
 * `IDBRequest`s and then returning looks correct and is not: the transaction
 * can still abort afterwards, and the caller will have already reported
 * success. A register reported as saved that was not saved is precisely the
 * silent loss this module exists to prevent.
 */
async function tx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result: T;
    let failed = false;

    transaction.oncomplete = () => {
      if (!failed) resolve(result);
    };
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction_aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("transaction_failed"));

    Promise.resolve(work(transaction))
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        failed = true;
        try {
          transaction.abort();
        } catch {
          // Already finished; the abort/error handler has the real reason.
        }
        reject(error);
      });
  });
}

/** Promisifies one IDBRequest. Only ever awaited inside `tx`. */
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("request_failed"));
  });
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = "deviceId";

/**
 * A stable, random id for this browser profile.
 *
 * Part of the idempotency key, and the audit trail's answer to "which tablet
 * sent this". Not an identifier of a person: it survives a logout and says
 * nothing about who was signed in, which is why it is safe to keep and why it
 * is never used for authorization.
 */
export async function getDeviceId(): Promise<string> {
  const existing = await tx([STORE_META], "readonly", (t) =>
    req<{ key: string; value: string } | undefined>(
      t.objectStore(STORE_META).get(DEVICE_ID_KEY),
    ),
  );
  if (existing?.value) return existing.value;

  const value = crypto.randomUUID();
  await tx([STORE_META], "readwrite", (t) =>
    req(t.objectStore(STORE_META).put({ key: DEVICE_ID_KEY, value })),
  );
  return value;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function putSession(session: LocalSession): Promise<void> {
  await tx([STORE_SESSIONS], "readwrite", (t) =>
    req(t.objectStore(STORE_SESSIONS).put(session)),
  );
}

export async function getSession(id: string): Promise<LocalSession | undefined> {
  return tx([STORE_SESSIONS], "readonly", (t) =>
    req<LocalSession | undefined>(t.objectStore(STORE_SESSIONS).get(id)),
  );
}

export async function listSessions(): Promise<LocalSession[]> {
  const rows = await tx([STORE_SESSIONS], "readonly", (t) =>
    req<LocalSession[]>(t.objectStore(STORE_SESSIONS).getAll()),
  );
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Read-modify-write inside one transaction.
 *
 * Two marks tapped in quick succession are two concurrent calls. Read outside
 * a transaction and the second would overwrite the first with a stale copy —
 * a student silently losing their mark, which is the bug class this whole
 * phase is about.
 */
export async function updateSession(
  id: string,
  mutate: (session: LocalSession) => LocalSession,
): Promise<LocalSession | null> {
  return tx([STORE_SESSIONS], "readwrite", async (t) => {
    const store = t.objectStore(STORE_SESSIONS);
    const current = await req<LocalSession | undefined>(store.get(id));
    if (!current) return null;
    const next = mutate(current);
    await req(store.put(next));
    return next;
  });
}

/**
 * Deletes a register and everything attached to it.
 *
 * Only ever called for a session whose queue item reached `SYNCED` — the
 * server has it. There is no code path that deletes an unsynced register, and
 * there must not be one.
 */
export async function deleteSessionCascade(id: string): Promise<void> {
  await tx([STORE_SESSIONS, STORE_IMAGES, STORE_QUEUE], "readwrite", async (t) => {
    await req(t.objectStore(STORE_SESSIONS).delete(id));
    await deleteByIndex(t.objectStore(STORE_IMAGES), "bySession", id);
    await deleteByIndex(t.objectStore(STORE_QUEUE), "bySession", id);
  });
}

function deleteByIndex(store: IDBObjectStore, indexName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = store.index(indexName).openCursor(IDBKeyRange.only(key));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("cursor_failed"));
  });
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export async function putImage(image: LocalImage): Promise<void> {
  await tx([STORE_IMAGES], "readwrite", (t) => req(t.objectStore(STORE_IMAGES).put(image)));
}

export async function listImages(localSessionId: string): Promise<LocalImage[]> {
  const rows = await tx([STORE_IMAGES], "readonly", (t) =>
    req<LocalImage[]>(
      t.objectStore(STORE_IMAGES).index("bySession").getAll(IDBKeyRange.only(localSessionId)),
    ),
  );
  return rows.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export async function countImages(localSessionId: string): Promise<number> {
  return tx([STORE_IMAGES], "readonly", (t) =>
    req<number>(
      t.objectStore(STORE_IMAGES).index("bySession").count(IDBKeyRange.only(localSessionId)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Downloaded classes
// ---------------------------------------------------------------------------

/**
 * The rosters a teacher downloaded so they could open a class with no network.
 *
 * In IndexedDB, and not in `localStorage` or `sessionStorage`, for two separate
 * reasons that both matter:
 *
 * - **It has to survive the tab.** A teacher downloads in the staff room,
 *   closes the app, walks to a classroom with no signal, and opens it again.
 *   `sessionStorage` is gone by then, which would make the whole feature work
 *   only for people who never close a tab.
 * - **It is student data.** Names and roll numbers — no more than a paper
 *   register, but not something to leave in a synchronous, unindexed,
 *   never-expiring string bag. It is cleared on sign-out with everything else.
 */
export async function putCachedClasses<T extends { key: string }>(classes: T[]): Promise<void> {
  await tx([STORE_CLASSES], "readwrite", async (t) => {
    const store = t.objectStore(STORE_CLASSES);
    // Replace wholesale: a class the teacher no longer teaches must disappear
    // from the offline list, not linger because a merge kept it.
    await req(store.clear());
    for (const item of classes) await req(store.put(item));
  });
}

export async function getCachedClasses<T>(): Promise<T[]> {
  return tx([STORE_CLASSES], "readonly", (t) => req<T[]>(t.objectStore(STORE_CLASSES).getAll()));
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export async function enqueue(record: QueueRecord): Promise<void> {
  await tx([STORE_QUEUE], "readwrite", (t) => req(t.objectStore(STORE_QUEUE).put(record)));
}

export async function listQueue(): Promise<QueueRecord[]> {
  const rows = await tx([STORE_QUEUE], "readonly", (t) =>
    req<QueueRecord[]>(t.objectStore(STORE_QUEUE).getAll()),
  );
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getQueueItem(id: string): Promise<QueueRecord | undefined> {
  return tx([STORE_QUEUE], "readonly", (t) =>
    req<QueueRecord | undefined>(t.objectStore(STORE_QUEUE).get(id)),
  );
}

export async function updateQueueItem(
  id: string,
  mutate: (item: QueueRecord) => QueueRecord,
): Promise<QueueRecord | null> {
  return tx([STORE_QUEUE], "readwrite", async (t) => {
    const store = t.objectStore(STORE_QUEUE);
    const current = await req<QueueRecord | undefined>(store.get(id));
    if (!current) return null;
    const next = mutate(current);
    await req(store.put(next));
    return next;
  });
}

/**
 * Atomically claims up to `limit` due items, flipping them PENDING → SYNCING.
 *
 * Atomic because two drains can overlap — a timer firing while an `online`
 * event also triggers one — and both must not send the same operation. Even
 * if they did the server would answer `DUPLICATE` and no attendance would be
 * doubled; the claim is here so the *device's* attempt counters and backoff
 * stay meaningful, and so a drain does not waste a school's bandwidth sending
 * the same register twice.
 */
export async function claimDueItems(
  now: Date,
  limit: number,
  isDue: (item: QueueRecord, now: Date) => boolean,
): Promise<QueueRecord[]> {
  return tx([STORE_QUEUE], "readwrite", async (t) => {
    const store = t.objectStore(STORE_QUEUE);
    const all = await req<QueueRecord[]>(store.getAll());
    const due = all
      .filter((item) => isDue(item, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);

    const claimed: QueueRecord[] = [];
    for (const item of due) {
      const next: QueueRecord = {
        ...item,
        status: "SYNCING",
        lastAttemptAt: now.toISOString(),
        attemptCount: item.attemptCount + 1,
      };
      await req(store.put(next));
      claimed.push(next);
    }
    return claimed;
  });
}

/**
 * Releases items stuck in SYNCING back to PENDING.
 *
 * A tab closed mid-drain leaves its claims held forever otherwise: the item
 * is not PENDING so no drain picks it up, and it is not terminal so nothing
 * reports it. Called once at startup. "Never silently lose attendance" has to
 * include the case where the loss is a row nobody looks at again.
 */
export async function releaseStaleClaims(): Promise<number> {
  return tx([STORE_QUEUE], "readwrite", async (t) => {
    const store = t.objectStore(STORE_QUEUE);
    const stuck = await req<QueueRecord[]>(
      store.index("byStatus").getAll(IDBKeyRange.only("SYNCING")),
    );
    for (const item of stuck) {
      await req(store.put({ ...item, status: "PENDING" as SyncStatus }));
    }
    return stuck.length;
  });
}

export async function deleteQueueItem(id: string): Promise<void> {
  await tx([STORE_QUEUE], "readwrite", (t) => req(t.objectStore(STORE_QUEUE).delete(id)));
}

const OWNER_KEY = "ownerUserId";

/**
 * Which signed-in account this device's offline data belongs to.
 *
 * Distinct from `deviceId` in the way that matters: `deviceId` says *which
 * tablet*, this says *whose work is on it*. A classroom tablet is handed
 * between teachers, and until this existed the second teacher to sign in
 * inherited the first one's downloaded roster and their unsynced register —
 * measured, not theorised: Section A's roster and an eight-mark draft were
 * both visible to a teacher who taught neither.
 *
 * Null means no owner has been recorded yet, which is either a fresh device
 * or data queued by a build that predates this field.
 */
export async function getOfflineOwner(): Promise<string | null> {
  const row = await tx([STORE_META], "readonly", (t) =>
    req<{ key: string; value: string } | undefined>(t.objectStore(STORE_META).get(OWNER_KEY)),
  );
  return row?.value ?? null;
}

export async function setOfflineOwner(userId: string): Promise<void> {
  await tx([STORE_META], "readwrite", (t) =>
    req(t.objectStore(STORE_META).put({ key: OWNER_KEY, value: userId })),
  );
}

export async function clearOfflineOwner(): Promise<void> {
  await tx([STORE_META], "readwrite", (t) => req(t.objectStore(STORE_META).delete(OWNER_KEY)));
}

/**
 * Work on this device that the server has not accepted yet.
 *
 * The number a sign-out has to respect. "Never silently lose attendance"
 * means the answer to "can I wipe this device?" is a count, not a guess.
 */
export async function countUnsyncedWork(): Promise<number> {
  const [queue, sessions] = await Promise.all([listQueue(), listSessions()]);
  const unsyncedQueue = queue.filter((item) => item.status !== "SYNCED").length;
  const drafts = sessions.filter((session) => session.syncStatus === "DRAFT").length;
  return unsyncedQueue + drafts;
}

/**
 * Wipes every offline store.
 *
 * For sign-out on a shared classroom tablet: the next teacher must not find
 * the previous one's registers. Called only after the queue is empty of
 * unsynced work — the sign-out flow warns and refuses rather than discarding
 * attendance that never reached the server.
 */
export async function clearAllOfflineData(): Promise<void> {
  await tx(
    [STORE_SESSIONS, STORE_IMAGES, STORE_QUEUE, STORE_CLASSES],
    "readwrite",
    async (t) => {
      await req(t.objectStore(STORE_SESSIONS).clear());
      await req(t.objectStore(STORE_IMAGES).clear());
      await req(t.objectStore(STORE_QUEUE).clear());
      await req(t.objectStore(STORE_CLASSES).clear());
      // STORE_META is deliberately kept: deviceId is not personal data, and
      // regenerating it on every sign-out would break the audit trail's
      // ability to say "this tablet".
    },
  );
}

/**
 * Asks the browser not to evict this origin's storage under pressure.
 *
 * Best-effort and non-blocking — Chrome grants it silently for installed PWAs,
 * Firefox prompts, Safari ignores it. Worth asking: eviction of an unsynced
 * register is exactly the silent loss this module forbids, and the request
 * costs nothing when it is denied.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
