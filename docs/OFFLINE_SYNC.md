# Offline attendance

Many schools have no reliable Wi-Fi in classrooms. This module makes taking a
register with no connection a **first-class workflow** rather than an error
path: the teacher opens the class, captures, marks, reviews, and finalizes —
all locally — and the register syncs itself later.

Nothing here is labelled "limited", greyed out, or hidden behind a warning
banner, because the offline case is not the exception in the building this runs
in.

## The three things that must not be confused

The brief is explicit about this and the code keeps them apart:

| Concern | Where it lives | Depends on |
| --- | --- | --- |
| **Offline web workflow** | `lib/offline/*`, `components/offline/*`, `public/sw.js` | Nothing. Works on a device that has never had a network since login. |
| **Local AI availability** | `/api/local-ai/health`, `lib/offline/local-ai.ts` | An inference node on the institution's own network. Opt-in via `LOCAL_AI_ENABLED`. |
| **Server synchronization** | `modules/offline-sync/*`, `/api/sync/attendance` | Connectivity, later, whenever it happens. |

A teacher can complete a register with all three in different states. The
capture flow never waits on the AI probe, and never waits on the network.

## Architecture

```
PWA  (app shell cached by public/sw.js — no personal data, ever)
  ↓
Local application state   components/offline/* → lib/offline/store.ts
  ↓
IndexedDB                 lib/offline/db.ts     "attendance-offline"
  ↓
Offline attendance queue  lib/offline/queue.ts  operations + retry state
  ↓
Local processing where available   /api/local-ai/health → LAN inference node
  ↓
Internet returns          next/offline useOffline() + visibility + poll
  ↓
Secure synchronization    POST /api/sync/attendance (session cookie)
  ↓
Server database           modules/offline-sync/service.ts → the ordinary
                          attendance-capture / attendance-review services
```

### Storage: IndexedDB, not localStorage

Rosters — student names and roll numbers — and captured classroom photographs
live in IndexedDB. `localStorage` is used for none of it. It is synchronous,
string-only, size-capped at a few megabytes, and readable by any script on the
origin without so much as an `await`; a JPEG of a classroom of children
base64'd into it is the wrong answer three separate ways.

What is stored on the device:

- **Rosters**: `fullName`, `rollNumber`, `studentId`. The same information as a
  paper register.
- **Marks**, the queue, and a device id (`crypto.randomUUID()`).
- **Captured photographs**, as `Blob`s, for the teacher's own reference.

What is **never** stored on the device: face embeddings, face templates,
enrollment photographs, attendance history for any other session, or anything
belonging to a class the signed-in user cannot already take a register for. The
download is assembled server-side by `buildOfflineKit`, which runs the same
`requireCohortAccess` checks the online capture flow does.

`clearAllOfflineData()` wipes everything except the device id.

## Idempotency

> If the same operation syncs twice, the database must not create duplicate
> attendance.

Every operation carries `{ deviceId, operationId, attendanceSessionId }`. The
`operationId` is generated **once, at queue time**, and never regenerated —
generating it per *attempt* is the obvious-looking mistake that turns every
lost response into a duplicate register.

The guarantee rests on four layers, and deliberately not on the ledger alone:

1. **`startOrResumeCaptureSession`'s natural key.** One register per (cohort,
   day) for a school, per (cohort, subject, day) for a college. Replaying "open
   the class" resolves to the same row.
2. **`AttendanceRecord @@unique([sessionId, studentId])`.** Replaying a mark is
   an upsert, not an insert.
3. **`applyReviewDecision` is a no-op when the result already matches.** A
   replayed register therefore writes *no* `AttendanceCorrection` audit rows
   that the first pass did not write.
4. **The operation ledger**, in `AttendanceSession.metadata` under
   `SELECT … FOR UPDATE`. This is what lets the server *report* `DUPLICATE`
   instead of silently redoing harmless work, and what stops a genuinely
   non-idempotent replay — a correction toggling a value back and forth — from
   applying twice.

Layers 1–3 need no schema change and are already enforced by Postgres. Layer 4
is the reporting and toggle-safety layer. `service.test.ts` proves the claim by
replaying operations against an in-memory engine and comparing **state**, not
call counts: `replaying ten times is identical to applying once`, and
`a replay whose ledger write was lost still writes no duplicate attendance`.

### The upgrade when a migration is in scope

A `SyncedOperation(deviceId, operationId)` table with a unique constraint would
replace exactly two functions in `idempotency.ts` (`hasApplied`,
`withAppliedOperation`) and nothing else. It is not built here because this
phase forbade schema changes, and — importantly — it is an improvement to
*reporting*, not a fix for a correctness hole.

## The sync engine

`lib/offline/queue.ts` (client) and `modules/offline-sync/service.ts` (server).

| Requirement | How |
| --- | --- |
| Queued operations | `queue` object store, `byStatus` index |
| Retry | `claimDueItems` atomically flips `PENDING` → `SYNCING` |
| Exponential backoff | `backoffDelayMs` — base 1 s, ceiling 5 min, **full jitter** |
| Idempotency | `{deviceId, operationId, attendanceSessionId}`, above |
| Sync status | `PENDING / SYNCING / SYNCED / FAILED / CONFLICT` |
| Failure state | `FAILED` is *parked*, never deleted; has a Retry button |
| Conflict handling | Both answers returned; a human decides |
| Duplicate prevention | Four layers, above |

**Full jitter matters more than the exponent.** A school's thirty classroom
tablets lose Wi-Fi together and regain it together. A deterministic backoff has
all thirty retrying in lockstep at t+1s, t+2s, t+4s against a server that may
itself have just come back.

### Never silently lose attendance

This is structural rather than a rule someone has to remember:

- `failItem` parks an item; **no code path deletes an operation the server has
  not acknowledged.**
- `releaseStaleClaims()` runs at startup and rescues items stranded in
  `SYNCING` by a tab that closed mid-drain. Without it they are invisible
  forever, which is a lost register that merely looks tidy.
- The sync panel has **no "clear queue" control**. Discard exists only for a
  draft that was never finalized and never queued.
- `tx()` in `db.ts` resolves on transaction **commit**, not on the last
  request's `onsuccess` — a subtle difference that decides whether a mark
  survives the tab being closed a moment later.
- An unhandled server error returns **503, not 500**, so the queue treats it as
  retryable.
- A 401 leaves every item `PENDING`. An expired session must never look like a
  rejected register.

### Conflicts

When the device says PRESENT and the server already holds a human-made ABSENT,
neither "last write wins" nor "drop it" is acceptable: the first overwrites a
decision a person made, the second loses one. The server applies every
*non*-conflicting mark, returns the disagreements with both answers and the
student's name, and the teacher picks.

Two reasons are distinguished: `server_manually_corrected` and
`session_already_finalized`.

**A register with an unresolved conflict is never finalized.** Finalizing over
a disagreement would be the exact failure this system exists to prevent: an
undecided row becoming an official result by omission.

Choosing "keep this device's" queues a **new** correction with its own audit
row, rather than replaying the register — the teacher is making a fresh
decision now, and the record should say so.

## Local AI

`LOCAL_AI_ENABLED` is **opt-in and defaults to off.**

A cloud deployment and an on-premises deployment look identical from inside the
process. Auto-detecting "local AI" would mean claiming it on a cloud host,
which is the precise thing the brief forbids. So a human states it in the
environment, and the probe verifies it.

`AVAILABLE` means, exactly: *a reachable inference node on this network
answered `/v1/health` with a loaded model name.* It does not mean in-browser
face matching, and there is no bundled fake model. The probe is re-run each
time the capture screen opens — a node that answered in the staff room says
nothing about this classroom — and a previous `AVAILABLE` is never cached
forward.

Every other status says so plainly on the capture screen:

| Status | Shown when |
| --- | --- |
| `UNCONFIGURED` | `LOCAL_AI_ENABLED` is not set. The honest default. |
| `CHECKING` | The probe is in flight. |
| `AVAILABLE` | A live answer **with** a `model_name`. |
| `UNAVAILABLE` | `timeout`, `unreachable`, `http_N`, or `no_model`. |

The probe goes through a Route Handler rather than straight from the browser,
because `FACE_AI_SERVICE_URL` is server-side and the FastAPI service has no
CORS middleware — and because a server-to-server probe tests exactly the path
recognition itself would take.

When local AI is unavailable, the workflow is unchanged: the teacher marks the
roster by hand, which is what `markSource: "MANUAL"` records. `markSource` is
only ever `LOCAL_AI_ASSISTED` when a node actually proposed the marks, never
because one was merely reachable.

### Photographs are not uploaded by the sync engine

Captured images stay in IndexedDB as the teacher's own record. Shipping
classroom photographs of children to a server hours later, from a device that
has since left the building, is not a thing to do quietly as a side effect of a
sync. `captureImageCount` is synced; the bytes are not.

## The service worker

`public/sw.js` is an **app-shell** worker. Next's `useOffline()` retries failed
navigations, prefetches, RSC requests and Server Actions, and it catches the
failure mode `navigator.onLine` misses — an access point that is associated and
has no upstream. What it explicitly does not cover is a **full page reload with
no network**, which needs a worker.

So: `/offline` is a static, data-free route, precached along with its
`/_next/static/` chunks, and served as the navigation fallback. From there the
teacher reaches the same workbench, the same rosters in IndexedDB, and the same
queue.

The pre-existing rule is preserved exactly: **no personal data in Cache
Storage.** A cache entry outlives the session cookie and is not cleared by
logging out, and these are shared devices. Therefore:

- `/api/*` is never intercepted.
- Authenticated HTML and RSC payloads are never stored — `networkThenOfflineShell`
  returns the network response without caching it.
- Only `/_next/static/`, `/icons/`, the manifest, and `/offline` are cached.

Registered in production only: a worker in `next dev` fights the dev server's
hot replacement and produces stale-chunk errors that look like application
bugs.

## Sync status UI

The five states from the brief, decided in one pure function
(`modules/offline-sync/status.ts`) rather than in a JSX ternary, because the
interesting question is which one wins when several are true at once.

Severity order, most severe first:

```
CONFLICT > FAILED > OFFLINE > SYNCING > PENDING > SYNCED
```

`CONFLICT` and `FAILED` outrank `OFFLINE` deliberately. Being offline is
expected and resolves itself when the teacher walks past the office; a conflict
and a permanent failure need a person, and they stay unresolved for as long as
the badge hides them behind a cloud icon everyone has learned to ignore.

`SYNCED` is the only state that may not be inferred — it requires the queue to
be genuinely empty. There is no "probably fine".

Wording rules, enforced by `status.test.ts`:

- **Say the number.** "2 pending" is actionable; "Pending sync" is a mood.
- **Never say "Synced"** unless the queue is empty.
- **Never imply data loss where there is none.** A failed sync is attendance
  *saved on this device and not yet on the server* — a teacher who reads "Sync
  failed" and assumes the register is gone will re-take it, and then there are
  two.

## Where offline is deliberately stricter than online

**Finalize refuses while any student is unmarked.** Online, the register is
seeded from recognition and the review board resolves what is left. Offline
there is no seed, so an unmarked row means nobody looked at that student. The
server would refuse such a register anyway, and queueing something the server
will refuse is a silent loss wearing a sync badge — so the check happens on the
device, in front of the person who can fix it, while they are still in the
room.

There is no "mark everyone present" button, for the same reason there is not
one online.

The roster is seeded through `generateAttendanceCandidates(actor, { sessionId,
recognition: null })` — the manual roll call the review module already models.
Every student starts `NEEDS_REVIEW`. "We never looked" never becomes "present".

## Authorization

Synced operations run through the **same services** the online workflow uses:
`startOrResumeCaptureSession`, `generateAttendanceCandidates`,
`applyReviewDecision`, `confirmAttendance`. There is no sync bypass.

An offline device cannot assert an institution: the tenant comes from the
session cookie on the request carrying the batch, never from the payload. A
correction to an already-finalized register additionally requires
`attendanceSession.finalize` (what the review module calls an admin override).

The batch endpoint requires `attendanceSession.capture` **and**
`attendanceRecord.correct` — an offline register is, mechanically, a sequence
of review decisions.

## Testing it by hand

The brief's own test:

1. `npm run build --workspace=web && npm run start --workspace=web`. Dev mode is
   not a reference — Next's own offline guide says so, and the service worker
   is production-gated.
2. Sign in, open **Offline attendance**, press **Download for offline**.
3. DevTools → Network → **Offline**.
4. Reload the page. The app-shell worker serves `/offline`; the downloaded
   classes are still listed.
5. Open a class, capture, mark every student, finalize. The badge reads
   `Offline · 1 queued`.
6. DevTools → Application → IndexedDB → `attendance-offline` → `queue`. One
   record, status `PENDING`, with an `operationId`.
7. Network → **No throttling**. Within ~20 s (or on tab focus) the badge goes
   `Syncing…` → `Synced`.
8. Check the register on `/dashboard/attendance/[cohortId]/history`.
9. **Repeat the sync.** In the console, re-run a drain, or edit the queue
   record's `status` back to `PENDING` in DevTools and let it drain again. The
   response outcome is `DUPLICATE`; the register is unchanged; there is no
   second `AttendanceSession` and no second `AttendanceCorrection`.

> **Status in this repository:** this walkthrough has **not** been executed. The
> development database has no tables and no pgvector extension, so the app
> cannot reach a working attendance engine locally, and the Chrome DevTools MCP
> cannot attach to a browser whose profile is held by a running Chrome. The
> server-side half is covered instead by `modules/offline-sync/*.test.ts` — 51
> tests, including the replay and duplicate-prevention claims — which run
> against an in-memory stand-in for the attendance engine. See the README's
> verification section.

## Files

| File | Role |
| --- | --- |
| `modules/offline-sync/types.ts` | The whole contract |
| `modules/offline-sync/idempotency.ts` | Ledger + backoff. Pure, no Prisma, no clock, no `Math.random` |
| `modules/offline-sync/status.ts` | Which indicator wins, and what it says. Pure |
| `modules/offline-sync/repository.ts` | Session/metadata reads, `FOR UPDATE` lock |
| `modules/offline-sync/service.ts` | `applySyncBatch` — the server engine |
| `modules/offline-sync/offline-kit.ts` | What a device is allowed to download |
| `lib/offline/db.ts` | IndexedDB, hand-written, no dependency |
| `lib/offline/queue.ts` | Enqueue, drain, retry, conflict resolution |
| `lib/offline/store.ts` | One external store; `useSyncExternalStore` source |
| `lib/offline/local-ai.ts` | The probe, and the sentence it produces |
| `app/api/sync/attendance/route.ts` | The batch endpoint |
| `app/api/local-ai/health/route.ts` | Server-to-server local-AI probe |
| `app/dashboard/offline/page.tsx` | The workbench, with the kit |
| `app/offline/page.tsx` | Static shell for a reload with no network |
| `public/sw.js` | App-shell worker |
